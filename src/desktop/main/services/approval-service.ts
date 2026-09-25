// ---------------------------------------------------------------------------
// EAG Desktop — Approval Service
//
// Agent 触达被策略拒绝的写操作时（见 extension/fs-gate.ts），治理扩展会在
// 审批目录写一个请求文件并挂起等待。本服务负责：
//   1. 扫描请求 → 推送到 UI（审批中心）
//   2. 管理员裁决 → 写决策文件 → Agent 侧放行/拒绝
//
// 协议（目录：<项目根>/.eag/approvals，可用 EAG_APPROVAL_DIR 覆盖）：
//   req-<id>.json { id, toolName, path, access, reason, ts, cwd, pid }
//   res-<id>.json { id, approved, ts }
// 参考 QwenPaw 的 ApprovalCard / Inbox 三处一致的审批流。
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import { PROJECT_ROOT } from "../paths.ts";
import type { ApprovalRecord } from "../../shared/types.ts";

/** 待决请求的保留时长：超时后标记 expired（Agent 侧也会自行超时退出）。 */
const PENDING_TTL_MS = 5 * 60_000;

const records = new Map<string, ApprovalRecord>();

/** 记录上限：超出后淘汰最旧的已决记录（待决的绝不淘汰）。 */
const MAX_RECORDS = 200;

let sink: ((r: ApprovalRecord) => void) | null = null;

export function setApprovalSink(fn: ((r: ApprovalRecord) => void) | null): void {
  sink = fn;
}

export function approvalDir(): string {
  return process.env.EAG_APPROVAL_DIR || path.join(PROJECT_ROOT, ".eag", "approvals");
}

function publish(rec: ApprovalRecord): void {
  sink?.({ ...rec });
}

/** 扫描请求目录；由 ipc-handlers 启动的定时器驱动。 */
export function scanApprovals(): void {
  const dir = approvalDir();
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return; // 目录不存在：没有审批在跑
  }

  for (const f of files) {
    if (!f.startsWith("req-") || !f.endsWith(".json")) continue;
    const id = f.slice(4, -5);

    const existing = records.get(id);
    if (existing) {
      // 待决超时：标记 expired（避免 UI 无限倒计时）
      if (existing.status === "pending" && Date.now() - new Date(existing.ts).getTime() > PENDING_TTL_MS) {
        existing.status = "expired";
        publish(existing);
      }
      continue;
    }

    try {
      const raw = fs.readFileSync(path.join(dir, f), "utf-8");
      const parsed = JSON.parse(raw) as Omit<ApprovalRecord, "status">;
      const rec: ApprovalRecord = { ...parsed, id, status: "pending" };
      records.set(id, rec);
      trimRecords();
      publish(rec);
    } catch {
      // 坏文件跳过（可能正在写入）
    }
  }
}

/** 淘汰最旧的已决记录（pending 永远保留，等待裁决）。 */
function trimRecords(): void {
  if (records.size <= MAX_RECORDS) return;
  const decided = [...records.values()]
    .filter((r) => r.status !== "pending")
    .sort((a, b) => a.ts.localeCompare(b.ts));
  let excess = records.size - MAX_RECORDS;
  for (const r of decided) {
    if (excess <= 0) break;
    records.delete(r.id);
    excess -= 1;
  }
}

export function listApprovals(): ApprovalRecord[] {
  return [...records.values()]
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, 100);
}

/** 裁决：写决策文件；Agent 侧轮询到后放行/拒绝。 */
export function decideApproval(id: string, approved: boolean): boolean {
  const rec = records.get(id);
  if (!rec || rec.status !== "pending") return false;

  try {
    fs.mkdirSync(approvalDir(), { recursive: true });
    const decidedAt = new Date().toISOString();
    fs.writeFileSync(
      path.join(approvalDir(), `res-${id}.json`),
      JSON.stringify({ id, approved, ts: decidedAt }),
      "utf-8",
    );
    rec.status = approved ? "approved" : "denied";
    rec.decidedAt = decidedAt;
    publish(rec);
    return true;
  } catch {
    return false;
  }
}
