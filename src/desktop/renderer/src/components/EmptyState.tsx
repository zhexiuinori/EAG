import type { ReactNode } from "react";

/**
 * 统一空状态。此前 8 个页面各写一份"图标 + 标题 + 描述"的居中块，
 * 尺寸与文案风格不一。集中后各页只描述"缺什么、下一步做什么"。
 */

interface Props {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  /** 紧凑模式：用于列表/卡片内部的局部空态 */
  compact?: boolean;
  className?: string;
}

export default function EmptyState({ icon, title, description, action, compact, className = "" }: Props) {
  return (
    <div className={`flex flex-col items-center justify-center text-center ${compact ? "px-4 py-8" : "px-6 py-14"} ${className}`}>
      {icon && (
        <div className={`${compact ? "size-9" : "size-11"} rounded-xl bg-n-850 border border-line flex items-center justify-center mb-3 text-fg-faint`}>
          {icon}
        </div>
      )}
      <p className="text-[12.5px] font-medium text-fg-muted">{title}</p>
      {description && <p className="mt-1 text-[11.5px] text-fg-faint max-w-sm leading-relaxed">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
