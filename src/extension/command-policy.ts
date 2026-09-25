/**
 * 命令策略 —— 治理层核心。
 *
 * 放在 extension/ 而不是 desktop/ 下，是为了让两处共用同一套规则：
 *   · Pi 引擎：extension/command-gate.ts 在 tool_call 阶段拦截
 *   · 平台终端：desktop/main/services/terminal-api.ts 在执行前拦截
 *
 * 独立成文件且不依赖任何运行时，便于直接测试。
 */

export interface CommandVerdict {
  blocked: boolean;
  reason?: string;
}

/**
 * 高危命令黑名单。命中即拒绝执行并记审计。
 * 这是"治理型执行平台"相对普通内嵌终端的核心控制点。
 */
export const BLOCK_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /rm\s+(-[rRfF]+\s+)*[/\\~](\s|$)/, reason: "禁止删除根目录" },
  { re: /rm\s+-rf\s+\*/, reason: "禁止递归删除通配符" },
  { re: /mkfs(\.[a-z0-9]+)?\b/i, reason: "禁止格式化文件系统" },
  { re: /\bformat\s+[a-zA-Z]:/i, reason: "禁止格式化磁盘" },
  { re: /del\s+\/[fFqQsS]/i, reason: "禁止 del 强制删除" },
  { re: /shutdown(\.exe)?\s/i, reason: "禁止关机命令" },
  { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/, reason: "禁止 fork 炸弹" },
  { re: /curl\s+[^\s]+\s*\|\s*(ba)?sh/i, reason: "禁止远程脚本直执行" },
  { re: /wget\s+[^\s]+\s*\|\s*(ba)?sh/i, reason: "禁止远程脚本直执行" },
];

export function inspectCommand(command: string): CommandVerdict {
  for (const p of BLOCK_PATTERNS) {
    if (p.re.test(command)) return { blocked: true, reason: p.reason };
  }
  return { blocked: false };
}
