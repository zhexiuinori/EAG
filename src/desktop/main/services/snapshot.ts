// ---------------------------------------------------------------------------
// EAG — 写前快照（pre-image）
//
// 治理扩展（src/extension/audit.ts）只为 Pi 引擎抓取 pre-image；
// claude-code / codex 走的是主进程 worker-service，审计条目里没有快照。
// 这里把该能力上移到主进程，让内容级 diff 对三个引擎一致可用。
//
// 风险权衡：快照会把文件内容复制进审计日志。因此做了三重限制——
//   1) 只对写类工具抓取；
//   2) 敏感文件（.env / 私钥 / 凭证）跳过；
//   3) 超过体积上限跳过，并可用 EAG_AUDIT_PREIMAGE=0 整体关闭。
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";

/** 超过此大小不抓快照，避免审计日志膨胀。 */
const MAX_SNAPSHOT_BYTES = 256 * 1024;

const SENSITIVE_PATTERNS = [
  /(^|[\\/])\.env([\\.]|$)/i,
  /(^|[\\/])credentials\.json$/i,
  /(^|[\\/])[^\\/]*\.pem$/i,
  /(^|[\\/])[^\\/]*\.key$/i,
  /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)$/i,
  /(^|[\\/])\.npmrc$/i,
  /(^|[\\/])\.git[\\/]config$/i,
];

/** 会产生副作用（改文件）的工具。 */
export const WRITE_TOOLS = new Set([
  "write", "edit", "multi_edit", "notebook_edit", "create",
]);

export function isSensitivePath(p: string): boolean {
  return SENSITIVE_PATTERNS.some((re) => re.test(p));
}

/** 快照总开关：`EAG_AUDIT_PREIMAGE=0` 关闭。 */
export function isPreImageEnabled(): boolean {
  return process.env.EAG_AUDIT_PREIMAGE !== "0";
}

/** 从工具入参中提取路径（各家 CLI 字段名不统一）。 */
export function extractToolPath(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const rec = input as Record<string, unknown>;
  for (const key of ["path", "file_path", "notebook_path", "filePath", "target_file"]) {
    const value = rec[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * 读取目标文件在修改前的内容。
 * 新建文件、不可读、敏感文件、超大文件均返回 undefined（不视为错误）。
 */
export function capturePreImage(filePath: string | undefined, cwd: string): string | undefined {
  if (!filePath || !isPreImageEnabled()) return undefined;
  if (isSensitivePath(filePath)) return undefined;

  try {
    const abs = path.resolve(cwd, filePath);
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return undefined;
    if (stat.size > MAX_SNAPSHOT_BYTES) return undefined;
    return fs.readFileSync(abs, "utf-8");
  } catch {
    return undefined;
  }
}
