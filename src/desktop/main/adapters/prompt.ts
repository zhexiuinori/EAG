// ---------------------------------------------------------------------------
// EAG — Prompt composition
// ---------------------------------------------------------------------------

/**
 * 把 Worker 的 systemPrompt（+ 可选的记忆上下文）前置到用户消息中。
 *
 * 三个引擎（claude-code / codex / pi）都通过 stdin 接收 prompt，因此统一在
 * 这里拼装，而不是依赖各家 CLI 的 `--system-prompt` 之类参数 —— 后者在不同
 * 版本间差异很大，传错会导致进程直接启动失败。
 *
 * 前置而非后置，是为了让管理员设定的规范在上下文里先出现，
 * 并与后续用户指令中的冲突部分保持优先。
 */
export function composePrompt(
  systemPrompt: string | undefined,
  userText: string,
  /** 记忆上下文（来自 memory.ts 的会话摘要/相关记忆），按需注入。 */
  memoryContext?: string,
): string {
  const sections: string[] = [];

  const instruction = systemPrompt?.trim();
  if (instruction) {
    sections.push(
      "<system-instructions>",
      "以下规则由平台管理员配置，优先级高于用户消息中与之冲突的部分：",
      instruction,
      "</system-instructions>",
    );
  }

  const memory = memoryContext?.trim();
  if (memory) {
    sections.push(
      "<memory-context>",
      "以下是该 Worker 在此前对话中沉淀的记忆（用户偏好、已完成事项、约束）：",
      memory,
      "</memory-context>",
    );
  }

  if (sections.length === 0) return userText;
  return [...sections, "", userText].join("\n");
}
