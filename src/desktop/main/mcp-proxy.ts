// ---------------------------------------------------------------------------
// EAG — MCP Proxy（治理代理）
//
// 独立进程：对 Agent 引擎表现为"一个 MCP server"，实际是所有已启用 MCP
// server 的聚合网关。Agent 只连 EAG，因此**每一次工具调用都经过治理**：
//
//   Agent 引擎 ──stdio MCP──▶ EAG Proxy ──▶ 真实 MCP server
//                                ├─ 路径参数过策略（hidden 直接拒）
//                                └─ 审计（成功/失败/被拦截都记）
//
// 配置来源：<项目根>/mcp.json（enabled 的条目）
// 注入身份：env EAG_MCP_USER_ID / EAG_MCP_WORKER_ID / EAG_MCP_POLICY_OVERRIDE
//           EAG_MCP_KNOWLEDGE_IDS / EAG_MCP_DELEGATION_DEPTH
//
// 与 services/mcp-service.ts 共享 mcp-client（协议）与 mcp-governance（判定），
// 保证"管理端测试调用"与"Agent 真实调用"口径完全一致。
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import { DELEGATIONS_DIR, MCP_PATH, PROJECT_ROOT } from "./paths.ts";
import { McpStdioClient, type McpRawTool } from "./services/mcp-client.ts";
import {
  auditMcpCall, effectivePolicies, extractPaths, firstBlockedPath,
} from "./services/mcp-governance.ts";
import { resolveSecretString } from "./services/config-api.ts";
import * as knowledgeService from "./services/knowledge-service.ts";
import type { McpServerConfig, WorkerPolicy } from "../shared/types.ts";

const USER_ID = process.env.EAG_MCP_USER_ID || "console";
const WORKER_ID = process.env.EAG_MCP_WORKER_ID || undefined;
const POLICY_OVERRIDE: WorkerPolicy[] = (() => {
  try {
    const raw = process.env.EAG_MCP_POLICY_OVERRIDE;
    return raw ? (JSON.parse(raw) as WorkerPolicy[]) : [];
  } catch {
    return [];
  }
})();

/** 该 Worker 挂载的知识库（由注入层通过 env 传入，代理只允许查这些）。 */
const KNOWLEDGE_IDS: string[] = (() => {
  try {
    const raw = process.env.EAG_MCP_KNOWLEDGE_IDS;
    return raw ? (JSON.parse(raw) as string[]).filter(Boolean) : [];
  } catch {
    return [];
  }
})();

/**
 * 当前会话的委派深度（0 = 用户直接会话；n = 第 n 层子 Agent）。
 * 由注入层写入；委派时随请求传给 EAG，由 EAG 决定是否放行并给下一层 +1。
 */
const DELEGATION_DEPTH = Math.max(0, Math.floor(Number(process.env.EAG_MCP_DELEGATION_DEPTH) || 0));

// ---------------------------------------------------------------------------
// 聚合状态
// ---------------------------------------------------------------------------

interface Handle {
  cfg: McpServerConfig;
  client: McpStdioClient;
  /** LLM 友好的短名（工具名前缀） */
  slug: string;
  tools: McpRawTool[];
}

const handles: Handle[] = [];

function slugify(name: string, fallback: string): string {
  const s = (name || fallback).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || fallback;
}

function readConfigs(): McpServerConfig[] {
  try {
    const list = JSON.parse(fs.readFileSync(MCP_PATH, "utf-8"));
    return Array.isArray(list) ? (list as McpServerConfig[]).filter((s) => s.enabled) : [];
  } catch {
    return [];
  }
}

function resolvedEnv(cfg: McpServerConfig): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(cfg.env ?? {})) out[k] = resolveSecretString(v);
  return out;
}

/** 启动全部 server（并发；单个失败不影响其他）。 */
async function boot(): Promise<void> {
  const cfgs = readConfigs();
  const used = new Set<string>();

  await Promise.allSettled(
    cfgs.map(async (cfg) => {
      let slug = slugify(cfg.name, cfg.id);
      while (used.has(slug)) slug = `${slug}-${cfg.id.slice(-4)}`;
      used.add(slug);

      const client = new McpStdioClient({
        command: cfg.command,
        args: cfg.args ?? [],
        env: resolvedEnv(cfg),
        cwd: cfg.cwd || PROJECT_ROOT,
      });
      await client.start();
      const tools = await client.listTools();
      handles.push({ cfg, client, slug, tools });
    }),
  );
}

