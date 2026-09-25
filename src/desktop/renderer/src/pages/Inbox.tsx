import { useEffect, useMemo, useState } from "react";
import PageShell from "../components/PageShell.tsx";
import Button from "../components/Button.tsx";
import StatCard from "../components/StatCard.tsx";
import EmptyState from "../components/EmptyState.tsx";
import { useToast } from "../components/Toast.tsx";
import { useApprovalStore } from "../stores/approvalStore.ts";
import { IconInbox, IconCheck, IconX, IconAlert } from "../components/icons.tsx";
import type { ApprovalRecord } from "@shared/types.ts";

/**
 * 审批中心（参考 QwenPaw 的 Inbox + ApprovalCard）。
 *
 * Agent 的写操作被策略拒绝时（见 extension/fs-gate.ts）会挂起并在此出现；
 * 管理员批准则本次调用放行，拒绝或超时则维持阻断。批准只对本次调用生效，
 * 不会改动策略 —— 策略变更仍走 Policy 页。
 */

/** 与服务端一致的待决超时（仅用于倒计时展示）。 */
const PENDING_TTL_MS = 5 * 60_000;

export default function Inbox() {
  const approvals = useApprovalStore((s) => s.approvals);
  const load = useApprovalStore((s) => s.load);
  const decide = useApprovalStore((s) => s.decide);
  const toast = useToast();

  const [filter, setFilter] = useState<"pending" | "all">("pending");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);

  useEffect(() => {
    void load();
    const iv = setInterval(() => { void load(); }, 5000);
    return () => clearInterval(iv);
  }, [load]);

  // 倒计时每秒刷新
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);

  const pending = useMemo(() => approvals.filter((a) => a.status === "pending"), [approvals]);
  const shown = filter === "pending" ? pending : approvals;

  // 待批列表变化（轮询/事件）时，清掉已不在待批中的勾选项
  useEffect(() => {
    const pendingIds = new Set(pending.map((a) => a.id));
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => pendingIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [pending]);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allPendingSelected = pending.length > 0 && pending.every((a) => selected.has(a.id));
  const toggleSelectAll = () => {
    setSelected(allPendingSelected ? new Set() : new Set(pending.map((a) => a.id)));
  };

  const handleBatchDecide = async (ok: boolean) => {
    const ids = pending.filter((a) => selected.has(a.id)).map((a) => a.id);
    if (ids.length === 0) return;
    setBatchBusy(true);
    let succeeded = 0;
    let failed = 0;
    try {
      for (const id of ids) {
        try {
          const done = await decide(id, ok);
          if (done) succeeded++;
          else failed++;
        } catch {
          failed++;
        }
      }
      if (failed === 0) toast.success(`已批量${ok ? "批准" : "拒绝"} ${succeeded} 条请求`);
      else toast.error(`批量${ok ? "批准" : "拒绝"}完成：成功 ${succeeded} 条，失败 ${failed} 条（可能已超时）`);
      setSelected(new Set());
    } finally {
      setBatchBusy(false);
    }
  };

  const approved = approvals.filter((a) => a.status === "approved").length;
  const denied = approvals.filter((a) => a.status === "denied").length;
  const expired = approvals.filter((a) => a.status === "expired").length;

  const handleDecide = async (rec: ApprovalRecord, ok: boolean) => {
    setBusyId(rec.id);
    try {
      const done = await decide(rec.id, ok);
      if (done) toast.success(ok ? "已批准，Agent 将继续执行本次操作" : "已拒绝");
      else toast.error("决策失败：请求可能已超时");
    } catch (e) {
      toast.error(`决策失败：${e}`);
    } finally {
      setBusyId(null);
    }
  };

  const remainSec = (ts: string) =>
    Math.max(0, Math.round((PENDING_TTL_MS - (now - new Date(ts).getTime())) / 1000));

  return (
    <PageShell
      title="Inbox"
      description="被策略拒绝的写操作在此挂起，等待你裁决是否放行"
      scroll={false}
    >
      <div className="flex flex-col h-full gap-4">
        {/* 概览 */}
        <div className="shrink-0 grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard
            label="待批"
            value={pending.length}
            tone={pending.length > 0 ? "warn" : "default"}
            hint="Agent 正在等待"
            icon={<IconInbox size={13} />}
          />
          <StatCard label="已批准" value={approved} tone="ok" icon={<IconCheck size={13} />} />
          <StatCard label="已拒绝" value={denied} icon={<IconX size={13} />} />
          <StatCard label="已超时" value={expired} hint="超时自动拒绝" icon={<IconAlert size={13} />} />
        </div>

        {/* 筛选 + 批量操作 */}
        <div className="shrink-0 flex items-center gap-1.5 flex-wrap">
          {([["pending", "待批"], ["all", "全部记录"]] as const).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setFilter(k)}
              className={`px-2.5 py-1 rounded-lg text-[11.5px] border transition-colors ${
                filter === k
                  ? "bg-primary-bg text-primary border-primary-border"
                  : "text-fg-subtle hover:text-fg-muted border-transparent"
              }`}
            >
              {label}
            </button>
          ))}
          {pending.length > 0 && (
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={toggleSelectAll}
                className="px-2.5 py-1 rounded-lg text-[11.5px] border border-transparent text-fg-subtle hover:text-fg-muted transition-colors"
              >
                {allPendingSelected ? "取消全选" : "全选待批"}
              </button>
              {selected.size > 0 && (
                <>
                  <span className="text-[11px] text-fg-faint">已选 {selected.size} 条</span>
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<IconCheck size={12} />}
                    disabled={batchBusy}
                    onClick={() => void handleBatchDecide(true)}
                  >
                    批量批准
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    icon={<IconX size={12} />}
                    disabled={batchBusy}
                    onClick={() => void handleBatchDecide(false)}
                  >
                    批量拒绝
                  </Button>
                </>
              )}
            </div>
          )}
        </div>

        {/* 列表 */}
        <div className="flex-1 min-h-0 overflow-y-auto space-y-2">
          {shown.length === 0 ? (
            <div className="card">
              <EmptyState
                icon={<IconInbox size={18} />}
                title={filter === "pending" ? "没有待批的请求" : "还没有审批记录"}
                description="当 Agent 的写操作被策略拒绝并触发审批时，会出现在这里。"
              />
            </div>
          ) : (
            shown.map((rec) => {
              const isPending = rec.status === "pending";
              const secs = isPending ? remainSec(rec.ts) : 0;
              return (
                <div key={rec.id} className={`card p-4 ${isPending ? "!border-yellow/40" : ""}`}>
                  <div className="flex items-center gap-2 flex-wrap">
                    {isPending && (
                      <input
                        type="checkbox"
                        checked={selected.has(rec.id)}
                        onChange={() => toggleSelect(rec.id)}
                        disabled={batchBusy}
                        title="选择以批量处理"
                        className="shrink-0 accent-primary cursor-pointer"
                      />
                    )}
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                      rec.access === "read-only" ? "bg-blue-bg text-blue" : "bg-red-bg text-red"
                    }`}>
                      {rec.access === "read-only" ? "只读路径写入" : "不可见路径写入"}
                    </span>
                    <span className="text-[11.5px] font-mono text-fg-muted">{rec.toolName}</span>
                    <span className="ml-auto text-[10.5px] text-fg-faint tabular-nums">
                      {new Date(rec.ts).toLocaleTimeString()}
                    </span>
                    {isPending ? (
                      <span className={`text-[10.5px] tabular-nums ${secs <= 15 ? "text-red" : "text-yellow"}`}>
                        {secs}s 后超时
                      </span>
                    ) : (
                      <span className={`text-[10.5px] font-medium ${
                        rec.status === "approved"
                          ? "text-green"
                          : rec.status === "denied"
                            ? "text-red"
                            : "text-fg-faint"
                      }`}>
                        {rec.status === "approved" ? "已批准" : rec.status === "denied" ? "已拒绝" : "已超时"}
                      </span>
                    )}
                  </div>

                  <div className="mt-2 font-mono text-[11.5px] text-fg-subtle break-all">{rec.path}</div>
                  {rec.reason && <div className="mt-1 text-[10.5px] text-fg-faint">{rec.reason}</div>}

                  {isPending && (
                    <div className="mt-3 flex items-center gap-2">
                      <Button
                        variant="primary"
                        size="sm"
                        icon={<IconCheck size={12} />}
                        disabled={busyId === rec.id}
                        onClick={() => void handleDecide(rec, true)}
                      >
                        批准这一次
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        icon={<IconX size={12} />}
                        disabled={busyId === rec.id}
                        onClick={() => void handleDecide(rec, false)}
                      >
                        拒绝
                      </Button>
                      <span className="ml-auto text-[10px] text-fg-faint">
                        批准仅对本次调用生效，不改动策略
                      </span>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </PageShell>
  );
}
