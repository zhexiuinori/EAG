// ---------------------------------------------------------------------------
// EAG — 子 Agent 委派（Delegation）执行器
//
// Agent 之间分包协作：主 Agent 通过 MCP 内置工具 agents__delegate 把子任务
// 交给另一个 Worker 执行。通道选择 **文件队列**：
//   · MCP 代理是独立进程，Electron 模式下没有 HTTP 服务可用；
//   · 审计早已是"同机同项目根的文件通道"，委派沿用同一约束 —— 双模式零差异。
//
//   Agent 引擎 ──工具调用──▶ Proxy ──写 <root>/.eag/delegations/<id>.req.json──▶ 本服务
//                                  ◀──读 <root>/.eag/delegations/<id>.res.json──
//
// 治理（任一不满足即拒绝并写 res，绝不静默执行）：
//   1. 目标必须对发起者可见（三级可见性：直接分配 / 组 / 全员）
//   2. 禁止自委派
//   3. 深度限制：正以"被委派"身份运行的 Agent 不能再向外委派（防链式递归）
//   4. 计划模式（只读）会话不得委派 —— 否则子 Agent 会绕过只读约束
//   5. 目标忙碌 / 发起方已有在飞委派 / 排队过久（>10min，视作放弃）→ 拒绝
// 执行本身走 sendToWorker：预算封顶、审计、记忆、知识库全部复用，无旁路。
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import { DELEGATIONS_DIR } from "../paths.ts";
import * as workerService from "./worker-service.ts";
import * as auditApi from "./audit-api.ts";
import * as configApi from "./config-api.ts";
import type {
  DelegationRequest, DelegationResult, DelegationRecord, Worker,
} from "../../shared/types.ts";

/** 轮询间隔：代理侧 500ms 拉一次结果，这里 1.2s 扫一次队列，响应足够快。 */
const POLL_MS = 1200;
/** 同时执行的委派上限（其余排队，防止资源被委派洪泛打满）。 */
const MAX_CONCURRENT = 3;
/** 请求排队超过该时长视为已被放弃（代理早已超时离开）。 */
const STALE_MS = 10 * 60 * 1000;
/**
 * 单次委派的看门狗上限。
 *
 * 引擎 adapter 自身有 5 分钟超时，但在 Windows 上它可能根本回不来：
 * 引擎经 shell 拉起，超时只杀掉 cmd 包装进程 → 孤儿引擎继续持有 stdout 管道 →
 * adapter 的读取循环永不结束 → 委派永久挂住（本机实测踩到）。
 * 看门狗保证委派**一定有终局**：到点主动中止 + 把失败写回，父 Agent 不会被卡死。
 * 可用 EAG_DELEGATION_TIMEOUT_MS 覆盖。
 */
const DELEGATION_TIMEOUT_MS = Math.max(5_000, Number(process.env.EAG_DELEGATION_TIMEOUT_MS) || 360_000);
/** 结果保留时长（代理读走后无用途，留一段时间便于排查）。 */
const RETENTION_MS = 24 * 60 * 60 * 1000;
/** 回传给父 Agent 的输出上限（防止子 Agent 的长文灌爆父会话上下文）。 */
const MAX_OUTPUT = 6000;

let timer: NodeJS.Timeout | undefined;
/** 正在执行的委派 id（去重，防同一请求被重复拾取）。 */
const processing = new Set<string>();
/** 正在以"被委派"身份运行的 Worker（深度限制依据）。 */
const delegatedRunning = new Set<string>();
/** 已有在飞委派的发起方（同一 Agent 同时只允许一个委派，防扇出爆炸）。 */
const inFlightFrom = new Set<string>();

const reqPath = (id: string) => path.join(DELEGATIONS_DIR, `${id}.req.json`);
const resPath = (id: string) => path.join(DELEGATIONS_DIR, `${id}.res.json`);
const ackPath = (id: string) => path.join(DELEGATIONS_DIR, `${id}.ack.json`);

