// ---------------------------------------------------------------------------
// EAG Desktop — MCP (Model Context Protocol) Service
//
// 定位：EAG 是治理层，不是 Agent。MCP 让 Agent 拿到外部工具（文件/数据库/
// 检索…），而 EAG 负责让这些调用**可被治理**：
//   · 统一纳管 MCP server（配置、启停、工具清单）
//   · tools/call 前过策略（路径类参数走 policy checkPath）
//   · 每次调用写审计（toolName = mcp:<serverId>:<tool>）
//
// 进程与协议实现见 mcp-client.ts（与 mcp-proxy.ts 共用）。
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import { MCP_PATH, PROJECT_ROOT } from "../paths.ts";
import { resolveSecretString } from "./config-api.ts";
import { McpStdioClient } from "./mcp-client.ts";
import * as policyApi from "./policy-api.ts";
import { auditMcpCall, extractPaths } from "./mcp-governance.ts";
import type {
  McpServerConfig, McpServerView, McpUpsertInput, McpTool,
  McpToolsResult, McpCallInput, McpCallResult,
} from "../../shared/types.ts";

// ---------------------------------------------------------------------------
// 持久化
// ---------------------------------------------------------------------------

function load(): McpServerConfig[] {
  try {
    const list = JSON.parse(fs.readFileSync(MCP_PATH, "utf-8"));
    return Array.isArray(list) ? (list as McpServerConfig[]) : [];
  } catch {
    return [];
  }
}

function save(list: McpServerConfig[]): void {
  fs.writeFileSync(MCP_PATH, JSON.stringify(list, null, 2), "utf-8");
}

let servers: McpServerConfig[] = load();

/** env 值可能是 "${ENV_VAR}" 占位符，落盘保留占位符，启动时才插值。 */
export function resolveEnv(env?: Record<string, string>): Record<string, string> | undefined {
  if (!env) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) out[k] = resolveSecretString(v);
  return out;
}

function toView(s: McpServerConfig): McpServerView {
  const { env: _env, ...rest } = s;
  return { ...rest, envKeys: Object.keys(s.env ?? {}), running: isRunning(s.id) };
}

export function listServers(): McpServerView[] {
  return servers.map(toView);
}

/** 启用中的 server（供代理注入：只有 enabled 的才对 Agent 可见）。 */
export function listEnabledServerConfigs(): McpServerConfig[] {
  return servers.filter((s) => s.enabled);
}

export function upsertServer(input: McpUpsertInput): McpServerView {
  const id = input.id ?? `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const idx = servers.findIndex((s) => s.id === id);
  const base: McpServerConfig = idx >= 0 ? servers[idx] : {
    id,
    name: input.name,
    command: input.command,
    args: input.args ?? [],
    env: input.env ?? {},
    cwd: input.cwd,
    enabled: input.enabled ?? true,
    createdAt: new Date().toISOString(),
  };

  const next: McpServerConfig = {
    ...base,
    name: input.name,
    command: input.command,
    args: input.args ?? [],
    env: input.env ?? base.env ?? {},
    cwd: input.cwd,
    enabled: input.enabled ?? base.enabled,
  };

  if (idx >= 0) {
    // 配置变更 → 停掉旧进程，下次调用用新配置重启
    stopServer(id);
    servers[idx] = next;
  } else {
    servers.push(next);
  }
  save(servers);
  return toView(next);
}

export function deleteServer(id: string): boolean {
  stopServer(id);
  const next = servers.filter((s) => s.id !== id);
  if (next.length === servers.length) return false;
  servers = next;
  save(servers);
  return true;
}

export function getServer(id: string): McpServerConfig | undefined {
  return servers.find((s) => s.id === id);
}

// ---------------------------------------------------------------------------
// 连接管理（进程 + 协议见 mcp-client.ts）
// ---------------------------------------------------------------------------

const clients = new Map<string, McpStdioClient>();

export function isRunning(id: string): boolean {
  return clients.get(id)?.running ?? false;
}

/** 取（或建立）某 server 的连接。 */
async function ensureClient(id: string): Promise<McpStdioClient> {
  const existing = clients.get(id);
  if (existing?.running) {
    if (!existing.ready) await existing.start(); // 进程在但未握手
    return existing;
  }

  const cfg = getServer(id);
  if (!cfg) throw new Error(`MCP server「${id}」不存在`);
  if (!cfg.enabled) throw new Error(`MCP server「${cfg.name}」已禁用`);

  const client = new McpStdioClient({
    command: cfg.command,
    args: cfg.args ?? [],
    env: resolveEnv(cfg.env),
    cwd: cfg.cwd || PROJECT_ROOT,
    onExit: () => clients.delete(id),
  });
  clients.set(id, client);
  await client.start();
  return client;
}

export function stopServer(id: string): void {
  clients.get(id)?.stop();
  clients.delete(id);
}

// ---------------------------------------------------------------------------
// 工具清单
// ---------------------------------------------------------------------------

export async function listTools(id: string): Promise<McpToolsResult> {
  try {
    const client = await ensureClient(id);
    const raw = await client.listTools();
    const tools: McpTool[] = raw.map((t) => ({
      qualifiedName: `${id}::${t.name}`,
      serverId: id,
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    return { tools, running: true };
  } catch (e: any) {
    return { tools: [], running: false, error: e?.message ?? String(e) };
  }
}

// ---------------------------------------------------------------------------
// 工具调用（治理在这里发生）
// ---------------------------------------------------------------------------

export async function callTool(input: McpCallInput, operatorId = "console"): Promise<McpCallResult> {
  const toolLabel = `mcp:${input.id}:${input.tool}`;
  const args = input.args ?? {};

  // 1) 策略前置：MCP 工具可能读写文件，路径参数必须过策略
  for (const p of extractPaths(args)) {
    const { allowed } = policyApi.checkPath(p);
    if (!allowed) {
      const reason = `策略禁止访问路径：${p}`;
      auditMcpCall({ userId: operatorId, workerId: input.workerId, toolLabel, args, ok: false, blocked: true, error: reason });
      return { ok: false, blocked: true, blockedReason: reason, error: reason };
    }
  }

  // 2) 执行
  let result: unknown;
  try {
    const client = await ensureClient(input.id);
    result = await client.callTool(input.tool, args);
  } catch (e: any) {
    const err = e?.message ?? String(e);
    auditMcpCall({ userId: operatorId, workerId: input.workerId, toolLabel, args, ok: false, error: err });
    return { ok: false, error: err };
  }

  // 3) 审计（治理层的核心价值：外部工具调用同样可追溯）
  auditMcpCall({ userId: operatorId, workerId: input.workerId, toolLabel, args, ok: true, result });

  return { ok: true, result };
}