// ---------------------------------------------------------------------------
// 工具聚合与调用
// ---------------------------------------------------------------------------

/**
 * 内置治理工具：知识库检索。
 *
 * 仅当该 Worker 挂了知识库、且 Embedding 已配置时才对 Agent 暴露 ——
 * 让 Agent 能**主动**查（而非只依赖对话前的自动注入）。
 * 检索范围严格限定在挂载的集合内（env 由注入层传入）。
 */
function builtinTools(): Array<{ name: string; description: string; inputSchema: unknown }> {
  const tools: Array<{ name: string; description: string; inputSchema: unknown }> = [
    // 子 Agent 委派：无前置条件，恒可用（治理在 EAG 侧执行时把关）
    ...delegationTools(),
  ];

  // 知识库检索：仅当该 Worker 挂了知识库、且 Embedding 已配置时暴露
  if (KNOWLEDGE_IDS.length > 0 && knowledgeService.embeddingConfigured()) {
    tools.push({
      name: "knowledge__search",
      description:
        "[EAG 知识库] 在公司内部知识库中检索与问题相关的资料片段。" +
        "当问题涉及内部规范、产品文档、既有决策或团队约定时，先检索再回答。",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "检索问题或关键词" },
          topK: { type: "number", description: "返回片段数，默认 5" },
        },
        required: ["query"],
      },
    });
  }

  return tools;
}

function allTools(): Array<{ name: string; description: string; inputSchema: unknown }> {
  const external = handles.flatMap((h) =>
    h.tools.map((t) => ({
      name: `${h.slug}__${t.name}`,
      description: `[${h.cfg.name}] ${t.description ?? ""}`.trim(),
      inputSchema: t.inputSchema ?? { type: "object", properties: {} },
    })),
  );
  return [...builtinTools(), ...external];
}

const SEP = "__";

async function handleCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  const sep = name.indexOf(SEP);
  if (sep <= 0) throw new Error(`工具名不合法：${name}`);
  const slug = name.slice(0, sep);
  const toolName = name.slice(sep + SEP.length);

  // 内置工具：子 Agent 委派（文件队列；治理与执行在 EAG 侧，不转发外部 server）
  if (slug === "agents" && (toolName === "delegate" || toolName === "delegate_status")) {
    return handleDelegation(toolName, args);
  }

  // 内置工具：知识库检索（不转发给外部 server）
  if (slug === "knowledge" && toolName === "search") {
    if (KNOWLEDGE_IDS.length === 0) throw new Error("该 Worker 未挂载知识库");
    const query = String((args as { query?: unknown })?.query ?? "").trim();
    if (!query) throw new Error("query 不能为空");
    const topK = Math.max(1, Math.min(Number((args as { topK?: unknown })?.topK) || 5, 12));

    const merged: Array<{ text: string; score: number; collectionName: string; docTitle: string }> = [];
    for (const id of KNOWLEDGE_IDS) {
      // knowledgeService.search 内部写审计（__knowledge_search），来源可追溯
      const r = await knowledgeService.search({ collectionId: id, query, topK }, USER_ID);
      if (r.error) throw new Error(`知识库检索失败：${r.error}`);
      merged.push(...r.hits);
    }
    merged.sort((a, b) => b.score - a.score);
    const hits = merged.slice(0, topK);

    if (hits.length === 0) {
      return { content: [{ type: "text", text: "（知识库中没有找到相关内容）" }] };
    }
    const text = hits
      .map((h, i) => `[${i + 1}] ${h.collectionName} · ${h.docTitle}（相关度 ${h.score.toFixed(3)}）\n${h.text}`)
      .join("\n\n---\n\n");
    return { content: [{ type: "text", text }] };
  }

  const h = handles.find((x) => x.slug === slug);
  if (!h) throw new Error(`未知工具：${name}（可用：${allTools().map((t) => t.name).join(", ")}）`);

  const toolLabel = `mcp:${h.cfg.id}:${toolName}`;

  // 1) 策略前置：路径参数必须先过策略（治理代理的核心价值）
  const policies = effectivePolicies(POLICY_OVERRIDE);
  const blocked = firstBlockedPath(policies, extractPaths(args));
  if (blocked) {
    const reason = `策略禁止访问路径：${blocked}`;
    auditMcpCall({ userId: USER_ID, workerId: WORKER_ID, toolLabel, args, ok: false, blocked: true, error: reason });
    throw new Error(reason);
  }

  // 2) 转发
  try {
    const result = await h.client.callTool(toolName, args);
    auditMcpCall({ userId: USER_ID, workerId: WORKER_ID, toolLabel, args, ok: true, result });
    return result;
  } catch (e: any) {
    const err = e?.message ?? String(e);
    auditMcpCall({ userId: USER_ID, workerId: WORKER_ID, toolLabel, args, ok: false, error: err });
    throw new Error(err);
  }
}

