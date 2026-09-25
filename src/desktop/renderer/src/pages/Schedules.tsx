import { useCallback, useEffect, useState } from "react";
import * as ipc from "../lib/ipc.ts";
import PageShell from "../components/PageShell.tsx";
import Button from "../components/Button.tsx";
import EmptyState from "../components/EmptyState.tsx";
import { Modal, ConfirmModal } from "../components/Modal.tsx";
import { useToast } from "../components/Toast.tsx";
import { useWorkerStore } from "../stores/workerStore.ts";
import { IconPlus, IconClock, IconEdit } from "../components/icons.tsx";
import type { ScheduledJob } from "@shared/types.ts";

/**
 * 定时任务（无人值守 Agent）。
 *
 * 周期触发 Agent 执行一段 prompt；执行走与手动对话完全相同的治理通道
 * （预算检查、策略、审计：operatorId=scheduler）。
 */

interface JobForm {
  id?: string;
  name: string;
  workerId: string;
  prompt: string;
  mode: "every" | "daily";
  everyMinutes: string;
  dailyAt: string;
  enabled: boolean;
}

const EMPTY_FORM: JobForm = {
  name: "", workerId: "", prompt: "",
  mode: "every", everyMinutes: "60", dailyAt: "09:00", enabled: true,
};

function ruleLabel(j: ScheduledJob): string {
  if (j.everyMinutes) return `每 ${j.everyMinutes} 分钟`;
  if (j.dailyAt) return `每天 ${j.dailyAt}`;
  return "未设置";
}

function fmtTime(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const now = Date.now();
  const diffMin = Math.round((d.getTime() - now) / 60000);
  const abs = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (diffMin >= 0 && diffMin < 60) return `${abs}（${diffMin} 分钟后）`;
  return abs;
}

