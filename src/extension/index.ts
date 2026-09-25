/**
 * EAG Governance Extension — entry point.
 *
 * Registers handlers for:
 *   - audit (tool_call + tool_result recording)
 *   - fs-gate (read/write/edit/ls policy enforcement)
 *   - fs-filter (grep/find output filtering)
 *   - egress (provider + PI_OFFLINE validation)
 *   - websearch (internal proxy search tool)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createFsGateHandler } from "./fs-gate.ts";
import { createCommandGateHandler } from "./command-gate.ts";
import { createFsFilterHandler } from "./fs-filter.ts";
import { createAuditToolCallHandler, createAuditToolResultHandler } from "./audit.ts";
import egressExtension from "./egress.ts";
import { registerWebsearchTool } from "./websearch.ts";
import { resolvePolicyMap, mergePolicies, type PolicyMap } from "./policy.ts";

export interface EagGovernanceOptions {
  /** Inline policy; if omitted, loaded from policy.json next to this file. */
  policy?: PolicyMap;
}

export default function eagGovernanceExtension(api: ExtensionAPI, options?: EagGovernanceOptions) {
  // --- Load policy ---
  let policies: PolicyMap;

  // 策略路径支持 ${PROJECT_ROOT} / ${HOME} 等变量，需先展开再使用，
  // 否则写死的 POSIX 路径在 Windows 上会导致全部条目失配（默认 deny）。
  const policyCtx = { projectRoot: process.env.EAG_PROJECT_ROOT || process.cwd() };

  if (options?.policy) {
    policies = resolvePolicyMap(options.policy, policyCtx);
  } else {
    const extDir = path.dirname(fileURLToPath(import.meta.url));
    const policyPath = path.resolve(extDir, "policy.json");
    try {
      const raw = fs.readFileSync(policyPath, "utf-8");
      policies = resolvePolicyMap(JSON.parse(raw) as PolicyMap, policyCtx);
    } catch (err) {
      console.error(`[EAG] Failed to load policy from ${policyPath}:`, err);
      // Default: deny everything
      policies = [];
    }
  }

  // Worker 级策略覆盖（由 adapter 经 EAG_POLICY_OVERRIDE 注入）。
  // 合并后，三个引擎读到的是同一份"全局默认 + Worker 覆盖"的生效策略。
  const overrideRaw = process.env.EAG_POLICY_OVERRIDE;
  if (overrideRaw) {
    try {
      const override = JSON.parse(overrideRaw) as PolicyMap;
      if (Array.isArray(override) && override.length > 0) {
        policies = mergePolicies(policies, resolvePolicyMap(override, policyCtx));
        console.error(`[EAG] 已应用 ${override.length} 条 Worker 级策略覆盖`);
      }
    } catch (err) {
      console.error("[EAG] EAG_POLICY_OVERRIDE 解析失败（已忽略）:", err);
    }
  }

  // --- Egress: white-list assertion + PI_OFFLINE check ---
  egressExtension(api);
  // Check PI_OFFLINE
  if (!process.env.PI_OFFLINE) {
    console.warn("[EAG] PI_OFFLINE not set. fd/rg auto-download is enabled.");
  }

  // --- Register handlers ---
  // IMPORTANT: Audit MUST be registered first (before fs-gate) so that
  // pre-image capture for write/edit tools happens before any other handler
  // potentially modifies the file content.
  api.on("tool_call", createAuditToolCallHandler());
  api.on("tool_call", createFsGateHandler(policies));
  api.on("tool_call", createCommandGateHandler());

  // tool_result: audit records results, fs-filter strips hidden paths
  api.on("tool_result", createAuditToolResultHandler());
  api.on("tool_result", createFsFilterHandler(policies));

  // --- Register tools ---
  registerWebsearchTool(api);
}
