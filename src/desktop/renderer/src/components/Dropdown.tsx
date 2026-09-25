import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * 轻量下拉菜单。
 *
 * 菜单通过 Portal 渲染到 <body> 并用 fixed 定位 —— 这一层是必须的：
 * 若以 absolute 嵌在 trigger 容器内，任意祖先的 backdrop-filter / transform /
 * overflow / 层叠上下文都会导致菜单被裁剪或被页面内容盖住
 * （曾复现：顶栏 backdrop-blur 创建层叠上下文，身份切换菜单被 <main> 里的
 *   absolute/relative 元素压住，点击好像没反应）。
 *
 * Portal 之后，无论嵌在哪个容器里，菜单都挂在最顶层：
 *   z 60 > Modal(50) > 顶栏(40)，< Toast(100)。
 */

interface DropdownProps {
  trigger: (open: boolean) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  widthClass?: string;
}

interface MenuPos {
  top: number;
  maxH: number;
  left?: number;
  right?: number;
}

export default function Dropdown({
  trigger,
  children,
  align = "right",
  widthClass = "w-56",
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<MenuPos | null>(null);

  // 依据 trigger 的实际位置计算菜单停靠（fixed 相对视口）
  const updatePos = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    // 下方空间不足时向上弹出，避免菜单溢出视口
    const flip = spaceBelow < 240;
    const top = flip ? Math.max(8, rect.top - 8) : rect.bottom + 6;
    const maxH = flip
      ? Math.max(120, rect.top - 24)
      : Math.max(120, window.innerHeight - top - 16);
    setPos({
      top,
      maxH,
      ...(align === "right"
        ? { right: Math.max(8, window.innerWidth - rect.right) }
        : { left: Math.max(8, rect.left) }),
    });
  }, [align]);

  useLayoutEffect(() => {
    if (open) updatePos();
  }, [open, updatePos]);

  useEffect(() => {
    if (!open) return;

    // 滚动 / 缩放时保持菜单跟随 trigger（scroll 用 capture，含内部滚动容器）
    const onMove = () => updatePos();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);

    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);

    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, updatePos]);

  return (
    <div className="relative" ref={wrapRef}>
      <div onClick={() => setOpen((v) => !v)}>{trigger(open)}</div>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{ position: "fixed", top: pos.top, zIndex: 60, maxHeight: pos.maxH, ...(align === "right" ? { right: pos.right } : { left: pos.left }) }}
            className={`${widthClass} max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border border-line-strong bg-elevated shadow-2xl py-1 animate-in`}
          >
            {children(() => setOpen(false))}
          </div>,
          document.body,
        )}
    </div>
  );
}

interface MenuItemProps {
  icon?: ReactNode;
  label: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** 右侧补充内容（如快捷键、当前值） */
  hint?: ReactNode;
  active?: boolean;
}

export function MenuItem({ icon, label, onClick, danger, disabled, hint, active }: MenuItemProps) {
  return (
    <button
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-3 py-2 text-[12px] text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        danger
          ? "text-fg-subtle hover:text-red hover:bg-red-bg"
          : active
            ? "text-fg bg-n-800/70"
            : "text-fg-muted hover:text-fg hover:bg-n-800/70"
      }`}
    >
      {icon && <span className="shrink-0 opacity-80">{icon}</span>}
      <span className="truncate flex-1">{label}</span>
      {hint && <span className="shrink-0 text-[10.5px] text-fg-faint">{hint}</span>}
    </button>
  );
}

export function MenuDivider() {
  return <div className="my-1 h-px bg-line" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-faint">
      {children}
    </div>
  );
}
