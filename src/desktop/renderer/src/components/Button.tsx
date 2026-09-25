import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "default" | "ghost" | "danger";
type Size = "sm" | "md";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  children?: ReactNode;
}

const VARIANT: Record<Variant, string> = {
  primary:
    "bg-primary-strong hover:bg-primary text-white border-transparent shadow-[0_1px_2px_rgba(0,0,0,0.25)]",
  default:
    "bg-n-850/70 hover:bg-n-800 text-fg-muted hover:text-fg border-line hover:border-line-strong",
  ghost:
    "bg-transparent hover:bg-n-850/60 text-fg-subtle hover:text-fg-muted border-transparent",
  danger:
    "bg-transparent hover:bg-red-bg text-fg-subtle hover:text-red border-line hover:border-red/40",
};

const SIZE: Record<Size, string> = {
  sm: "h-7 px-2.5 text-[11.5px] gap-1 rounded-md",
  md: "h-8 px-3 text-[12px] gap-1.5 rounded-lg",
};

/** 统一按钮。此前每个页面各写一套 px/py/rounded/颜色组合。 */
export default function Button({
  variant = "default",
  size = "md",
  icon,
  children,
  className = "",
  ...rest
}: Props) {
  return (
    <button
      {...rest}
      className={`inline-flex items-center justify-center font-medium border transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed ${VARIANT[variant]} ${SIZE[size]} ${className}`}
    >
      {icon}
      {children}
    </button>
  );
}
