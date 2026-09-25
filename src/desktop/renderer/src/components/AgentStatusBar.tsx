import { IconSparkle, IconStop } from "./icons.tsx";

interface Props {
  /** 助手名称 */
  name: string;
  /** 当前使用的模型（如 "Claude · Opus"） */
  model?: string;
  /** 是否正在生成 */
  running: boolean;
  /** 正在做什么的简要描述，如 "编辑 src/foo.ts" */
  currentAction?: string;
  /** 停止当前生成 */
  onStop?: () => void;
  /** 累计花费（USD） */
  spentUsd?: number;
  /** 预算上限（USD） */
  budgetLimitUsd?: number;
}

/**
 * Agent 状态条：让用户一眼看到"这个助手是谁、用哪个模型、正在干什么、花到多少钱"。
 * 放在会话内容区顶部，与聊天流解耦，不依赖消息数据，保证任何 tab 下都可见。
 */
export default function AgentStatusBar({
  name,
  model,
  running,
  currentAction,
  onStop,
  spentUsd,
  budgetLimitUsd,
}: Props) {
  const isOverBudget =
    budgetLimitUsd != null && spentUsd != null && spentUsd >= budgetLimitUsd;

  return (
    <div className="shrink-0 mx-5 mt-2 rounded-xl border border-line bg-n-900/70 px-3.5 py-2.5 flex items-center gap-3">
      {/* 助手身份 */}
      <div className="flex items-center gap-2 min-w-0">
        <div className="size-7 rounded-lg bg-gradient-to-br from-primary to-primary-strong flex items-center justify-center shrink-0 brand-glow">
          <IconSparkle size={14} className="text-white" />
        </div>
        <div className="min-w-0">
          <div className="text-[12.5px] font-medium text-fg truncate leading-tight">{name}</div>
          {model && (
            <div className="text-[10.5px] text-fg-faint truncate leading-tight">模型 · {model}</div>
          )}
        </div>
      </div>

      <div className="h-6 w-px bg-line" />

      {/* 运行状态 */}
      <div className="flex items-center gap-1.5 shrink-0">
        <span className="relative flex items-center justify-center shrink-0">
          <span className={`w-1.5 h-1.5 rounded-full ${running ? "bg-green" : "bg-n-600"}`} />
          {running && <span className="absolute w-1.5 h-1.5 rounded-full bg-green animate-breathe-soft" />}
        </span>
        <span className={`text-[11px] font-medium ${running ? "text-green" : "text-fg-faint"}`}>
          {running ? "处理中" : "空闲"}
        </span>
      </div>

      {/* 正在做什么 */}
      <div className="flex-1 min-w-0">
        <div className="text-[11px] text-fg-subtle truncate">
          {running
            ? currentAction
              ? currentAction
              : "正在思考…"
            : "等待任务"}
        </div>
      </div>

      {/* 预算 */}
      {(spentUsd != null || budgetLimitUsd != null) && (
        <div className="shrink-0 text-[10.5px] font-mono">
          <span className={isOverBudget ? "text-red" : "text-fg-faint"}>
            ${(spentUsd ?? 0).toFixed(4)}
          </span>
          {budgetLimitUsd != null && (
            <span className="text-fg-faint"> / ${budgetLimitUsd}</span>
          )}
        </div>
      )}

      {/* 停止 */}
      {running && onStop && (
        <button
          onClick={onStop}
          title="停止生成"
          className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-md bg-n-850 border border-line hover:border-red/40 hover:bg-red-bg text-fg-muted hover:text-red text-[11px] font-medium transition-colors"
        >
          <IconStop size={11} />
          停止
        </button>
      )}
    </div>
  );
}
