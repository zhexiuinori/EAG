import type { ReactNode } from "react";

export type StatTone = "default" | "ok" | "warn" | "danger";

interface Props {
  label: string;
  value: string | number;
  hint?: string;
  tone?: StatTone;
  /** 可选图标（传 <IconXxx size={13} />） */
  icon?: ReactNode;
}

const TONE_TEXT: Record<StatTone, string> = {
  default: "text-fg",
  ok: "text-green",
  warn: "text-yellow",
  danger: "text-red",
};

const TONE_ICON: Record<StatTone, string> = {
  default: "text-fg-faint",
  ok: "text-green/70",
  warn: "text-yellow/70",
  danger: "text-red/70",
};

/** 概览统计卡。Workspace / Workers / Audit 共用，保证视觉一致。 */
export default function StatCard({ label, value, hint, tone = "default", icon }: Props) {
  return (
    <div className="card card-hover px-4 py-3.5 animate-in">
      <div className="flex items-center gap-1.5 mb-2">
        {icon && <span className={`shrink-0 ${TONE_ICON[tone]}`}>{icon}</span>}
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint truncate">
          {label}
        </span>
      </div>
      <div className={`text-[26px] font-semibold tabular-nums leading-none ${TONE_TEXT[tone]}`}>
        {value}
      </div>
      {hint && <div className="mt-1.5 text-[10.5px] text-fg-faint truncate">{hint}</div>}
    </div>
  );
}
