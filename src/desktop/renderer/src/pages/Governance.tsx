import { useCallback, useEffect, useState } from "react";
import * as ipc from "../lib/ipc.ts";
import PageShell from "../components/PageShell.tsx";
import StatCard from "../components/StatCard.tsx";
import EmptyState from "../components/EmptyState.tsx";
import Button from "../components/Button.tsx";
import {
  IconShield, IconGauge, IconNetwork, IconAlert, IconCheck, IconList,
} from "../components/icons.tsx";
import type { DelegationRecord } from "@shared/types.ts";

interface Summary {
  workers: Array<{ id: string; name: string; spentUsd: number; budgetLimitUsd?: number }>;
  blockedToday: number;
  guardrailToday: number;
  egress: { enforced: boolean; endpoints: string[] };
  sandboxMode: "local" | "docker";
  audit: { valid: boolean; checked: number };
}

/** 委派状态 → 圆点色 + 文案 */
const DELEG_STATUS: Record<DelegationRecord["status"], { dot: string; label: string }> = {
  queued: { dot: "bg-n-600", label: "排队" },
  running: { dot: "bg-primary", label: "执行中" },
  done: { dot: "bg-green", label: "完成" },
  error: { dot: "bg-red", label: "失败" },
};

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / 日期 */
function fmtAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * 治理总览仪表盘。
 *
 * 让治理状态"一目了然"（而不是散落在各页的黑箱）：
 *   · 今日拦截 / 内容护栏命中
 *   · 出网管控状态
 *   · 沙箱模式
 *   · 审计完整性
 *   · 各 Worker 预算消耗与归因
 *   · 子 Agent 委派时间线（Agent 之间把活分给了谁、结果如何）
 */
