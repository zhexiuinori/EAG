// ---------------------------------------------------------------------------
// EAG — 统一执行总线
//
// Agent 执行与用户终端执行原本是两条互不相通的通道：
//   · 审计字段结构不同（toolName: "bash" vs "platform_terminal"）
//   · Agent 跑了什么，用户在界面上看不到
//   · 只有终端侧过命令策略，Agent 侧完全不过
//
// 本模块提供统一的记录入口：事件结构一致、审计口径一致、前端一处可查。
// ---------------------------------------------------------------------------

import * as auditApi from "./audit-api.ts";
import type {
  ExecutionEvent, ExecutionListInput, ExecutionSource, ExecutionVerdict,
} from "../../shared/types.ts";

/** 内存环形缓冲上限（进程重启即丢，不落盘）。 */
const MAX_EVENTS = 500;

/** 输出摘要长度上限。 */
const OUTPUT_PREVIEW_LIMIT = 2000;

const events: ExecutionEvent[] = [];

// ---------------------------------------------------------------------------
// 记录
// ---------------------------------------------------------------------------

export interface RecordInput {
  source: ExecutionSource;
  sessionId: string;
  command: string;
  cwd: string;
  verdict: ExecutionVerdict;
  blockedReason?: string;
  outputPreview?: string;
}

export function record(input: RecordInput): ExecutionEvent {
  const event: ExecutionEvent = {
    id: crypto.randomUUID(),
    source: input.source,
    sessionId: input.sessionId,
    command: input.command.slice(0, 4000),
    cwd: input.cwd,
    startedAt: new Date().toISOString(),
    outputPreview: clip(input.outputPreview),
    verdict: input.verdict,
    blockedReason: input.blockedReason,
  };

  events.push(event);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);

  // 统一审计口径：toolName 固定，差异放在 input 里
  auditApi.appendAuditEntry({
    userId: "console",
    workerId: event.sessionId,
    toolName: "execution_command",
    toolCallId: event.id,
    phase: "call",
    input: {
      command: event.command,
      cwd: event.cwd,
      source: event.source,
      verdict: event.verdict,
    },
    content: event.outputPreview,
    isError: event.verdict === "blocked",
    reason: event.blockedReason,
  });

  return event;
}

/** 追加输出（非 PTY 模式下无法精确判定命令结束，按流累积）。 */
export function appendOutput(id: string, text: string): void {
  const event = events.find((e) => e.id === id);
  if (!event) return;
  event.outputPreview = clip((event.outputPreview ?? "") + text);
}

/** 命令执行结束后回填结果。 */
export function complete(id: string, patch: { endedAt?: string; exitCode?: number; outputPreview?: string }): void {
  const event = events.find((e) => e.id === id);
  if (!event) return;
  if (patch.endedAt) event.endedAt = patch.endedAt;
  if (patch.exitCode !== undefined) event.exitCode = patch.exitCode;
  if (patch.outputPreview !== undefined) event.outputPreview = clip(patch.outputPreview);
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

export function list(input?: ExecutionListInput): ExecutionEvent[] {
  let result = events;

  if (input?.sessionId) {
    result = result.filter((e) => e.sessionId === input.sessionId);
  }
  if (input?.source) {
    result = result.filter((e) => e.source === input.source);
  }

  // 最新在前
  result = [...result].reverse();
  if (input?.limit && input.limit > 0) {
    result = result.slice(0, input.limit);
  }
  return result;
}

function clip(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length > OUTPUT_PREVIEW_LIMIT
    ? trimmed.slice(-OUTPUT_PREVIEW_LIMIT)
    : trimmed;
}