function writeJson(file: string, obj: unknown): void {
  try {
    fs.mkdirSync(DELEGATIONS_DIR, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf-8");
    fs.renameSync(tmp, file); // 原子替换：代理永远不会读到半截 JSON
  } catch (e) {
    console.error("[Delegation] 写文件失败:", file, e);
  }
}

function truncate(text: string | undefined): string | undefined {
  if (!text) return text;
  return text.length > MAX_OUTPUT
    ? `${text.slice(0, MAX_OUTPUT)}\n…（已截断，完整输出见审计与目标 Agent 的会话）`
    : text;
}

/** 扫描待执行请求：有 .req.json 且无 .res.json。坏文件就地清理。 */
function listPending(): DelegationRequest[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(DELEGATIONS_DIR);
  } catch {
    return [];
  }
  const out: DelegationRequest[] = [];
  for (const n of names) {
    if (!n.endsWith(".req.json")) continue;
    const id = n.slice(0, -".req.json".length);
    if (fs.existsSync(resPath(id))) continue;
    try {
      const req = JSON.parse(fs.readFileSync(path.join(DELEGATIONS_DIR, n), "utf-8")) as DelegationRequest;
      if (req?.id && req?.target) out.push(req);
      else fs.rmSync(path.join(DELEGATIONS_DIR, n), { force: true });
    } catch {
      fs.rmSync(path.join(DELEGATIONS_DIR, n), { force: true });
    }
  }
  return out;
}

/** 清理过期文件，避免目录无限膨胀。 */
function cleanup(): void {
  let names: string[] = [];
  try {
    names = fs.readdirSync(DELEGATIONS_DIR);
  } catch {
    return;
  }
  const now = Date.now();
  for (const n of names) {
    const p = path.join(DELEGATIONS_DIR, n);
    try {
      if (now - fs.statSync(p).mtimeMs > RETENTION_MS) fs.rmSync(p, { force: true });
    } catch {
      // ignore
    }
  }
}

function finish(req: DelegationRequest, patch: Partial<DelegationResult> & { ok: boolean }): void {
  writeJson(resPath(req.id), {
    id: req.id,
    finishedAt: new Date().toISOString(),
    ...patch,
  } satisfies DelegationResult);
}

/** 拒绝：把原因写进 res，代理会原样转达给父 Agent（含可用目标清单，便于纠错重试）。 */
function reject(req: DelegationRequest, error: string, visible?: Worker[]): void {
  const list = visible && visible.length > 0
    ? `\n当前可委派的 Agent：${visible.map((w) => `${w.name}（${w.id}）`).join("、")}`
    : "";
  finish(req, { ok: false, error: error + list });
}

/** 配置的委派链最大深度（默认 2；钳制 1..8，防止配置成无限递归）。 */
function maxDepth(): number {
  const n = Math.floor(Number(configApi.getConfig().maxDelegationDepth));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 8) : 2;
}

/**
 * 发起方会话所处深度：
 *   1) 优先用请求里带的 depth（代理从会话 env 读出，准确）
 *   2) 缺省时用 EAG 侧的在跑集合兜底推断（旧代理 / 手工写入的请求）
 */
function resolveDepth(req: DelegationRequest): number {
  if (typeof req.depth === "number" && Number.isFinite(req.depth) && req.depth >= 0) {
    return Math.floor(req.depth);
  }
  return req.fromWorkerId && delegatedRunning.has(req.fromWorkerId) ? 1 : 0;
}

/** 目标解析：id 优先，其次名称（不区分大小写），范围限定在发起者可见集合内。 */
function resolveTarget(visible: Worker[], target: string): Worker | undefined {
  const t = target.trim();
  return (
    visible.find((w) => w.id === t) ??
    visible.find((w) => w.name === t) ??
    visible.find((w) => w.name.toLowerCase() === t.toLowerCase())
  );
}

