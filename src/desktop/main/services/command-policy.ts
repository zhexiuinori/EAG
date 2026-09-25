// 命令策略已上移到治理层（src/extension/command-policy.ts），
// 使 Pi 扩展与平台终端共用同一套规则。此处保留 re-export 以兼容既有 import。

export {
  BLOCK_PATTERNS,
  inspectCommand,
} from "../../../extension/command-policy.ts";

export type { CommandVerdict } from "../../../extension/command-policy.ts";