// ---------------------------------------------------------------------------
// 子 Agent 委派（文件队列：Agent → EAG → 目标 Agent）
//
// 代理只负责"提交 + 等结果"；治理与执行在 EAG 侧（delegation-service）：
// 目标可见性、深度限制、计划模式、预算封顶全在那里把关，没有任何旁路。
//
// 不用 HTTP 的原因：Electron 模式没有 HTTP 服务；而审计早就是同机文件通道，
// 委派沿用同一约束，双模式行为完全一致。
// ---------------------------------------------------------------------------

/** 默认等待秒数：够快任务一次拿完结果，超时的用 delegate_status 续查。 */
const DELEGATE_WAIT_DEFAULT = 90;
const DELEGATE_WAIT_MAX = 600;

function delegationTools(): Array<{ name: string; description: string; inputSchema: unknown }> {
  return [
    {
      name: "agents__delegate",
      description:
        "[EAG 委派] 把一个子任务交给另一个 Agent（Worker）执行并等待结果。" +
        "适合：任务可独立交付、需要另一个 Agent 的专长或权限、或可以并行分包时。" +
        'target 填目标 Agent 名称或 id；不确定有哪些目标时，先把 target 填 "list" 查询。' +
        "等待超时不会取消任务，之后可用 agents__delegate_status 查询。",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", description: '目标 Agent 名称或 id；填 "list" 查询可委派清单' },
          prompt: { type: "string", description: "要委派的任务描述（写清目标、输入与期望产出）" },
          waitSeconds: { type: "number", description: `等待结果的最长秒数，默认 ${DELEGATE_WAIT_DEFAULT}，最大 ${DELEGATE_WAIT_MAX}` },
        },
        required: ["target"],
      },
    },
    {
      name: "agents__delegate_status",
      description: "[EAG 委派] 查询已提交委派的状态与结果（id 来自 agents__delegate 的返回）。",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "委派 id" },
          waitSeconds: { type: "number", description: "最多等待秒数，默认 60" },
        },
        required: ["id"],
      },
    },
  ];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const delegationFile = (id: string, kind: "req" | "ack" | "res") =>
  path.join(DELEGATIONS_DIR, `${id}.${kind}.json`);

function clampWait(v: unknown, dft: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return dft;
  return Math.max(5, Math.min(n, DELEGATE_WAIT_MAX));
}

/** 轮询结果文件；null = 等待超时（任务不会取消，EAG 侧仍在执行）。 */
async function waitDelegationResult(id: string, waitSeconds: number): Promise<Record<string, any> | null> {
  const deadline = Date.now() + waitSeconds * 1000;
  for (;;) {
    try {
      if (fs.existsSync(delegationFile(id, "res"))) {
        return JSON.parse(fs.readFileSync(delegationFile(id, "res"), "utf-8"));
      }
    } catch {
      // 半写窗口：下一轮再读（EAG 侧是原子替换，理论上读不到半截）
    }
    if (Date.now() >= deadline) return null;
    await sleep(500);
  }
}

function delegationText(id: string, target: string, res: Record<string, any> | null): string {
  if (!res) {
    const state = fs.existsSync(delegationFile(id, "ack")) ? "执行中" : "排队中";
    return `⏳ 委派 #${id} 仍在${state}（目标：${target}）。任务不会被取消，稍后用 agents__delegate_status 查询（id: ${id}）。`;
  }
  if (!res.ok) {
    return `❌ 委派失败（#${id}，目标：${res.targetName ?? target}）：${res.error ?? "未知错误"}`;
  }
  const dur = typeof res.durationMs === "number" ? `，耗时 ${(res.durationMs / 1000).toFixed(1)}s` : "";
  const body = String(res.output ?? "").trim() || "（目标 Agent 未返回文本结果）";
  return `✅ 委派完成（#${id}，目标：${res.targetName ?? target}${dur}）\n\n${body}`;
}

