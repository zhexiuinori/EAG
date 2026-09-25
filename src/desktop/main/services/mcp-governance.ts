// ---------------------------------------------------------------------------
// EAG — MCP 治理判定（策略 + 审计）
//
// 被两处共用，保证"纳管调用"与"代理调用"判定口径完全一致：
//   · services/mcp-service.ts  —— 管理端测试调用
//   · mcp-proxy.ts             —— Agent 引擎经代理的调用
//
// 刻意只依赖纯函数模块（extension/policy）与审计写入，不拉 worker-service，
// 这样代理进程可以极轻地启动。
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import { POLICY_PATH, PROJECT_ROOT } from "../paths.ts";
import { resolvePolicyMap, isAccessAllowed } from "../../../extension/policy.ts";
import type { PolicyMap } from "../../../extension/policy.ts";
import type { WorkerPolicy } from "../../shared/types.ts";
import * as auditApi from "./audit-api.ts";

/** 全局默认策略（变量已展开）。 */
export function loadGlobalPolicies(): PolicyMap {
  try {
    const raw = JSON.parse(fs.readFileSync(POLICY_PATH, "utf-8"));
    return resolvePolicyMap(Array.isArray(raw) ? (raw as PolicyMap) : [], { projectRoot: PROJECT_ROOT });
  } catch {
    return [];
  }
}

/**
 * 合成生效策略：全局默认 + Worker 覆盖（后者优先，与 policy-api 语义一致）。
 * workerOverride 可由注入方通过 env 传给代理进程。
 */
export function effectivePolicies(workerOverride?: WorkerPolicy[]): PolicyMap {
  const base = loadGlobalPolicies();
  if (!workerOverride?.length) return base;
  const override = resolvePolicyMap(workerOverride as PolicyMap, { projectRoot: PROJECT_ROOT });
  // 覆盖：同前缀后者胜出（与 extension/policy 的 mergePolicies 同义，此处避免额外依赖）
  const byPath = new Map<string, { path: string; access: string }>();
  for (const p of base) byPath.set(p.path, p);
  for (const p of override) byPath.set(p.path, p);
  return [...byPath.values()] as PolicyMap;
}

/** 检查一组路径是否都被允许读；返回第一个被拒的路径。 */
export function firstBlockedPath(
  policies: PolicyMap,
  paths: string[],
): string | undefined {
  for (const p of paths) {
    if (!isAccessAllowed(p, "read", policies)) return p;
  }
  return undefined;
}

export interface McpAuditInput {
  userId: string;
  workerId?: string;
  toolLabel: string;
  args: Record<string, unknown>;
  ok: boolean;
  error?: string;
  blocked?: boolean;
  result?: unknown;
}

/** 统一的 MCP 调用审计（成功 / 失败 / 被拦截三种都记）。 */
export function auditMcpCall(input: McpAuditInput): void {
  const content = input.ok && input.result !== undefined
    ? clip(JSON.stringify(input.result))
    : undefined;
  auditApi.appendAuditEntry({
    userId: input.userId || "console",
    workerId: input.workerId,
    toolName: input.toolLabel,
    toolCallId: undefined,
    phase: "call",
    input: input.args,
    content,
    isError: !input.ok,
    reason: input.ok ? undefined : input.error,
  });
  void input.blocked;
}

function clip(text: string | undefined): string | undefined {
  if (!text) return undefined;
  return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
}

/** 从工具参数里尽量提取"路径类"字符串，交给策略引擎判定。 */
export function extractPaths(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  const visit = (v: unknown): void => {
    if (typeof v === "string") {
      // 绝对/相对路径都算；过长或明显不是路径的跳过
      if (v.length < 512 && /^[./\\]|^[A-Za-z]:[\\/]/.test(v)) out.push(v);
    } else if (Array.isArray(v)) {
      v.forEach(visit);
    } else if (v && typeof v === "object") {
      Object.values(v).forEach(visit);
    }
  };
  visit(args);
  return out;
}
