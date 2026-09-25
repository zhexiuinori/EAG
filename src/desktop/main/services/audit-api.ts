// ---------------------------------------------------------------------------
// EAG Desktop — Audit API service
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { DEFAULT_AUDIT_DIR } from "../paths.ts";
import type {
  AuditEntry, FileDiffInput, FileDiffResult,
  FileSnapshot, FileSnapshotsInput, FileSnapshotsResult,
  FileRestoreInput, FileRestoreResult,
} from "../../shared/types.ts";
import { extractToolPath, isPreImageEnabled, isSensitivePath } from "./snapshot.ts";

function getAuditDir(): string {
  return process.env.EAG_AUDIT_DIR || DEFAULT_AUDIT_DIR;
}

function dateStamp(date?: Date): string {
  const d = date || new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ---------------------------------------------------------------------------
// 审计不可篡改：哈希链（HMAC）
//
// 每条记录追加 `_hash` 字段 = HMAC(secret, 前一条_hash + 本条内容)。
// 篡改任何一条，后续所有哈希都会失配 → 完整性校验可检测。
//
// 密钥：`EAG_AUDIT_SECRET` 环境变量（跨重启可验证）；缺失时用进程内随机密钥
// （默认，仅会话内自证）。部署者应设固定密钥，实现真正不可篡改。
// ---------------------------------------------------------------------------

let auditSecret: Buffer | null = null;

function getAuditSecret(): Buffer {
  if (auditSecret) return auditSecret;
  const env = process.env.EAG_AUDIT_SECRET;
  auditSecret = Buffer.from(env || crypto.randomBytes(32).toString("hex"), "utf-8");
  return auditSecret;
}

/** HMAC 拼接：prevHash + 规范化后的本条内容。 */
function chainHash(prevHash: string | null, content: string): string {
  return crypto.createHmac("sha256", getAuditSecret()).update(`${prevHash ?? ""}\n${content}`).digest("hex");
}

/** 从一条 JSON 记录中提取"内容部分"（不含 _hash 字段的稳定序列化）。 */
function contentOf(record: Record<string, unknown>): string {
  const { _hash, ...rest } = record;
  return JSON.stringify(rest);
}

/**
 * Append one audit entry to today's NDJSON log.
 * Called by worker-service for every agent tool call / result / cost event.
 * 追加时计算前一条的哈希链，写入本条 _hash。
 */
export function appendAuditEntry(entry: Omit<AuditEntry, "timestamp">): void {
  try {
    const auditDir = getAuditDir();
    fs.mkdirSync(auditDir, { recursive: true });
    const record: AuditEntry = { timestamp: new Date().toISOString(), ...entry };
    const logPath = path.join(auditDir, `audit-${dateStamp()}.ndjson`);

    // 取当前文件最后一条的 _hash 作为前哈希；无历史则 prevHash = null
    let prevHash: string | null = null;
    try {
      const lines = fs.readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
      const last = lines[lines.length - 1];
      if (last) {
        const lastRecord = JSON.parse(last) as Record<string, unknown>;
        prevHash = (lastRecord._hash as string) ?? null;
      }
    } catch {
      // 文件不存在/不可读：从头开始链
    }

    const recordObj = record as unknown as Record<string, unknown>;
    recordObj._hash = chainHash(prevHash, contentOf(recordObj));

    fs.appendFileSync(logPath, JSON.stringify(recordObj) + "\n", "utf-8");
  } catch (err) {
    // Audit must never break the agent pipeline.
    console.error("[Audit] Failed to append entry:", err);
  }
}

/**
 * 校验某天审计日志的哈希链完整性。
 * 返回 { valid, brokenAt }：任一条失配即 brokenAt 指向该行号。
 */
export function verifyAuditIntegrity(date: string): { valid: boolean; brokenAt?: number; checked: number } {
  const logPath = path.join(getAuditDir(), `audit-${date}.ndjson`);
  if (!fs.existsSync(logPath)) return { valid: true, checked: 0 };

  const lines = fs.readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
  let prevHash: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    try {
      const rec = JSON.parse(lines[i]) as Record<string, unknown>;
      const expected = chainHash(prevHash, contentOf(rec));
      if (rec._hash !== expected) {
        return { valid: false, brokenAt: i + 1, checked: lines.length };
      }
      prevHash = rec._hash as string;
    } catch {
      return { valid: false, brokenAt: i + 1, checked: lines.length };
    }
  }
  return { valid: true, checked: lines.length };
}

export function listAuditEntries(options?: {
  date?: string;
  limit?: number;
  search?: string;
}): { entries: unknown[]; date: string } {
  const date = options?.date || dateStamp();
  const auditDir = getAuditDir();
  const logPath = path.join(auditDir, `audit-${date}.ndjson`);

  if (!fs.existsSync(logPath)) {
    return { entries: [], date };
  }

  const raw = fs.readFileSync(logPath, "utf-8");
  const lines = raw.split("\n").filter(Boolean);

  let entries = lines.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);

  // Apply search filter
  if (options?.search) {
    const q = options.search.toLowerCase();
    entries = entries.filter((e: any) =>
      JSON.stringify(e).toLowerCase().includes(q)
    );
  }

  // Apply limit (newest first, then reverse for chronological)
  if (options?.limit && options.limit > 0) {
    entries = entries.slice(-options.limit);
  }

  return { entries, date };
}

