/**
 * EAG Audit Logger — records all tool invocations (who, when, which tool, what changed).
 *
 * Registers tool_call and tool_result handlers that append NDJSON lines to
 * {EAG_AUDIT_DIR}/audit-{YYYY-MM-DD}.ndjson.
 *
 * The tool_call handler MUST be registered **first** (before fs-gate) so that
 * pre-image capture for write/edit tools happens before any other handler
 * potentially modifies the file.
 */

import type {
  ExtensionAPI,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Audit log entry shape
// ---------------------------------------------------------------------------

interface AuditLogEntry {
  timestamp: string;
  userId: string;
  toolName: string;
  toolCallId: string | undefined;
  phase: "call" | "result";
  input: Record<string, unknown> | undefined;
  /** Content from tool_result (text content) */
  content?: string;
  isError?: boolean;
  /** Reason for blocking (populated only on rejected calls) */
  reason?: string;
  /** Pre-image content for write/edit tools (the file content before modification) */
  preImage?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ENV_USER_ID = "EAG_USER_ID";
const ENV_AUDIT_DIR = "EAG_AUDIT_DIR";

function getAuditDir(): string {
  const envDir = process.env[ENV_AUDIT_DIR];
  if (envDir && envDir.length > 0) {
    return envDir;
  }
  // Fallback: resolve relative to this extension's directory
  const extDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(extDir, "..", "audit");
}

function ensureDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Best-effort: if we can't create the directory, let appendLine handle the error
  }
}

function dateStamp(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function isoNow(): string {
  return new Date().toISOString();
}

function appendLine(entry: AuditLogEntry): void {
  const auditDir = getAuditDir();
  try {
    ensureDir(auditDir);
    const logPath = path.join(auditDir, `audit-${dateStamp()}.ndjson`);
    fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
  } catch (err) {
    // Audit failure must not block execution
    console.error("[EAG:Audit] Failed to write audit log:", err);
  }
}

/** Known write/edit tool names that can modify file content. */
const WRITE_TOOLS = new Set(["write", "edit"]);

/**
 * Capture pre-image for write/edit tools.
 * Returns the current file content, or undefined if the file does not exist
 * or cannot be read.
 */
function capturePreImage(rawPath: string | undefined, cwd: string): string | undefined {
  if (!rawPath) return undefined;
  const absPath = path.resolve(cwd, rawPath);
  try {
    return fs.readFileSync(absPath, "utf-8");
  } catch {
    // File doesn't exist yet (new file creation) or unreadable — that's fine
    return undefined;
  }
}

/** Extract file path from tool input (mirrors fs-gate logic). */
function extractPath(toolName: string, input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  switch (toolName) {
    case "read":
    case "write":
    case "edit":
    case "ls":
      return (input as { path?: string }).path;
    default:
      return undefined;
  }
}

/** Extract text from content blocks for result logging. */
function extractTextContent(content: unknown[] | undefined): string | undefined {
  if (!content || content.length === 0) return undefined;
  const texts: string[] = [];
  for (const block of content) {
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      texts.push(b.text);
    }
  }
  return texts.length > 0 ? texts.join("\n") : undefined;
}

// ---------------------------------------------------------------------------
// Cross-phase state: maps toolCallId -> partial log entry
// This is needed because the "reason" (block) may only be known post-facto,
// but we want to include it in the same logical audit trail.
// ---------------------------------------------------------------------------

const pendingCalls = new Map<string, AuditLogEntry>();

// ---------------------------------------------------------------------------
// Handler factories
// ---------------------------------------------------------------------------

/**
 * Create the tool_call audit handler.
 *
 * Records input parameters, and for write/edit tools captures the file
 * pre-image **before** any other handler (like fs-gate) can modify or block
 * the call.
 *
 * This handler never blocks execution.
 */
export function createAuditToolCallHandler() {
  return async (
    event: ToolCallEvent,
    ctx: ExtensionContext,
  ): Promise<ToolCallEventResult | void> => {
    try {
      const cwd = ctx.cwd || process.cwd();
      const userId = process.env[ENV_USER_ID] || "unknown";
      const rawPath = extractPath(event.toolName, event.input);
      const preImage = WRITE_TOOLS.has(event.toolName)
        ? capturePreImage(rawPath, cwd)
        : undefined;

      const entry: AuditLogEntry = {
        timestamp: isoNow(),
        userId,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        phase: "call",
        input: event.input,
        preImage,
      };

      // Store in pending map so tool_result can correlate
      if (event.toolCallId) {
        pendingCalls.set(event.toolCallId, entry);
      }

      appendLine(entry);
    } catch {
      // Handler must not throw — that would block execution
      console.error("[EAG:Audit] tool_call handler error (non-blocking)");
    }

    // Audit never blocks
    return undefined;
  };
}

/**
 * Create the tool_result audit handler.
 *
 * Records execution result (isError, content).
 */
export function createAuditToolResultHandler() {
  // 审计不改写作结果，返回 void 即可。
  // 注意：SDK 未从包根导出 ToolResultEventResult，故不显式标注该类型。
  return async (
    event: ToolResultEvent,
    _ctx: ExtensionContext,
  ): Promise<void> => {
    try {
      const userId = process.env[ENV_USER_ID] || "unknown";

      const entry: AuditLogEntry = {
        timestamp: isoNow(),
        userId,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        phase: "result",
        input: event.input,
        content: extractTextContent(event.content),
        isError: event.isError,
      };

      // If there was a pending call entry with preImage, carry it forward
      if (event.toolCallId) {
        const pending = pendingCalls.get(event.toolCallId);
        if (pending?.preImage !== undefined) {
          entry.preImage = pending.preImage;
        }
        pendingCalls.delete(event.toolCallId);
      }

      appendLine(entry);
    } catch {
      // Handler must not throw — throwing in tool_result would let the
      // original (unfiltered) result pass through
      console.error("[EAG:Audit] tool_result handler error (non-blocking)");
    }

    // Audit does not modify results
    return undefined;
  };
}

export default function eagAuditExtension(api: ExtensionAPI) {
  api.on("tool_call", createAuditToolCallHandler());
  api.on("tool_result", createAuditToolResultHandler());
}
