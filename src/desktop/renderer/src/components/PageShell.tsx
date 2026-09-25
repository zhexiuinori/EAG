import type { ReactNode } from "react";

interface Props {
  title: string;
  description?: string;
  /** 右上角操作区 */
  actions?: ReactNode;
  children: ReactNode;
  /**
   * true（默认）— 内容随页面滚动，适合表单/卡片流
   * false        — 内容区固定，由子元素自行滚动（表格/多段布局）
   */
  scroll?: boolean;
}

/**
 * 页面骨架：页头固定 + 内容区包成独立卡片。
 *
 * 内容区这层"圆角 + 边框 + 独立滚动"的容器，是管理后台显得有结构感的关键——
 * 相比把内容直接铺在背景上，视觉上多了一层明确的承载关系。
 */
export default function PageShell({ title, description, actions, children, scroll = true }: Props) {
  return (
    <div className="page-container">
      <header className="page-header flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[16px] font-semibold text-fg tracking-tight truncate">{title}</h1>
          {description && (
            <p className="text-[12px] text-fg-subtle mt-1 truncate">{description}</p>
          )}
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </header>

      <div
        className={`page-body p-5 ${
          scroll ? "" : "!overflow-hidden flex flex-col"
        }`}
      >
        {children}
      </div>
    </div>
  );
}
