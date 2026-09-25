/**
 * command-gate：在 tool_call 阶段拦截高危命令。
 *
 * 与 fs-gate（文件路径）并列，共同构成治理扩展的执行门禁。
 * 拦截返回 { block: true, reason }，Pi 会拒绝该次工具调用并把 reason
 * 反馈给模型，因此 Agent 知道"为什么被拒绝"，而不是静默失败。
 */

import type {
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { inspectCommand } from "./command-policy.ts";

/** 会产生命令执行的工具。 */
const COMMAND_TOOLS = new Set(["bash", "powershell", "exec", "shell", "terminal"]);

/** 从工具入参提取命令文本（各家 CLI 字段名不同）。 */
function extractCommand(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const rec = input as Record<string, unknown>;
  for (const key of ["command", "cmd", "script"]) {
    const value = rec[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function createCommandGateHandler() {
  return (event: ToolCallEvent, _ctx: ExtensionContext): ToolCallEventResult | void => {
    if (!COMMAND_TOOLS.has(event.toolName)) return;

    const command = extractCommand(event.input);
    if (!command) return;

    const verdict = inspectCommand(command);
    if (verdict.blocked) {
      return {
        block: true,
        reason: `[EAG 命令策略] ${verdict.reason}：${command}`,
      };
    }

    return undefined;
  };
}
