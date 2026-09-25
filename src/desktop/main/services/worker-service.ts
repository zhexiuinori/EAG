// ---------------------------------------------------------------------------
// EAG Desktop — Worker Service
//
// Manages Worker persistence and delegates execution to agent adapters
// (claude-code / codex / pi / ...). This service never builds agent-specific
// arguments — governance decisions stay here, engine details stay in
// src/desktop/main/adapters/*.
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import { WORKERS_DIR, PROJECT_ROOT, UPLOADS_DIR } from "../paths.ts";
import { capturePreImage, extractToolPath, WRITE_TOOLS } from "./snapshot.ts";
import { scanSensitive } from "./guardrail.ts";
import * as memory from "./memory.ts";
import * as knowledgeService from "./knowledge-service.ts";
import * as executionBus from "./execution-bus.ts";
import * as configApi from "./config-api.ts";
import * as auditApi from "./audit-api.ts";
import * as groupService from "./group-service.ts";
import * as userService from "./user-service.ts";
import { getAdapter, isAdapterAvailable } from "../adapters/registry.ts";
import type { AgentAdapter, AgentSession } from "../adapters/types.ts";
import type {
  AgentEvent, AgentKind, ResolvedModelRef, Worker, ChatAttachment,
  WorkerAssignInput, WorkerCreateInput, WorkerUpdateInput,
} from "../../shared/types.ts";

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function workersFilePath(): string {
  return path.join(WORKERS_DIR, "workers.json");
}

function ensureDir(): void {
  fs.mkdirSync(WORKERS_DIR, { recursive: true });
}

function loadAll(): Worker[] {
  ensureDir();
  try {
    const raw = fs.readFileSync(workersFilePath(), "utf-8");
    return JSON.parse(raw) as Worker[];
  } catch {
    return [];
  }
}

