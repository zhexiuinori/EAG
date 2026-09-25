// ---------------------------------------------------------------------------
// EAG — MCP 注入（让 Agent 引擎用上受治理的工具）
//
// 关键设计：注入给引擎的**不是**原始 MCP server，而是 EAG 代理进程。
//   Agent 引擎 ──▶ EAG Proxy（mcp-proxy）──▶ 真实 MCP server
// 因此引擎侧的每一次 MCP 调用同样过策略与审计 —— 与 EAG 侧测试调用口径一致。
//
// 各引擎的注入方式：
//   · claude-code：--mcp-config <file>（官方支持的 JSON 配置）
//   · codex：-c mcp_servers.eag.* 覆盖（不写用户的 config.toml）
//
// 代理产物缺失（未构建）时不注入 —— fail-safe，绝不影响对话主流程。
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import { MCP_PROXY_PATH } from "../paths.ts";
import { getSession } from "../services/user-service.ts";
import type { Worker } from "../../shared/types.ts";
import type { AgentSessionOptions } from "./types.ts";

/** 代理是否可用：需要已构建的 JS 产物（开发态跑过 npm run build 即可）。 */
export function proxyAvailable(): boolean {
  return fs.existsSync(MCP_PROXY_PATH);
}

/**
 * 是否注入代理：只要产物已构建就注入。
 *
 * 早期只在"有启用的 MCP server / 挂了知识库"时注入；现在代理还内置
 * **子 Agent 委派**（agents__delegate），且"所有工具调用都经治理代理"
 * 本身就是平台设计目标 —— 因此恒注入（没有可代理的 server 时它只是一层轻壳）。
 */
export function shouldInject(_worker: Worker): boolean {
  return proxyAvailable();
}

/**
 * 代理的启动命令 + 环境（结构化返回）。
 *
 * 用 process.execPath 而非字面 "node"：Electron 打包后用户机器不一定装了
 * node，而 Electron 自带 node 运行时（ELECTRON_RUN_AS_NODE=1 时以纯 node 运行）。
 *
 * 调用方自行决定如何落到引擎配置：claude 写 JSON 文件，codex 写 config.toml。
 */
export function proxyCommand(worker: Worker, opts?: AgentSessionOptions): { command: string; args: string[]; env: Record<string, string> } {
  const env: Record<string, string> = {
    // 身份优先取"这次运行的操作者"（后台任务/委派/定时任务），其次全局会话
    EAG_MCP_USER_ID: opts?.operatorId || getSession().userId || worker.assignedTo || "",
    EAG_MCP_WORKER_ID: worker.id,
  };
  // 委派深度（>0 = 正在作为子 Agent 运行）：代理据此在委派请求里带上深度，
  // EAG 侧限制链路长度并给下一层 +1
  const depth = Math.max(0, Math.floor(opts?.delegationDepth ?? 0));
  if (depth > 0) env.EAG_MCP_DELEGATION_DEPTH = String(depth);
  if (worker.config.policies?.length) {
    env.EAG_MCP_POLICY_OVERRIDE = JSON.stringify(worker.config.policies);
  }
  // 代理据此暴露内置 knowledge__search 工具（检索范围限定在挂载集合内）
  if (worker.config.knowledgeIds?.length) {
    env.EAG_MCP_KNOWLEDGE_IDS = JSON.stringify(worker.config.knowledgeIds);
  }
  if (process.versions.electron) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  return { command: process.execPath, args: [MCP_PROXY_PATH], env };
}

/** Claude Code：--mcp-config 的文件内容（null = 不注入）。 */
export function claudeMcpConfig(worker: Worker, opts?: AgentSessionOptions): Record<string, unknown> | null {
  if (!shouldInject(worker)) return null;
  const { command, args, env } = proxyCommand(worker, opts);
  return {
    mcpServers: {
      "eag-governed": { command, args, env },
    },
  };
}