// ---------------------------------------------------------------------------
// 内容级 diff
// ---------------------------------------------------------------------------

/** 向前回溯的审计天数，以及返回内容的字符上限。 */
const DIFF_SCAN_DAYS = 7;
const MAX_DIFF_CHARS = 200_000;

/**
 * 取某 Worker 对某文件的改动：
 *   before = 审计日志中的改前快照（写前抓取）
 *   after  = 磁盘上的当前内容
 *
 * 只在审计日志中查找，不额外做文件监听——因此依赖写类工具已记录 pre-image。
 */
export function getFileDiff(input: FileDiffInput): FileDiffResult {
  const target = path.resolve(input.path);

  let before: string | null = null;
  let changedAt: string | undefined;

  for (let day = 0; day < DIFF_SCAN_DAYS && before === null; day++) {
    const d = new Date();
    d.setDate(d.getDate() - day);
    const logPath = path.join(getAuditDir(), `audit-${dateStamp(d)}.ndjson`);
    if (!fs.existsSync(logPath)) continue;

    const lines = fs.readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry: any;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (entry?.workerId !== input.workerId) continue;
      if (typeof entry.preImage !== "string") continue;

      const p = extractToolPath(entry.input);
      if (!p || path.resolve(p) !== target) continue;

      before = entry.preImage;
      changedAt = entry.timestamp;
      break;
    }
  }

  let after: string | null = null;
  try {
    after = fs.readFileSync(target, "utf-8");
  } catch {
    after = null; // 文件已被删除或不可读
  }

  const clip = (s: string | null): string | null =>
    s && s.length > MAX_DIFF_CHARS ? s.slice(0, MAX_DIFF_CHARS) : s;

  if (before === null && after === null) {
    return { found: false, path: target, before: null, after: null };
  }

  return {
    found: true,
    path: target,
    before: clip(before),
    after: clip(after),
    changedAt,
    note: before === null ? "无改前快照（可能是新建文件，或该文件被跳过抓取）" : undefined,
  };
}

// ---------------------------------------------------------------------------
// 文件快照链（检查点 / 回滚）
// ---------------------------------------------------------------------------

/** 在审计日志中收集某文件的全部 pre-image 快照（按时间正序）。 */
function collectSnapshots(workerId: string, target: string): Array<{ timestamp: string; preImage: string }> {
  const out: Array<{ timestamp: string; preImage: string }> = [];

  for (let day = 0; day < DIFF_SCAN_DAYS; day++) {
    const d = new Date();
    d.setDate(d.getDate() - day);
    const logPath = path.join(getAuditDir(), `audit-${dateStamp(d)}.ndjson`);
    if (!fs.existsSync(logPath)) continue;

    const lines = fs.readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry?.workerId !== workerId) continue;
      if (typeof entry.preImage !== "string") continue;
      const p = extractToolPath(entry.input);
      if (!p || path.resolve(p) !== target) continue;
      out.push({ timestamp: entry.timestamp, preImage: entry.preImage });
    }
  }

  out.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return out;
}

/** 列出某文件的全部历史版本（检查点）。 */
export function listFileSnapshots(input: FileSnapshotsInput): FileSnapshotsResult {
  const target = path.resolve(input.path);
  const raw = collectSnapshots(input.workerId, target);
  const snapshots: FileSnapshot[] = raw.map((s, i) => ({
    timestamp: s.timestamp,
    size: s.preImage.length,
    latest: i === raw.length - 1,
  }));
  return { path: target, snapshots };
}

/**
 * 恢复到指定版本。
 * 恢复前先把"当前内容"补记为一条快照（审计记录），因此回滚本身也可再回滚。
 */
export function restoreFromSnapshot(input: FileRestoreInput): FileRestoreResult {
  const target = path.resolve(input.path);
  const raw = collectSnapshots(input.workerId, target);
  const hit = raw.find((s) => s.timestamp === input.timestamp);

  if (!hit) {
    return { ok: false, path: target, error: "未找到该版本的快照" };
  }

  // 当前内容补一次快照（跳过敏感/超大文件），保证恢复操作可逆
  try {
    if (fs.existsSync(target)) {
      const cur = fs.readFileSync(target, "utf-8");
      if (isPreImageEnabled() && !isSensitivePath(target) && cur.length <= 256 * 1024) {
        appendAuditEntry({
          userId: "restore",
          workerId: input.workerId,
          toolName: "__restore_pre_image",
          toolCallId: undefined,
          phase: "call",
          input: { path: target },
          preImage: cur,
        });
      }
    }
  } catch {
    // 快照失败不阻塞恢复
  }

  try {
    fs.writeFileSync(target, hit.preImage, "utf-8");
    return { ok: true, path: target };
  } catch (e: any) {
    return { ok: false, path: target, error: e?.message ?? String(e) };
  }
}