function saveAll(workers: Worker[]): void {
  ensureDir();
  fs.writeFileSync(workersFilePath(), JSON.stringify(workers, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Worker CRUD
// ---------------------------------------------------------------------------

export function listWorkers(): Worker[] {
  return loadAll();
}

/**
 * 一个 Worker 的完整可见用户列表。
 * `assignedUserIds` 缺省/为空时回退到 `assignedTo`，保证旧数据语义不变。
 */
export function workerAssignees(w: Worker): string[] {
  const list = (w.assignedUserIds ?? []).filter(Boolean);
  if (list.length > 0) return list;
  return w.assignedTo ? [w.assignedTo] : [];
}

/**
 * 用户可见的 Worker（三级可见性）：
 *   1. 直接分配（assignedUserIds，含主负责人）
 *   2. 组可见（assignedGroupIds 命中用户所在组）
 *   3. 全员（type = "project"）
 */
export function listWorkersForUser(userId: string): Worker[] {
  const myGroupIds = groupService.listGroupIdsForUser(userId);
  const all = loadAll();
  return all.filter((w) => {
    if (w.type === "project") return true;
    if (workerAssignees(w).includes(userId)) return true;
    const gids = w.assignedGroupIds ?? [];
    return gids.some((g) => myGroupIds.includes(g));
  });
}

export function getWorker(id: string): Worker | undefined {
  return loadAll().find((w) => w.id === id);
}

export function createWorker(input: WorkerCreateInput): Worker {
  const workers = loadAll();
  const now = new Date().toISOString();
  const userIds = [...new Set((input.assignedUserIds ?? []).filter(Boolean))];
  const groupIds = [...new Set((input.assignedGroupIds ?? []).filter(Boolean))];
  const w: Worker = {
    id: `w-${Date.now()}`,
    ...input,
    assignedTo: userIds[0] ?? input.assignedTo,
    assignedUserIds: userIds.length > 0 ? userIds : (input.assignedTo ? [input.assignedTo] : []),
    assignedGroupIds: groupIds,
    status: "stopped",
    createdAt: now,
    updatedAt: now,
  };
  workers.push(w);
  saveAll(workers);
  return w;
}

/**
 * 重新分配（多用户 + 组）。主负责人取第一个用户。
 * 分配变更写入审计 —— 治理平台必须能回答"谁把哪个 Agent 给了谁"。
 */
export function assignWorker(input: WorkerAssignInput): Worker | undefined {
  const workers = loadAll();
  const idx = workers.findIndex((w) => w.id === input.id);
  if (idx === -1) return undefined;

  const userIds = [...new Set(input.userIds.filter(Boolean))];
  const groupIds = [...new Set(input.groupIds.filter(Boolean))];
  const w = workers[idx];

  workers[idx] = {
    ...w,
    assignedTo: userIds[0] ?? w.assignedTo,
    assignedUserIds: userIds,
    assignedGroupIds: groupIds,
    updatedAt: new Date().toISOString(),
  };
  saveAll(workers);

  try {
    auditApi.appendAuditEntry({
      userId: userService.getSession().userId,
      workerId: w.id,
      toolName: "__worker_assign",
      toolCallId: undefined,
      phase: "call",
      input: { assignedUserIds: userIds, assignedGroupIds: groupIds },
    });
  } catch {
    // 审计失败不影响分配本身
  }

  return workers[idx];
}

/** 用户被删除时从所有分配的 Worker 中移除（避免悬挂引用）。 */
export function removeUserFromAssignments(userId: string): void {
  const workers = loadAll();
  let dirty = false;
  for (const w of workers) {
    const assignees = workerAssignees(w);
    if (!assignees.includes(userId)) continue;
    const next = assignees.filter((x) => x !== userId);
    w.assignedUserIds = next;
    if (w.assignedTo === userId) w.assignedTo = next[0] ?? "";
    dirty = true;
  }
  if (dirty) saveAll(workers);
}

/** 用户组被删除时从所有分配的 Worker 中移除（避免指向不存在的组）。 */
export function removeGroupFromAssignments(groupId: string): void {
  const workers = loadAll();
  let dirty = false;
  for (const w of workers) {
    const gids = w.assignedGroupIds ?? [];
    if (!gids.includes(groupId)) continue;
    w.assignedGroupIds = gids.filter((g) => g !== groupId);
    dirty = true;
  }
  if (dirty) saveAll(workers);
}

export function updateWorker(input: WorkerUpdateInput): Worker | undefined {
  const workers = loadAll();
  const idx = workers.findIndex((w) => w.id === input.id);
  if (idx === -1) return undefined;
  workers[idx] = { ...workers[idx], ...input.patch, updatedAt: new Date().toISOString() };
  saveAll(workers);
  return workers[idx];
}

export function deleteWorker(id: string): boolean {
  stopWorker(id);
  const workers = loadAll();
  const idx = workers.findIndex((w) => w.id === id);
  if (idx === -1) return false;
  workers.splice(idx, 1);
  saveAll(workers);
  return true;
}

// ---------------------------------------------------------------------------
// Budget — per-worker spend cap
// ---------------------------------------------------------------------------

/**
 * 进程内累计成本（USD），由 cost 事件累加。
 * ponytail: 跨重启会清零；若需硬性封顶，应从审计日志按月聚合（见下方
 * getWorkerSpendUsd 说明）。对 claude/codex 的 cost 事件足够，pi 无 cost 上报。
 */
const workerSpendUsd = new Map<string, number>();

/** 某 Worker 本轮进程内的累计消耗；缺省为 0。 */
export function getWorkerSpendUsd(workerId: string): number {
  return workerSpendUsd.get(workerId) ?? 0;
}

/** 判断是否仍允许该 Worker 发起新对话（未设上限则恒可）。 */
export function isWorkerBudgeted(worker: Worker): { ok: boolean; reason?: string } {
  const limit = worker.config.budgetLimitUsd;
  if (limit == null || limit <= 0) return { ok: true };
  const spent = getWorkerSpendUsd(worker.id);
  if (spent >= limit) {
    return {
      ok: false,
      reason: `预算已耗尽（累计 $${spent.toFixed(4)} / 上限 $${limit}`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Model resolution (governance layer owns credentials)
// ---------------------------------------------------------------------------

/**
 * Resolve the model a Worker should run:
 *   1. Runtime override (chat request / TopBar selection)
 *   2. Worker's own config
 *   3. Config's active provider (global default)
 */
export function resolveModelRef(
  worker: Worker,
  override?: { modelProviderId?: string; modelName?: string },
): ResolvedModelRef {
  const config = configApi.getConfig();
  const providers = config.providers;

  const providerId = override?.modelProviderId || worker.config.modelProviderId || config.activeProviderId || providers[0]?.id || "";
  const provider = providers.find((p) => p.id === providerId);
  const modelName = override?.modelName || worker.config.modelName || provider?.activeModel || "";

  return {
    providerId,
    providerName: provider?.name ?? providerId,
    providerType: provider?.type ?? "custom",
    modelName,
    baseUrl: provider?.baseUrl ?? "",
    apiKey: provider?.apiKey,
  };
}

// ---------------------------------------------------------------------------
// Worker lifecycle — via agent adapters
// ---------------------------------------------------------------------------

/** The engine kind driving a worker (legacy workers without agentKind = pi). */
export function workerAgentKind(worker: Worker): AgentKind {
  return worker.config.agentKind ?? "pi";
}

interface ActiveSession {
  session: AgentSession;
  kind: AgentKind;
  startedAt: number;
  /** 是否计划模式（只读）：委派等能力据此收紧（子 Agent 不能绕过只读约束） */
  planOnly?: boolean;
}

const active = new Map<string, ActiveSession>();

/** 该 Worker 当前是否在计划模式（只读）运行。 */
export function isPlanActive(id: string): boolean {
  return active.get(id)?.planOnly === true;
}

/** Validate the worker's adapter is installed and mark it ready. */
export async function startWorker(id: string): Promise<boolean> {
  const worker = getWorker(id);
  if (!worker) return false;

  const kind = workerAgentKind(worker);
  if (!isAdapterAvailable(kind)) {
    updateWorker({ id, patch: { status: "error" } });
    return false;
  }

  const det = await getAdapter(kind).detect();
  if (!det.installed) {
    updateWorker({ id, patch: { status: "error" } });
    return false;
  }

  updateWorker({ id, patch: { status: "running" } });
  return true;
}

export function stopWorker(id: string): boolean {
  const entry = active.get(id);
  if (entry) {
    entry.session.stop().catch(() => {});
    active.delete(id);
  }
  updateWorker({ id, patch: { status: "stopped" } });
  return true;
}

/**
 * Abort the in-flight chat turn of a worker (kills the agent subprocess).
 * 与 stopWorker 的区别：这是用户侧"停止生成"，只终止当前这一轮对话。
 * Returns false when nothing is running for the worker.
 */
export async function abortChat(workerId: string): Promise<boolean> {
  const entry = active.get(workerId);
  if (!entry) return false;
  await entry.session.stop().catch(() => {});
  active.delete(workerId);
  updateWorker({ id: workerId, patch: { status: "stopped" } });
  return true;
}

export function getWorkerStatus(id: string): { running: boolean; pid: number | null; spentUsd?: number; budgetLimitUsd?: number; memorySummary?: string } {
  const entry = active.get(id);
  const worker = getWorker(id);
  // 记忆摘要：该 worker 最新会话沉淀的记忆（当前会话用户可见）
  const userId = userService.getSession().userId;
  const memorySummary = (() => {
    if (!userId) return undefined;
    try {
      return memory.listSessions(userId, id)[0]?.summary;
    } catch {
      return undefined;
    }
  })();
  return {
    running: !!entry,
    pid: null,
    // 预算状态透出：UI 可展示"已花 $x / 上限 $y"
    spentUsd: getWorkerSpendUsd(id),
    budgetLimitUsd: worker?.config.budgetLimitUsd,
    memorySummary,
  };
}

export function isWorkerRunning(id: string): boolean {
  return active.has(id);
}

/** Adapter info for a worker's engine (used by UI). */
export function adapterForWorker(worker: Worker): AgentAdapter {
  return getAdapter(workerAgentKind(worker));
}

// ---------------------------------------------------------------------------
// Audit — governance events from every adapter
// ---------------------------------------------------------------------------

function audit(
  worker: Worker,
  entry: Omit<import("../../shared/types.ts").AuditEntry, "timestamp" | "userId">,
  operatorId?: string,
): void {
  if (!worker.config.auditEnabled) return;
  // userId 记录"实际操作者"（当前会话用户）而非 worker.assignedTo ——
  // 否则 project 型 / 组共享的 Agent 被他人使用时，追责会指向错误的人。
  // operatorId 用于后台任务：提交后即便身份被切换，归属仍锚定提交者。
  auditApi.appendAuditEntry({
    ...entry,
    userId: operatorId || userService.getSession().userId,
    workerId: worker.id,
  });
}

// ---------------------------------------------------------------------------
// Send — one governed conversation turn
// ---------------------------------------------------------------------------

/** 会产生命令执行的工具（各家 CLI 命名不同）。 */
const COMMAND_TOOLS = new Set([
  "bash", "powershell", "command_execution", "exec", "shell", "terminal", "bash_execution",
]);

/** 从工具入参提取命令文本。 */
function extractCommand(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const rec = input as Record<string, unknown>;
  for (const key of ["command", "cmd", "script", "bash_command"]) {
    const value = rec[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export interface SendResult {
  success: boolean;
  output: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// 附件（多模态入口）
// ---------------------------------------------------------------------------

/** 单附件上限（解码后字节）。 */
const ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;
/** 允许的 MIME 类型（白名单：图片 / 文本 / PDF / JSON）。 */
const ATTACHMENT_TYPES = [/^image\//, /^text\//, /^application\/pdf$/, /^application\/json$/];

/**
 * 把附件落盘到 <root>/.eag/uploads/<workerId>/，返回路径与描述。
 *
 * 设计：不把 base64 内联进 prompt（会撑爆上下文），而是**落盘 + 注入路径** ——
 * 引擎自带的 Read 工具可以直接读图/读文件，且附件处于受治理的工作区内。
 * 超限或类型不符的附件被跳过并审计（不静默丢弃）。
 */
function saveAttachments(
  workerId: string,
  attachments: ChatAttachment[],
  operatorId: string,
): Array<{ path: string; note: string }> {
  const out: Array<{ path: string; note: string }> = [];
  const dir = path.join(UPLOADS_DIR, workerId);

  for (const a of attachments.slice(0, 6)) {
    const name = (a.name || "file").slice(0, 120);
    const reject = (reason: string) =>
      auditApi.appendAuditEntry({
        userId: operatorId || "console", workerId, toolName: "__attachment_upload",
        toolCallId: undefined, phase: "call",
        input: { name, mime: a.mime }, isError: true, reason,
      });

    if (!ATTACHMENT_TYPES.some((rx) => rx.test(a.mime))) {
      reject(`不支持的附件类型：${a.mime}`);
      continue;
    }

    let buf: Buffer;
    try {
      buf = Buffer.from(a.dataBase64 ?? "", "base64");
    } catch {
      reject("附件解码失败");
      continue;
    }
    if (buf.length === 0) { reject("附件为空"); continue; }
    if (buf.length > ATTACHMENT_MAX_BYTES) {
      reject(`附件超过上限（${(buf.length / 1024 / 1024).toFixed(1)} MB > 8 MB）`);
      continue;
    }

    try {
      fs.mkdirSync(dir, { recursive: true });
      const safe = name.replace(/[^\w.\-]+/g, "_");
      const file = path.join(dir, `${Date.now().toString(36)}-${safe}`);
      fs.writeFileSync(file, buf);
      out.push({ path: file, note: `（${a.mime}，${(buf.length / 1024).toFixed(0)} KB）` });
      auditApi.appendAuditEntry({
        userId: operatorId || "console", workerId, toolName: "__attachment_upload",
        toolCallId: undefined, phase: "call",
        input: { name: safe, mime: a.mime, bytes: buf.length, path: file },
      });
    } catch (e: any) {
      reject(`附件写入失败：${e?.message ?? e}`);
    }
  }

  return out;
}

/**
 * Send one user message to a worker's agent engine.
 * Streams normalized AgentEvents to onEvent (IPC forwards them to the
 * renderer) and writes governance events (tool calls / cost) to the audit log.
 */
export async function sendToWorker(
  workerId: string,
  text: string,
  override?: { modelProviderId?: string; modelName?: string },
  onEvent?: (ev: AgentEvent) => void,
  /** 显式操作者（后台任务用）：缺省取当前会话用户 */
  operatorId?: string,
  /** 用户附件（图片/文本）：落盘后把路径注入 prompt，引擎用 Read 工具查看 */
  attachments?: ChatAttachment[],
  /** 计划模式：引擎只读运行（claude: --permission-mode plan / codex: read-only） */
  planOnly?: boolean,
  /** 委派深度（>0 = 作为子 Agent 运行；注入给 MCP 代理，限制委派链长度） */
  delegationDepth?: number,
): Promise<SendResult> {
  const worker = getWorker(workerId);
  if (!worker) return { success: false, output: "", error: "Worker not found" };

  // 预算封顶：超限拒绝发起新对话（治理闭环的一部分）
  const budget = isWorkerBudgeted(worker);
  if (!budget.ok) return { success: false, output: "", error: budget.reason };

  const kind = workerAgentKind(worker);
  if (!isAdapterAvailable(kind)) {
    return { success: false, output: "", error: `Agent engine "${kind}" is not available yet` };
  }

  const adapter = getAdapter(kind);
  const det = await adapter.detect();
  if (!det.installed) {
    updateWorker({ id: workerId, patch: { status: "error" } });
    return { success: false, output: "", error: `${adapter.displayName} CLI is not installed` };
  }

  const modelRef = resolveModelRef(worker, override);

  // 记忆注入：从 Memory 取该 worker 最新会话的记忆摘要，合并进 systemPrompt。
  // adapter 读 worker.config.systemPrompt，因此这里构造一个带记忆的 worker 副本，
  // 零改动 adapter。无记忆 / 未登录时不注入。
  const memUserId = operatorId || userService.getSession().userId;
  const memoryContext = (() => {
    if (!memUserId) return undefined;
    try {
      const latest = memory.listSessions(memUserId, workerId)[0];
      return latest?.summary;
    } catch {
      return undefined;
    }
  })();
  // RAG 注入：用用户消息检索该 Worker 挂载的知识库，命中片段并入 prompt。
  // 与记忆同通道（前置到 systemPrompt），失败静默降级 —— 检索不可用不应阻断对话。
  const knowledgeContext = await (async () => {
    const ids = worker.config.knowledgeIds ?? [];
    if (ids.length === 0) return undefined;
    try {
      return await knowledgeService.buildContext(text, ids);
    } catch {
      return undefined;
    }
  })();

  // 两类上下文都标注来源标签，便于模型区分"历史记忆"与"知识库依据"
  const injected = [
    memoryContext ? `【记忆】\n${memoryContext}` : "",
    knowledgeContext ? `【知识库片段】\n${knowledgeContext}` : "",
  ].filter(Boolean).join("\n\n");

  const promptWorker: Worker = injected
    ? { ...worker, config: { ...worker.config, systemPrompt: [worker.config.systemPrompt, injected].filter(Boolean).join("\n\n") } }
    : worker;

  // 附件：落盘到受治理的工作区，并把路径注入用户消息（引擎用 Read 工具查看）
  let userText = text;
  if (attachments?.length) {
    const saved = saveAttachments(workerId, attachments, operatorId || userService.getSession().userId);
    if (saved.length > 0) {
      userText = `${text}\n\n【用户上传的附件】\n${saved.map((s) => `- ${s.path}${s.note}`).join("\n")}\n（需要时请读取这些文件查看内容）`;
    }
  }

  // 计划模式：提示词与引擎权限双重约束 ——
  // 引擎侧只读（不依赖模型自觉），提示词侧明确"只出计划、不动手"。
  if (planOnly) {
    userText = `【计划模式】当前为计划模式：请只做分析和规划，输出可执行的计划（步骤、涉及文件、风险点），不要修改任何文件、不要执行有副作用的命令。等用户确认后再执行。\n\n${userText}`;
  }

  const session = await adapter.startSession(promptWorker, {
    modelOverride: modelRef,
    planOnly,
    delegationDepth,
    // 注入层据此标注身份（审计/知识库范围/委派可见性的归属人）
    operatorId: memUserId,
  });
  active.set(workerId, { session, kind, startedAt: Date.now(), planOnly });
  updateWorker({ id: workerId, patch: { status: "running" } });

  let output = "";
  let agentCmdId: string | undefined;
  try {
    for await (const ev of session.send(userText)) {
      if (ev.type === "text_delta") {
        output += ev.delta;
      } else if (ev.type === "tool_start") {
        const input = ev.input as Record<string, unknown> | undefined;
        // 写类工具记录改前内容，供内容级 diff 使用（受敏感文件与体积限制保护）
        const preImage = WRITE_TOOLS.has(ev.toolName)
          ? capturePreImage(extractToolPath(input), PROJECT_ROOT)
          : undefined;
        audit(worker, { toolName: ev.toolName, toolCallId: undefined, phase: "call", input, preImage }, operatorId);

        // 命令类工具记入统一执行总线。
        // 当前 claude / codex 无法在平台侧拦截，故标记为 observed（仅观测），
        // 不伪装成"已管控"。
        const command = COMMAND_TOOLS.has(ev.toolName) ? extractCommand(input) : undefined;
        if (command) {
          agentCmdId = executionBus.record({
            source: "agent",
            sessionId: workerId,
            command,
            cwd: PROJECT_ROOT,
            verdict: "observed",
          }).id;
        }
      } else if (ev.type === "tool_end") {
        audit(worker, { toolName: ev.toolName, toolCallId: undefined, phase: "result", input: undefined, content: ev.content, isError: ev.isError }, operatorId);

        // 内容护栏：检测 Agent 输出中是否含密钥 / 凭证 / PII。
        // 命中则记一条审计告警（不阻断——第一阶段做标记，避免误伤正常开发输出；
        // 后续可用 EAG_GUARDRAIL_ENFORCE 升级为真正阻断）。
        if (ev.content) {
          const findings = scanSensitive(ev.content);
          if (findings.length > 0) {
            audit(worker, {
              toolName: "__content_guardrail",
              toolCallId: undefined,
              phase: "call",
              input: { toolName: ev.toolName, findings },
              isError: true,
              reason: `工具输出疑似泄露敏感内容：${findings.map((f) => f.kind).join(", ")}`,
            }, operatorId);
          }
        }

        if (agentCmdId) {
          executionBus.complete(agentCmdId, {
            endedAt: new Date().toISOString(),
            outputPreview: ev.content,
          });
          agentCmdId = undefined;
        }
      } else if (ev.type === "cost") {
        audit(worker, { toolName: "__session_cost", toolCallId: undefined, phase: "result", input: undefined, content: JSON.stringify(ev.usage ?? {}), costUsd: ev.totalCostUsd }, operatorId);
        // 预算累加：cost 事件是 claude/codex 报告的真实消耗
        if (ev.totalCostUsd != null && ev.totalCostUsd > 0) {
          workerSpendUsd.set(workerId, (workerSpendUsd.get(workerId) ?? 0) + ev.totalCostUsd);
        }
      }
      onEvent?.(ev);
    }
    // 记忆落盘：把这一轮对话提炼成可持久化的记忆。
    // userId 来自实际操作者；缺省（未登录）跳过。落盘失败不影响对话主流程。
    const memUserId = operatorId || userService.getSession().userId;
    if (memUserId && output.trim()) {
      try {
        const session = memory.ensureSession(memUserId, workerId);
        memory.saveMessages(memUserId, workerId, session.id, [
          ...memory.loadMessages(memUserId, workerId, session.id),
          { role: "user", content: text },
          { role: "assistant", content: output.trim() },
        ]);
        // 记忆摘要：从本轮对话提炼要点，供下一轮注入。
        memory.setSummary(memUserId, workerId, session.id, memory.deriveSummary(text, output));
      } catch (e) {
        console.error("[Memory] 记忆落盘失败（不影响对话）:", e);
      }
    }
    return { success: true, output };
  } catch (err: any) {
    const message = err?.message ?? String(err);
    onEvent?.({ type: "error", message });
    return { success: false, output, error: message };
  } finally {
    active.delete(workerId);
    await session.dispose().catch(() => {});
    // 会话结束：状态回落（否则 Workers 页会一直显示"运行中"）。
    // 加 active 检查：并发启动的新会话不应被这里覆盖。
    if (!active.has(workerId)) updateWorker({ id: workerId, patch: { status: "stopped" } });
  }
}
