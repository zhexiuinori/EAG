/**
 * Claude Code —— PreToolUse hook
 *
 * 由 claude -p 通过 --settings 的 hooks 配置调用（需 EAG_CLAUDE_HOOKS=1）。
 * 约定：
 *   · stdin 收到本次工具调用的 JSON
 *   · exit 0 = 放行
 *   · exit 2 = 阻断，stderr 内容会反馈给模型（让它知道为什么被拒绝）
 *
 * 规则复用治理层的 command-policy，与 Pi 扩展、平台终端完全一致。
 */

import { inspectCommand } from "../../../extension/command-policy.ts";

interface HookInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { command?: string } | unknown;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}

async function main(): Promise<void> {
  // 任何异常都放行：治理 hook 不应让 Agent 整体不可用
  let input: HookInput;
  try {
    const raw = await readStdin();
    if (!raw) process.exit(0);
    input = JSON.parse(raw) as HookInput;
  } catch {
    process.exit(0);
  }

  if (input.tool_name !== "Bash") process.exit(0);

  const toolInput = input.tool_input as { command?: string } | undefined;
  const command = typeof toolInput?.command === "string" ? toolInput.command.trim() : "";
  if (!command) process.exit(0);

  const verdict = inspectCommand(command);
  if (verdict.blocked) {
    process.stderr.write(`[EAG 命令策略] ${verdict.reason}：${command}`);
    process.exit(2);
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
