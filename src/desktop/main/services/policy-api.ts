// ---------------------------------------------------------------------------
// EAG Desktop — Policy API service
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import type { PolicyMap } from "../../../extension/policy.ts";
import { isAccessAllowed, resolvePolicyMap, mergePolicies } from "../../../extension/policy.ts";
import { POLICY_PATH, PROJECT_ROOT } from "../paths.ts";
import * as workerService from "./worker-service.ts";
import type { WorkerPolicy } from "../../shared/types.ts";

export function getPolicy(): PolicyMap {
  try {
    const raw = fs.readFileSync(POLICY_PATH, "utf-8");
    return JSON.parse(raw) as PolicyMap;
  } catch {
    return [];
  }
}

export function updatePolicy(policies: PolicyMap): void {
  fs.writeFileSync(POLICY_PATH, JSON.stringify(policies, null, 2), "utf-8");
}

/**
 * 某 Worker 实际生效的策略 = 全局默认 + Worker 覆盖，变量已展开。
 *
 * adapter 必须用这个而不是直接读 worker.config.policies，
 * 否则 Policy 管理页配的规则对该 Worker 完全不生效。
 */
export function getEffectivePolicies(workerPolicies: WorkerPolicy[] = []): PolicyMap {
  const ctx = { projectRoot: PROJECT_ROOT };
  const base = resolvePolicyMap(getPolicy(), ctx);
  const override = resolvePolicyMap(workerPolicies as PolicyMap, ctx);
  return mergePolicies(base, override);
}

/** 指定 Worker 的生效策略，供用户侧展示"我受什么约束"。 */
export function getEffectivePoliciesForWorker(workerId: string): PolicyMap {
  const worker = workerService.getWorker(workerId);
  return getEffectivePolicies(worker?.config.policies ?? []);
}

export function checkPath(filePath: string): { allowed: boolean; access: string | null } {
  // 原始策略含 ${PROJECT_ROOT} 等变量，判定前必须展开
  const policies = resolvePolicyMap(getPolicy(), { projectRoot: PROJECT_ROOT });
  const entry = policies.find((p) => filePath.startsWith(p.path));
  const access = entry?.access ?? null;
  return {
    allowed: isAccessAllowed(filePath, "read", policies),
    access,
  };
}