export default function Governance() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [delegations, setDelegations] = useState<DelegationRecord[]>([]);
  const [dLoading, setDLoading] = useState(true);
  const [dError, setDError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    ipc.governanceSummary()
      .then((s) => { if (alive) setSummary(s); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const loadDelegations = useCallback(() => {
    setDLoading(true);
    ipc.delegationList()
      .then((r) => { setDelegations(r.delegations ?? []); setDError(null); })
      .catch((e) => setDError(e instanceof Error ? e.message : String(e)))
      .finally(() => setDLoading(false));
  }, []);

  useEffect(() => { loadDelegations(); }, [loadDelegations]);

  const totalBudget = summary?.workers.reduce((a, w) => a + (w.spentUsd ?? 0), 0) ?? 0;

  return (
    <PageShell
      title="治理总览"
      description="一目了然的治理状态快照"
      scroll={false}
    >
      <div className="flex flex-col h-full gap-4">
        {error && (
          <div className="px-3 py-2 rounded-lg bg-red-bg border border-red/30 text-[11.5px] text-red">{error}</div>
        )}

        {/* 概览 */}
        <div className="shrink-0 grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard label="今日拦截" value={loading ? "—" : summary?.blockedToday ?? 0}
            tone={(summary?.blockedToday ?? 0) > 0 ? "warn" : "default"}
            hint="策略阻断的命令/写入" icon={<IconShield size={13} />} />
          <StatCard label="护栏命中" value={loading ? "—" : summary?.guardrailToday ?? 0}
            tone={(summary?.guardrailToday ?? 0) > 0 ? "danger" : "default"}
            hint="疑似泄露敏感内容" icon={<IconAlert size={13} />} />
          <StatCard label="累计预算" value={loading ? "—" : `$${totalBudget.toFixed(2)}`}
            hint="所有 Worker 消耗" icon={<IconGauge size={13} />} />
          <StatCard label="审计完整性" value={loading ? "—" : summary?.audit.checked ?? 0}
            tone={summary?.audit.valid ? "ok" : "danger"}
            hint={summary?.audit.valid ? "哈希链校验通过" : "校验受损"} icon={<IconCheck size={13} />} />
        </div>

        {/* 管控状态 */}
        <div className="shrink-0 grid grid-cols-1 md:grid-cols-3 gap-3">
          {/* 出网管控 */}
          <div className="card p-4">
            <div className="flex items-center gap-1.5 mb-2">
              <IconNetwork size={13} className="text-fg-faint" />
              <h2 className="text-[12.5px] font-semibold text-fg-muted">出网管控</h2>
            </div>
            <div className="text-[11px] space-y-1">
              <div className="flex items-center gap-2">
                <span className={`w-1.5 h-1.5 rounded-full ${summary?.egress.enforced ? "bg-green" : "bg-yellow"}`} />
                <span>{summary?.egress.enforced ? "已强制拦截" : "仅告警（未强制）"}</span>
              </div>
              <div className="text-fg-faint">
                白名单 {summary?.egress.endpoints.length ?? 0} 个端点
              </div>
              <div className="font-mono text-[10px] text-fg-faint truncate" title={(summary?.egress.endpoints ?? []).join(", ")}>
                {(summary?.egress.endpoints ?? []).join(", ") || "未配置（默认放行）"}
              </div>
            </div>
          </div>

          {/* 沙箱模式 */}
          <div className="card p-4">
            <div className="flex items-center gap-1.5 mb-2">
              <IconShield size={13} className="text-fg-faint" />
              <h2 className="text-[12.5px] font-semibold text-fg-muted">沙箱</h2>
            </div>
            <div className="text-[11px] space-y-1">
              <div className="flex items-center gap-2">
                <span className={`w-1.5 h-1.5 rounded-full ${summary?.sandboxMode === "docker" ? "bg-green" : "bg-yellow"}`} />
                <span>{summary?.sandboxMode === "docker" ? "Docker 隔离" : "本地（无隔离）"}</span>
              </div>
              <div className="text-fg-faint">
                {summary?.sandboxMode === "docker" ? "Agent 跑在隔离容器" : "Agent 直接跑在项目目录（Docker 隔离待接入）"}
              </div>
            </div>
          </div>

          {/* 审计完整性 */}
          <div className="card p-4">
            <div className="flex items-center gap-1.5 mb-2">
              <IconList size={13} className="text-fg-faint" />
              <h2 className="text-[12.5px] font-semibold text-fg-muted">审计</h2>
            </div>
            <div className="text-[11px] space-y-1">
              <div className="flex items-center gap-2">
                <span className={`w-1.5 h-1.5 rounded-full ${summary?.audit.valid ? "bg-green" : "bg-red"}`} />
                <span>{summary?.audit.valid ? "哈希链完整" : "完整性受损"}</span>
              </div>
              <div className="text-fg-faint">已校验 {summary?.audit.checked ?? 0} 条今日记录</div>
            </div>
          </div>
        </div>

        {/* 预算归因 + 委派时间线（并列，各自滚动） */}
        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="min-h-0 card overflow-auto">
          <div className="px-4 py-3 border-b border-line">
            <h2 className="text-[12.5px] font-semibold text-fg-muted">Worker 预算归因</h2>
          </div>
          {loading ? (
            <div className="px-4 py-8 text-center text-[11.5px] text-fg-faint">加载中…</div>
          ) : (summary?.workers?.length ?? 0) === 0 ? (
            <EmptyState compact icon={<IconGauge size={16} />} title="还没有 Worker" description="创建 Worker 并分配后，这里会显示各自的预算消耗。" />
          ) : (
            <div className="divide-y divide-line">
              {summary?.workers.map((w) => {
                const over = w.budgetLimitUsd != null && w.spentUsd >= w.budgetLimitUsd;
                return (
                  <div key={w.id} className="flex items-center gap-3 px-4 py-2.5 text-[12px]">
                    <span className="flex-1 text-fg-muted truncate">{w.name || w.id}</span>
                    {w.budgetLimitUsd != null && (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${over ? "bg-red-bg text-red" : "bg-n-850 border border-line text-fg-subtle"}`}>
                        {over ? "超限" : "限额"}
                      </span>
                    )}
                    <span className={`font-mono shrink-0 ${over ? "text-red" : "text-green"}`}>
                      ${w.spentUsd.toFixed(4)}
                    </span>
                    {w.budgetLimitUsd != null && (
                      <span className="font-mono text-fg-faint shrink-0">/ ${w.budgetLimitUsd}</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 子 Agent 委派时间线：谁把活分给了谁、第几层、结果如何 */}
        <div className="min-h-0 card overflow-auto">
          <div className="px-4 py-3 border-b border-line flex items-center justify-between">
            <h2 className="text-[12.5px] font-semibold text-fg-muted">子 Agent 委派</h2>
            <Button size="sm" variant="ghost" onClick={loadDelegations} disabled={dLoading}>
              {dLoading ? "加载中…" : "刷新"}
            </Button>
          </div>
          {dError ? (
            <div className="px-4 py-3 text-[11px] text-red">{dError}</div>
          ) : !dLoading && delegations.length === 0 ? (
            <EmptyState
              compact
              icon={<IconNetwork size={16} />}
              title="还没有委派记录"
              description="Agent 通过 agents__delegate 把子任务交给另一个 Agent 时，这里会显示完整轨迹。"
            />
          ) : (
            <div className="divide-y divide-line">
              {delegations.map((d) => {
                const st = DELEG_STATUS[d.status] ?? DELEG_STATUS.queued;
                return (
                  <div key={d.id} className="px-4 py-2.5">
                    <div className="flex items-center gap-2 text-[11.5px]">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${st.dot}`} title={st.label} />
                      <span className="text-fg-muted truncate max-w-[35%]">{d.fromWorkerName ?? d.fromWorkerId ?? "外部"}</span>
                      <span className="text-fg-faint shrink-0">→</span>
                      <span className="text-fg-muted truncate max-w-[35%]">{d.targetName ?? d.target}</span>
                      {d.depth > 0 && (
                        <span className="text-[9.5px] px-1 py-0.5 rounded bg-n-850 border border-line text-fg-faint shrink-0" title={`委派第 ${d.depth} 层`}>
                          L{d.depth}
                        </span>
                      )}
                      <span className="flex-1" />
                      <span className={`text-[10px] shrink-0 ${d.status === "error" ? "text-red" : "text-fg-faint"}`}>{st.label}</span>
                      <span className="text-[10px] text-fg-faint shrink-0">{fmtAgo(d.createdAt)}</span>
                    </div>
                    <div className="mt-1 text-[10.5px] text-fg-faint line-clamp-2 whitespace-pre-wrap break-words">{d.prompt}</div>
                    {d.status === "done" && d.outputPreview && (
                      <div className="mt-1 text-[10.5px] text-fg-subtle line-clamp-2 whitespace-pre-wrap break-words bg-n-900/60 rounded px-2 py-1">
                        {d.outputPreview}
                      </div>
                    )}
                    {d.status === "error" && d.error && (
                      <div className="mt-1 text-[10.5px] text-red/90 line-clamp-2 whitespace-pre-wrap break-words">{d.error}</div>
                    )}
                    <div className="mt-1 flex items-center gap-2 text-[9.5px] text-fg-faint">
                      <span>{d.fromUserId}</span>
                      {d.durationMs != null && <span>· {(d.durationMs / 1000).toFixed(1)}s</span>}
                      <span className="truncate">· {d.id}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        </div>
      </div>
    </PageShell>
  );
}
