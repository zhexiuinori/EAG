/**
 * fs-gate: tool_call handler that enforces file system access policy.
 *
 * Intercepts read/write/edit tool calls and:
 *   - "rw"  → pass through (no-op)
 *   - "r"   → block write/edit, pass read
 *   - "hidden" → block with ENOENT error (must be indistinguishable from "file not found")
 *
 * 审批（human-in-the-loop，参考 QwenPaw 的 ApprovalCard）：
 *   写操作被拒时可挂起等待管理员裁决 —— 通过，则放行本次调用。
 *   读操作永远不进入审批：否则"审批出现/不出现"会暴露 hidden 文件的存在性。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ToolCallEvent, ToolCallEventResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveRealPath, matchPolicy } from "./policy.ts";
import type { PolicyMap } from "./policy.ts";

// ---------------------------------------------------------------------------
// Helpers: extract path from each tool call input
// ---------------------------------------------------------------------------

function extractPath(event: ToolCallEvent): string | undefined {
  switch (event.toolName) {
    case "read":
    case "ls":
      return (event.input as { path?: string }).path;
    case "write":
    case "edit":
      return (event.input as { path?: string }).path;
    default:
      return undefined;
  }
}

function getRequiredAccess(event: ToolCallEvent): "read" | "write" {
  // read and ls are read operations; write and edit are write operations
  return event.toolName === "read" || event.toolName === "ls" ? "read" : "write";
}

// ---------------------------------------------------------------------------
// Error messages (must match Pi's native error format exactly)
// ---------------------------------------------------------------------------

function enoentRead(rawPath: string): ToolCallEventResult {
  return {
    block: true,
    reason: `Could not read file: ${rawPath}. Error code: ENOENT.`,
  };
}

function enoentWrite(rawPath: string): ToolCallEventResult {
  return {
    block: true,
    reason: `Could not write to file: ${rawPath}. Error code: ENOENT.`,
  };
}

function enoentEdit(rawPath: string): ToolCallEventResult {
  return {
    block: true,
    reason: `Could not edit file: ${rawPath}. Error code: ENOENT.`,
  };
}

function eaccesWrite(rawPath: string): ToolCallEventResult {
  return {
    block: true,
    reason: `Could not write to file: ${rawPath}. Error code: EACCES.`,
  };
}

function eaccesEdit(rawPath: string): ToolCallEventResult {
  return {
    block: true,
    reason: `Could not edit file: ${rawPath}. Error code: EACCES.`,
  };
}

// ---------------------------------------------------------------------------
// 审批：挂起等待管理员裁决
// ---------------------------------------------------------------------------

/** 审批总开关：`EAG_APPROVAL=0` 关闭（关闭后直接拒绝）。 */
function approvalEnabled(): boolean {
  return process.env.EAG_APPROVAL !== "0";
}

/** 等待裁决的最长时间。 */
function approvalTimeoutMs(): number {
  const n = Number(process.env.EAG_APPROVAL_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
}

function approvalDir(): string {
  return process.env.EAG_APPROVAL_DIR || path.resolve(process.cwd(), ".eag", "approvals");
}

/**
 * 写审批请求文件并阻塞轮询决策文件。
 * 与主进程 approval-service 的协议：
 *   req-<id>.json  { id, toolName, path, access, reason, ts, cwd, pid }
 *   res-<id>.json  { id, approved, ts, by? }
 */
async function waitForApproval(req: {
  toolName: string;
  path: string;
  access: string;
  reason: string;
}): Promise<boolean> {
  const dir = approvalDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return false;
  }

  const id = randomUUID();
  const reqPath = path.join(dir, `req-${id}.json`);
  const resPath = path.join(dir, `res-${id}.json`);

  try {
    fs.writeFileSync(
      reqPath,
      JSON.stringify({ id, ...req, ts: new Date().toISOString(), cwd: process.cwd(), pid: process.pid }),
      "utf-8",
    );
  } catch {
    return false;
  }

  const deadline = Date.now() + approvalTimeoutMs();
  try {
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 800));
      try {
        const raw = fs.readFileSync(resPath, "utf-8");
        const decision = JSON.parse(raw) as { approved?: boolean };
        return decision.approved === true;
      } catch {
        // 尚未决策
      }
    }
    return false; // 超时 → 拒绝
  } finally {
    try { fs.unlinkSync(reqPath); } catch { /* 忽略 */ }
    try { fs.unlinkSync(resPath); } catch { /* 忽略 */ }
  }
}

/** 写操作被拒时的审批入口：返回 true 表示获批放行。 */
async function maybeApprove(event: ToolCallEvent, realPath: string, access: string): Promise<boolean> {
  if (!approvalEnabled()) return false;
  return waitForApproval({
    toolName: event.toolName,
    path: realPath,
    access,
    reason: access === "hidden" ? "路径在策略中不可见" : "路径为只读",
  });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export function createFsGateHandler(policies: PolicyMap) {
  return async (event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | void> => {
    if (!["read", "write", "edit", "ls"].includes(event.toolName)) {
      return; // not our concern
    }

    const rawPath = extractPath(event);
    if (!rawPath) {
      // Can't determine path — block to be safe
      return { block: true, reason: `Could not read file: unknown path. Error code: ENOENT.` };
    }

    const cwd = ctx.cwd || process.cwd();
    const realPath = resolveRealPath(rawPath, cwd);
    const required = getRequiredAccess(event);

    const entry = matchPolicy(realPath, policies);
    if (!entry || entry.access === "hidden") {
      // "hidden" → pretend the file doesn't exist（读操作不进入审批）
      if (event.toolName === "read" || event.toolName === "ls") return enoentRead(rawPath);
      if (await maybeApprove(event, realPath, "hidden")) return undefined;
      if (event.toolName === "write") return enoentWrite(rawPath);
      return enoentEdit(rawPath);
    }

    if (entry.access === "r" && required === "write") {
      // "r" path, trying to write → EACCES（可审批放行）
      if (await maybeApprove(event, realPath, "read-only")) return undefined;
      if (event.toolName === "write") return eaccesWrite(rawPath);
      return eaccesEdit(rawPath);
    }

    // access allowed, pass through
    return undefined;
  };
}
