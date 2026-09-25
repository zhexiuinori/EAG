// ---------------------------------------------------------------------------
// EAG — 治理总览（Governance Summary）
//
// 聚合 EAG 的治理状态，供前端"治理总览仪表盘"展示：
//   · 每个 Worker 的预算消耗（对应 budgetLimitUsd）
//   · 今日内容护栏命中数（guardrail）
//   · 今日审计拦截数
//   · 出网管控状态（EAG_EGRESS_ENFORCE + 白名单）
//   · 沙箱模式（当前为 local；Docker 隔离工作区待接入）
//   · 今日审计完整性（哈希链）
//
// 纯读聚合，不修改状态 —— 这是一个只读的快照服务。
// ---------------------------------------------------------------------------

import * as workerService from "./worker-service.ts";
import * as auditApi from "./audit-api.ts";
import { WHITELISTED_ENDPOINTS, isEgressEnforced } from "../../../extension/egress.ts";

export interface GovernanceSummary {
  /** 每个 Worker 的预算消耗与上限 */
  workers: Array<{ id: string; name: string; spentUsd: number; budgetLimitUsd?: number }>;
  /** 今日审计拦截数（含护栏命中） */
  blockedToday: number;
  /** 今日内容护栏命中数（疑似泄露） */
  guardrailToday: number;
  /** 出网管控：白名单端点 + 是否强制 */
  egress: { enforced: boolean; endpoints: string[] };
  /** 沙箱模式：当前实现为 local（无隔离）；Docker 隔离工作区待接入 */
  sandboxMode: "local" | "docker";
  /** 今日审计完整性（哈希链校验） */
  audit: { valid: boolean; checked: number };
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

export function getGovernanceSummary(): GovernanceSummary {
  const workers = workerService.listWorkers().map((w) => ({
    id: w.id,
    name: w.name,
    spentUsd: workerService.getWorkerSpendUsd(w.id),
    budgetLimitUsd: w.config.budgetLimitUsd,
  }));

  const todayEntries = auditApi.listAuditEntries({ date: todayStamp(), limit: 10000 }).entries as Array<{
    isError?: boolean;
    reason?: string;
    toolName?: string;
  }>;

  const blockedToday = todayEntries.filter((e) => e.reason).length;
  const guardrailToday = todayEntries.filter((e) => e.toolName === "__content_guardrail").length;

  return {
    workers,
    blockedToday,
    guardrailToday,
    egress: {
      enforced: isEgressEnforced(),
      endpoints: WHITELISTED_ENDPOINTS,
    },
    sandboxMode: "local", // ponytail: 当前未接入 Docker 隔离工作区，恒为 local
    audit: auditApi.verifyAuditIntegrity(todayStamp()),
  };
}