async function handleDelegation(
  tool: "delegate" | "delegate_status",
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const wrap = (text: string) => ({ content: [{ type: "text", text }] });

  // 续查已提交的委派
  if (tool === "delegate_status") {
    const id = String((args as any)?.id ?? "").trim();
    if (!/^[a-z0-9-]+$/i.test(id)) throw new Error("委派 id 不合法");
    if (!fs.existsSync(delegationFile(id, "req"))) {
      return wrap(`未找到委派 #${id}（id 有误，或请求文件已被清理）。`);
    }
    const res = await waitDelegationResult(id, clampWait((args as any)?.waitSeconds, 60));
    return wrap(delegationText(id, "—", res));
  }

  // 新建委派
  const target = String((args as any)?.target ?? "").trim();
  const prompt = String((args as any)?.prompt ?? "").trim();
  if (!target) throw new Error('target 不能为空（填目标 Agent 名称或 id，或填 "list" 查询清单）');
  const isList = target.toLowerCase() === "list";
  if (!isList && !prompt) throw new Error("prompt 不能为空");

  const id = `dl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  try {
    fs.mkdirSync(DELEGATIONS_DIR, { recursive: true });
    const file = delegationFile(id, "req");
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({
      id,
      target,
      prompt,
      fromWorkerId: WORKER_ID,
      fromUserId: USER_ID,
      depth: DELEGATION_DEPTH,
      createdAt: new Date().toISOString(),
    }, null, 2), "utf-8");
    fs.renameSync(tmp, file); // 原子落地：EAG 不会读到半截请求
  } catch (e: any) {
    throw new Error(`委派通道不可用（无法写入 ${DELEGATIONS_DIR}）：${e?.message ?? e}`);
  }

  const res = await waitDelegationResult(id, clampWait((args as any)?.waitSeconds, DELEGATE_WAIT_DEFAULT));
  if (isList && res?.ok) return wrap(String(res.output ?? "（无内容）"));
  return wrap(delegationText(id, target, res));
}

// ---------------------------------------------------------------------------
// stdio JSON-RPC 主循环
// ---------------------------------------------------------------------------

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

const bootPromise = boot().catch(() => {
  // 启动失败：以"零工具"继续服务，initialize 仍可成功
});

async function dispatch(msg: any): Promise<void> {
  const { id, method, params } = msg ?? {};
  const isRequest = id !== undefined;

  try {
    await bootPromise;

    if (method === "initialize") {
      return send({
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "eag-mcp-proxy", version: "0.1.0" },
        },
      });
    }
    if (method === "notifications/initialized") return; // 通知：无响应
    if (method === "tools/list") {
      return send({ jsonrpc: "2.0", id, result: { tools: allTools() } });
    }
    if (method === "tools/call") {
      const result = await handleCall(params?.name, (params?.arguments ?? {}) as Record<string, unknown>);
      return send({ jsonrpc: "2.0", id, result });
    }
    if (method === "ping") {
      return send({ jsonrpc: "2.0", id, result: {} });
    }
    if (isRequest) {
      return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `不支持的方法 ${method}` } });
    }
  } catch (e: any) {
    if (isRequest) {
      send({ jsonrpc: "2.0", id, error: { code: -32603, message: e?.message ?? String(e) } });
    }
  }
}

let buffer = "";
process.stdin.on("data", (chunk: Buffer) => {
  buffer += chunk.toString("utf-8");
  let idx: number;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // 坏帧：忽略
    }
    void dispatch(msg);
  }
});

function shutdown(): void {
  for (const h of handles) h.client.stop();
  handles.length = 0;
}
process.on("SIGINT", () => { shutdown(); process.exit(0); });
process.on("SIGTERM", () => { shutdown(); process.exit(0); });
// MCP 生命周期：客户端（引擎）退出后 stdin 会关闭，本进程必须跟着退出。
// 否则它会变成孤儿进程活着，并且**继承着引擎的 stdout 管道** ——
// 上游 adapter 的 `for await (line of rl)` 因此永远等不到 EOF，
// 表现为任务/委派卡死（本机实测踩到：引擎已退出，委派却挂到看门狗超时）。
process.stdin.on("end", () => { shutdown(); process.exit(0); });
process.stdin.on("close", () => { shutdown(); process.exit(0); });
process.on("exit", shutdown);