async function processOne(req: DelegationRequest): Promise<void> {
  const fromUserId = req.fromUserId || "console";
  const visible = workerService.listWorkersForUser(fromUserId);

  // target = "list"：只查询可委派清单（代理无需注入名单，Agent 按需问）
  if (req.target.trim().toLowerCase() === "list") {
    const items = visible.filter((w) => w.id !== req.fromWorkerId);
    finish(req, {
      ok: true,
      output: items.length > 0
        ? `可委派的 Agent：\n${items.map((w) => `- ${w.name}（${w.id}）${w.description ? `：${w.description}` : ""}`).join("\n")}`
        : "当前没有可委派的 Agent（需要管理员把 Agent 分配给你）。",
    });
    return;
  }

  const target = resolveTarget(visible, req.target);
  if (!target) {
    reject(req, `未找到可委派的目标「${req.target}」（不在发起者的可见范围内）`, visible);
    return;
  }

  // ---- 治理前置（全部拒绝路径都留痕在 res + 审计） ----
  if (target.id === req.fromWorkerId) {
    reject(req, "不能委派给自己（self-delegation）");
    return;
  }
  // 深度限制：发起方深度 + 1 即这条链的下一层，超过上限就拒绝
  const depth = resolveDepth(req);
  if (depth >= maxDepth()) {
    reject(req, `委派深度超限（当前第 ${depth} 层，上限 ${maxDepth()} 层）—— 上限可在 Settings 调整`);
    return;
  }
  if (req.fromWorkerId && workerService.isPlanActive(req.fromWorkerId)) {
    reject(req, "当前处于计划模式（只读），不允许委派 —— 子 Agent 会绕过只读约束");
    return;
  }
  if (workerService.isWorkerRunning(target.id)) {
    reject(req, `目标 Agent「${target.name}」正忙（已有会话在运行），请稍后重试`);
    return;
  }
  if (req.fromWorkerId && inFlightFrom.has(req.fromWorkerId)) {
    reject(req, "该 Agent 已有正在执行的委派，请等它完成后再委派");
    return;
  }

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  writeJson(ackPath(req.id), { startedAt });
  delegatedRunning.add(target.id);
  if (req.fromWorkerId) inFlightFrom.add(req.fromWorkerId);

  const fromName = (req.fromWorkerId && workerService.getWorker(req.fromWorkerId)?.name) || req.fromWorkerId || "未知 Agent";
  const framed =
    `【来自 Agent「${fromName}」的委派任务】\n` +
    `你被作为子 Agent 调用：请直接完成下面的任务并给出完整结果（结果会回传给委派方；不要反问，不要继续向外委派）。\n\n${req.prompt}`;

  const auditBase = {
    userId: fromUserId,
    workerId: target.id,
    toolName: "__delegation",
    toolCallId: undefined,
  } as const;

  auditApi.appendAuditEntry({
    ...auditBase,
    phase: "call",
    input: {
      delegationId: req.id,
      from: req.fromWorkerId,
      target: target.id,
      targetName: target.name,
      depth: depth + 1,
      prompt: req.prompt.slice(0, 300),
    },
  });

  try {
    // 与聊天/定时任务完全相同的受治理通道（预算、审计、记忆、知识库无旁路）
    const run = workerService.sendToWorker(
      target.id, framed, undefined, undefined, fromUserId, undefined, undefined,
      depth + 1, // 下一层深度：子 Agent 若再委派，其请求里带的即为此值
    );
    // 看门狗触发后 run 才结束的话，别让它的异常变成未处理拒绝
    run.catch(() => {});

    const watchdog = new Promise<null>((resolve) => setTimeout(() => resolve(null), DELEGATION_TIMEOUT_MS));
    const r = await Promise.race([run, watchdog]);

    if (r === null) {
      // 到点未回：先尽力真正停掉引擎（进程树终止），再把失败写回
      void workerService.abortChat(target.id).catch(() => {});
      auditApi.appendAuditEntry({
        ...auditBase,
        phase: "result",
        isError: true,
        reason: "watchdog timeout",
        input: { delegationId: req.id, from: req.fromWorkerId, target: target.id, timeoutMs: DELEGATION_TIMEOUT_MS },
      });
      finish(req, {
        ok: false,
        targetWorkerId: target.id,
        targetName: target.name,
        error: `委派超时已中止（${Math.round(DELEGATION_TIMEOUT_MS / 1000)}s）：目标 Agent 未在限定时间内返回结果`,
        startedAt,
        durationMs: Date.now() - startedMs,
      });
      return;
    }

    auditApi.appendAuditEntry({
      ...auditBase,
      phase: "result",
      isError: !r.success,
      reason: r.error,
      input: { delegationId: req.id, from: req.fromWorkerId, target: target.id },
    });
    finish(req, {
      ok: r.success,
      targetWorkerId: target.id,
      targetName: target.name,
      output: truncate(r.output),
      error: r.error,
      startedAt,
      durationMs: Date.now() - startedMs,
    });
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    auditApi.appendAuditEntry({
      ...auditBase,
      phase: "result",
      isError: true,
      reason: msg,
      input: { delegationId: req.id, from: req.fromWorkerId, target: target.id },
    });
    finish(req, {
      ok: false,
      targetWorkerId: target.id,
      targetName: target.name,
      error: msg,
      startedAt,
      durationMs: Date.now() - startedMs,
    });
  } finally {
    delegatedRunning.delete(target.id);
    if (req.fromWorkerId) inFlightFrom.delete(req.fromWorkerId);
  }
}

