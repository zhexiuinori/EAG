/**
 * Egress — 出网控制扩展模块。
 *
 * 确保模型推理只在本地/内网进行，阻断对外部网络的非授权出站。
 * 在 before_provider_headers 事件中复核端点并写入身份标识（供审计追溯）。
 *
 * 强制开关：`EAG_EGRESS_ENFORCE=1` 时，不在白名单的端点将直接抛错阻断；
 * 默认仅告警，以兼容尚未配置白名单的部署。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import * as process from "node:process";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_ENDPOINT = "http://localhost:11434";

/**
 * 白名单端点列表（逗号分隔），由 `EAG_ALLOWED_ENDPOINTS` 环境变量指定。
 * 如果未设置，则跳过 baseURL 白名单断言（允许任何端点）。
 *
 * 供 audit.ts 和 websearch.ts 引用。
 */
export const WHITELISTED_ENDPOINTS: string[] =
  process.env.EAG_ALLOWED_ENDPOINTS
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean) ?? [];

/** 是否强制执行白名单（默认否，仅告警）。 */
export function isEgressEnforced(): boolean {
  return process.env.EAG_EGRESS_ENFORCE === "1";
}

// ---------------------------------------------------------------------------
// Helper: assertBaseUrlWhitelisted
// ---------------------------------------------------------------------------

/**
 * 白名单断言。
 *
 * 语义（三态，避免"未配置=全放行"的洞）：
 *   · `EAG_ALLOWED_ENDPOINTS` 已配置：端点命中白名单 → 放行；
 *     未命中 → `EAG_EGRESS_ENFORCE=1` 抛错阻断，否则仅告警并返回 false。
 *   · `EAG_ALLOWED_ENDPOINTS` 未配置：默认放行（兼容"尚未配置白名单"的部署），
 *     但这是**刻意**的 —— 若同时设了 `EAG_EGRESS_ENFORCE=1`，则**空白名单也阻断**
 *     （防止"以为开了强制、实际连本地模型都放行"的反直觉行为）。
 *
 * 此前调用方仅用返回值决定是否打印日志，出网控制形同虚设。
 */
export function assertBaseUrlWhitelisted(baseURL: string): boolean {
  const normalised = baseURL.replace(/\/+$/, "");

  // 白名单为空：默认放行；仅当显式要求强制时，空名单视为"无任何白名单可命中"→ 阻断
  if (WHITELISTED_ENDPOINTS.length === 0) {
    if (isEgressEnforced()) {
      const message =
        `[EAG] BLOCKED: EAG_EGRESS_ENFORCE=1 但 EAG_ALLOWED_ENDPOINTS 为空，` +
        `因此任何端点 "${baseURL}" 都不可用。请配置白名单或关闭强制。`;
      console.error(message);
      throw new Error(message);
    }
    return true;
  }

  const allowed = WHITELISTED_ENDPOINTS.some((ep) => {
    const normalisedEp = ep.replace(/\/+$/, "");
    return normalised === normalisedEp || normalised.startsWith(normalisedEp + "/");
  });

  if (!allowed) {
    const message =
      `[EAG] BLOCKED: Inference endpoint "${baseURL}" is not in EAG_ALLOWED_ENDPOINTS. ` +
      `Allowed: ${WHITELISTED_ENDPOINTS.join(", ")}.`;
    console.error(message);
    if (isEgressEnforced()) {
      throw new Error(message);
    }
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Extension default export
// ---------------------------------------------------------------------------

export default function egressExtension(api: ExtensionAPI) {
  const userId = process.env.EAG_USER_ID ?? "";

  // --- 1. 启动期白名单断言 ---
  // 注意：模型真实端点由 Pi adapter 经 EAG_MODEL_BASE_URL 注入，
  // 并非 EAG_INFERENCE_ENDPOINT。两者都检查，否则白名单拦不到真实模型端点。
  const inferenceEndpoint = process.env.EAG_MODEL_BASE_URL || process.env.EAG_INFERENCE_ENDPOINT || DEFAULT_ENDPOINT;
  assertBaseUrlWhitelisted(inferenceEndpoint);

  // --- 2. 每次推理请求前复核端点并注入身份标识 ---
  api.on("before_provider_headers", () => {
    // 启动期校验通过后，运行期端点仍可能被改写，故逐请求复核。
    assertBaseUrlWhitelisted(
      process.env.EAG_MODEL_BASE_URL || process.env.EAG_INFERENCE_ENDPOINT || DEFAULT_ENDPOINT,
    );

    const sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
    const sessionId = sessionDir ? path.basename(sessionDir) : undefined;

    // 身份写入环境变量，供 audit.ts 把审计条目关联到具体用户与会话。
    if (userId) process.env.EAG_AUDIT_USER_ID = userId;
    if (sessionId) process.env.EAG_AUDIT_SESSION_ID = sessionId;
  });

  // --- 3. PI_OFFLINE 提示 ---
  if (!process.env.PI_OFFLINE) {
    console.warn("[EAG] 建议设置 PI_OFFLINE=1 以禁用 fd/rg 自动下载。");
  }
}