export default function Schedules() {
  const toast = useToast();
  const workers = useWorkerStore((s) => s.all);
  const loadWorkers = useWorkerStore((s) => s.loadAll);

  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<JobForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ScheduledJob | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await ipc.scheduleList();
      setJobs(r.jobs ?? []);
    } catch {
      setJobs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void loadWorkers();
  }, [refresh, loadWorkers]);

  // 列表里有启用的任务时轮询刷新（展示下次运行/最近状态）
  useEffect(() => {
    if (jobs.every((j) => !j.enabled)) return;
    const iv = setInterval(() => { void refresh(); }, 20_000);
    return () => clearInterval(iv);
  }, [jobs, refresh]);

  const openEdit = (j: ScheduledJob) => {
    setForm({
      id: j.id,
      name: j.name,
      workerId: j.workerId,
      prompt: j.prompt,
      mode: j.dailyAt ? "daily" : "every",
      everyMinutes: j.everyMinutes ? String(j.everyMinutes) : "60",
      dailyAt: j.dailyAt ?? "09:00",
      enabled: j.enabled,
    });
  };

  const save = () => {
    if (!form || !form.name.trim() || !form.workerId || !form.prompt.trim()) return;
    setSaving(true);
    ipc.scheduleUpsert({
      id: form.id,
      name: form.name.trim(),
      workerId: form.workerId,
      prompt: form.prompt.trim(),
      everyMinutes: form.mode === "every" ? Math.max(1, Number(form.everyMinutes) || 60) : undefined,
      dailyAt: form.mode === "daily" ? form.dailyAt : undefined,
      enabled: form.enabled,
    })
      .then(() => {
        toast.success(form.id ? "任务已更新" : "任务已创建");
        setForm(null);
        void refresh();
      })
      .catch((e) => toast.error(`保存失败：${e}`))
      .finally(() => setSaving(false));
  };

  const toggleEnabled = async (j: ScheduledJob) => {
    try {
      await ipc.scheduleUpsert({
        id: j.id, name: j.name, workerId: j.workerId, prompt: j.prompt,
        everyMinutes: j.everyMinutes, dailyAt: j.dailyAt,
        enabled: !j.enabled,
      });
      toast.success(j.enabled ? "已暂停" : "已启用");
      void refresh();
    } catch (e) {
      toast.error(`操作失败：${e}`);
    }
  };

  const runNow = async (j: ScheduledJob) => {
    setRunningId(j.id);
    try {
      const r = await ipc.scheduleRun({ id: j.id });
      if (r.ok) toast.success(`「${j.name}」已执行完成`);
      else toast.error(`执行失败：${r.error ?? "未知错误"}`);
      void refresh();
    } catch (e) {
      toast.error(`执行失败：${e}`);
    } finally {
      setRunningId(null);
    }
  };

  return (
    <PageShell
      title="定时任务"
      description="让 Agent 无人值守地按计划干活（执行同样受预算/策略/审计约束）"
      scroll={false}
    >
      <div className="flex flex-col h-full gap-4 min-h-0">
        <div className="shrink-0 flex items-center justify-between">
          <p className="text-[11px] text-fg-faint">
            共 {jobs.length} 个任务 · {jobs.filter((j) => j.enabled).length} 个启用中
          </p>
          <Button size="sm" icon={<IconPlus size={12} />} onClick={() => setForm({ ...EMPTY_FORM, workerId: workers[0]?.id ?? "" })}>
            新建任务
          </Button>
        </div>

        <div className="flex-1 min-h-0 card overflow-auto">
          {loading ? (
            <div className="px-4 py-10 text-center text-[11.5px] text-fg-faint">加载中…</div>
          ) : jobs.length === 0 ? (
            <EmptyState
              icon={<IconClock size={18} />}
              title="还没有定时任务"
              description="例如：每天早上 9 点让 Agent 汇总昨日提交；或每 2 小时巡检一次服务状态。"
              action={<Button variant="primary" onClick={() => setForm({ ...EMPTY_FORM, workerId: workers[0]?.id ?? "" })}>新建任务</Button>}
            />
          ) : (
            jobs.map((j, i) => {
              const worker = workers.find((w) => w.id === j.workerId);
              return (
                <div key={j.id} className={`flex items-center gap-3 px-4 py-3 ${i > 0 ? "border-t border-line" : ""}`}>
                  <span className={`shrink-0 w-2 h-2 rounded-full ${j.enabled ? "bg-green animate-breathe-soft" : "bg-n-600"}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[12.5px] text-fg-muted truncate">{j.name}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-n-850 border border-line text-fg-faint shrink-0">
                        {ruleLabel(j)}
                      </span>
                      {j.lastStatus === "error" && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-bg text-red border border-red/30 shrink-0" title={j.lastError}>
                          上次失败
                        </span>
                      )}
                    </div>
                    <div className="text-[10.5px] text-fg-faint truncate mt-0.5">
                      {worker?.name ?? j.workerId} · 下次 {fmtTime(j.nextRunAt)} · 上次 {fmtTime(j.lastRunAt)}
                    </div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => void runNow(j)} disabled={runningId === j.id}>
                    {runningId === j.id ? "执行中…" : "立即运行"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void toggleEnabled(j)}>
                    {j.enabled ? "暂停" : "启用"}
                  </Button>
                  <Button size="sm" variant="ghost" icon={<IconEdit size={12} />} onClick={() => openEdit(j)}>
                    编辑
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => setPendingDelete(j)}>
                    删除
                  </Button>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* 新建/编辑 */}
      <Modal
        open={form !== null}
        title={form?.id ? "编辑定时任务" : "新建定时任务"}
        onClose={() => setForm(null)}
        widthClass="max-w-lg"
        footer={
          <>
            <Button onClick={() => setForm(null)}>取消</Button>
            <Button
              variant="primary"
              onClick={save}
              disabled={saving || !form?.name.trim() || !form?.workerId || !form?.prompt.trim()}
            >
              {saving ? "保存中…" : "保存"}
            </Button>
          </>
        }
      >
        <div className="space-y-3.5">
          <div>
            <label className="block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint mb-1.5">名称</label>
            <input
              autoFocus
              value={form?.name ?? ""}
              onChange={(e) => setForm((p) => (p ? { ...p, name: e.target.value } : p))}
              placeholder="例如：每日站会汇总"
              className="field"
            />
          </div>

          <div>
            <label className="block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint mb-1.5">执行的 Worker</label>
            <select
              value={form?.workerId ?? ""}
              onChange={(e) => setForm((p) => (p ? { ...p, workerId: e.target.value } : p))}
              className="field cursor-pointer"
            >
              <option value="">（请选择）</option>
              {workers.map((w) => (
                <option key={w.id} value={w.id}>{w.name}{w.config?.agentKind ? ` · ${w.config.agentKind}` : ""}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint mb-1.5">
              交给 Agent 的指令
            </label>
            <textarea
              value={form?.prompt ?? ""}
              onChange={(e) => setForm((p) => (p ? { ...p, prompt: e.target.value } : p))}
              rows={4}
              placeholder="例如：汇总昨天 git log 中的所有提交，按模块分类，写入 DAILY.md"
              className="field resize-none"
            />
          </div>

          <div>
            <label className="block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint mb-1.5">触发规则</label>
            <div className="flex items-center gap-4 mb-2">
              <label className="flex items-center gap-1.5 cursor-pointer text-[11.5px] text-fg-muted">
                <input
                  type="radio"
                  checked={form?.mode === "every"}
                  onChange={() => setForm((p) => (p ? { ...p, mode: "every" } : p))}
                />
                每 N 分钟
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer text-[11.5px] text-fg-muted">
                <input
                  type="radio"
                  checked={form?.mode === "daily"}
                  onChange={() => setForm((p) => (p ? { ...p, mode: "daily" } : p))}
                />
                每天固定时刻
              </label>
            </div>
            {form?.mode === "every" ? (
              <input
                type="number"
                min="1"
                value={form?.everyMinutes ?? ""}
                onChange={(e) => setForm((p) => (p ? { ...p, everyMinutes: e.target.value } : p))}
                className="field max-w-[140px] font-mono"
              />
            ) : (
              <input
                type="time"
                value={form?.dailyAt ?? ""}
                onChange={(e) => setForm((p) => (p ? { ...p, dailyAt: e.target.value } : p))}
                className="field max-w-[140px] font-mono"
              />
            )}
          </div>

          <label className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg border border-line cursor-pointer select-none">
            <input
              type="checkbox"
              checked={form?.enabled ?? true}
              onChange={(e) => setForm((p) => (p ? { ...p, enabled: e.target.checked } : p))}
            />
            <span className="text-[11.5px] text-fg-muted">启用（保存后立即参与调度）</span>
          </label>
        </div>
      </Modal>

      <ConfirmModal
        open={pendingDelete !== null}
        title="删除该定时任务？"
        description={`「${pendingDelete?.name ?? ""}」将不再自动执行，历史审计记录保留。`}
        confirmText="删除"
        danger
        onCancel={() => setPendingDelete(null)}
        onConfirm={async () => {
          if (!pendingDelete) return;
          try {
            await ipc.scheduleDelete({ id: pendingDelete.id });
            toast.success("已删除");
            setPendingDelete(null);
            void refresh();
          } catch (e) {
            toast.error(`删除失败：${e}`);
          }
        }}
      />
    </PageShell>
  );
}