/**
 * 委派记录（req + ack + res 合并视图，供 UI 时间线）。
 * 数据源就是队列目录本身 —— 与执行完全同源，不另设副本（24h 内可回溯）。
 */
export function list(limit = 50): DelegationRecord[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(DELEGATIONS_DIR);
  } catch {
    return [];
  }
  const out: DelegationRecord[] = [];
  for (const n of names) {
    if (!n.endsWith(".req.json")) continue;
    const id = n.slice(0, -".req.json".length);
    let req: DelegationRequest;
    try {
      req = JSON.parse(fs.readFileSync(path.join(DELEGATIONS_DIR, n), "utf-8"));
    } catch {
      continue;
    }
    if (!req?.id) continue;

    let res: DelegationResult | undefined;
    try {
      if (fs.existsSync(resPath(id))) res = JSON.parse(fs.readFileSync(resPath(id), "utf-8"));
    } catch {
      // 半写窗口：按未完成处理
    }
    const acked = fs.existsSync(ackPath(id));
    const prompt = String(req.prompt ?? "");

    out.push({
      id,
      target: req.target,
      targetName: res?.targetName,
      fromWorkerId: req.fromWorkerId,
      fromWorkerName: req.fromWorkerId ? workerService.getWorker(req.fromWorkerId)?.name : undefined,
      fromUserId: req.fromUserId,
      depth: typeof req.depth === "number" && Number.isFinite(req.depth) ? Math.floor(req.depth) : 0,
      prompt: prompt.length > 300 ? `${prompt.slice(0, 300)}…` : prompt,
      status: res ? (res.ok ? "done" : "error") : (acked ? "running" : "queued"),
      outputPreview: res?.output
        ? (res.output.length > 500 ? `${res.output.slice(0, 500)}…` : res.output)
        : undefined,
      error: res?.error,
      createdAt: req.createdAt,
      durationMs: res?.durationMs,
    });
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out.slice(0, limit);
}

async function tick(): Promise<void> {
  cleanup();
  const pending = listPending();
  for (const req of pending) {
    if (processing.size >= MAX_CONCURRENT) break;
    if (processing.has(req.id)) continue;
    // 排队过久：发起方（代理）早已超时离开，执行它只会浪费资源
    const created = Date.parse(req.createdAt || "");
    if (Number.isFinite(created) && Date.now() - created > STALE_MS) {
      finish(req, { ok: false, error: "委派已过期（排队超过 10 分钟未被执行）" });
      continue;
    }
    processing.add(req.id);
    void processOne(req).finally(() => processing.delete(req.id));
  }
}

/** 启动委派循环（幂等；Electron 入口与 Web 入口各启动一次）。 */
export function start(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), POLL_MS);
  timer.unref?.();
}

export function stop(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
