import { useCallback, useEffect, useMemo, useState } from "react";
import * as ipc from "../lib/ipc.ts";
import PageShell from "../components/PageShell.tsx";
import Button from "../components/Button.tsx";
import EmptyState from "../components/EmptyState.tsx";
import Markdown from "../components/Markdown.tsx";
import { useToast } from "../components/Toast.tsx";
import { IconNetwork, IconPlay, IconRefresh } from "../components/icons.tsx";
import type { AtomicTask, SwarmResult, WorkerTaskResult } from "@swarm/types.ts";
import type { SwarmHistoryEntry, SwarmProgressEvent } from "@shared/types.ts";

/**
 * Swarm 控制台。
 *
 * 相比此前"点执行 → 盯一个 spinner 等到超时"：
 *   · 通过 swarm:event 推送实时进度（拆解 → 批次 → 单任务开始/结束）；
 *   · 保留主进程的内存历史（swarm:history），可点开回看任意一次执行结果。
 */

type LiveStatus = "running" | "ok" | "error";

export default function Swarm() {
  const toast = useToast();
  const [prompt, setPrompt] = useState("");
  const [result, setResult] = useState<SwarmResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<SwarmProgressEvent | null>(null);
  const [live, setLive] = useState<Record<string, { title: string; status: LiveStatus }>>({});
  const [history, setHistory] = useState<SwarmHistoryEntry[]>([]);

  const loadHistory = useCallback(() => {
    ipc.swarmHistory().then(setHistory).catch(() => setHistory([]));
  }, []);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  const execute = async () => {
    if (!prompt.trim() || loading) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setProgress(null);
    setLive({});

    // 订阅实时进度（Electron 模式；浏览器模式为 no-op，仍可得到最终结果）
    const off = ipc.onSwarmEvent((ev) => {
      setProgress(ev);
      if (ev.phase === "task_start") {
        setLive((prev) => ({ ...prev, [ev.taskId]: { title: ev.title, status: "running" } }));
      } else if (ev.phase === "task_end") {
        setLive((prev) => ({ ...prev, [ev.taskId]: { title: ev.title, status: ev.success ? "ok" : "error" } }));
      }
    });

    try {
      const r = await ipc.swarmExecute({ request: { prompt: prompt.trim() } });
      setResult(r as SwarmResult);
      toast.success("Swarm 执行完成");
      loadHistory();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast.error(`Swarm 执行失败：${msg}`);
    } finally {
      off();
      setLoading(false);
    }
  };

  const tasks: AtomicTask[] = result?.tasks ?? [];
  const workerResults: WorkerTaskResult[] = result?.workerResults ?? [];

  const batches = useMemo<AtomicTask[][]>(() => {
    const done = new Set<string>();
    const out: AtomicTask[][] = [];
    let remaining = [...tasks];

    while (remaining.length > 0) {
      const batch = remaining.filter((t) => (t.dependsOn ?? []).every((d) => done.has(d)));
      if (batch.length === 0) break;
      for (const t of batch) done.add(t.id);
      out.push(batch);
      remaining = remaining.filter((t) => !done.has(t.id));
    }

    return out;
  }, [tasks]);

  const outputText = result
    ? result.output.format === "markdown"
      ? result.output.content
      : "```json\n" + JSON.stringify(result.output.data, null, 2) + "\n```"
    : undefined;

  const statusOf = (taskId: string): WorkerTaskResult | undefined =>
    workerResults.find((r) => r.taskId === taskId);

  const doneCount = workerResults.filter((r) => r.success).length;
  const failedCount = workerResults.filter((r) => !r.success).length;

  // 实时进度百分比与文案
  const pct =
    progress && progress.phase !== "decomposed"
      ? Math.round((progress.completed / Math.max(1, progress.total)) * 100)
      : 0;

  return (
    <PageShell
      title="Swarm"
      description="把复杂任务拆解成 DAG，并跨多个 Worker 执行"
      scroll={false}
    >
      <div className="flex flex-col h-full gap-4">
        {/* 输入 */}
        <div className="shrink-0 card p-4">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            placeholder="描述一个需要拆解执行的复杂任务，例如：审查 src/ 下的代码并给出重构建议"
            className="field resize-none !py-2.5 !text-[12.5px]"
          />
          <div className="flex items-center gap-2 mt-3">
            <Button
              variant="primary"
              icon={<IconPlay size={13} />}
              onClick={execute}
              disabled={loading || !prompt.trim()}
            >
              {loading ? "执行中…" : "执行"}
            </Button>
            <Button onClick={() => { setPrompt(""); setResult(null); setError(null); }}>
              清空
            </Button>
            {result && (
              <span className="ml-auto text-[10.5px] text-fg-faint">
                {tasks.length} 个任务 · {doneCount} 成功
                {failedCount > 0 && <span className="text-red"> · {failedCount} 失败</span>}
                <span className="ml-2 text-fg-faint/70">
                  {new Date(result.startedAt).toLocaleTimeString()} — {new Date(result.completedAt).toLocaleTimeString()}
                </span>
              </span>
            )}
          </div>
        </div>

        {error && (
          <div className="shrink-0 px-3 py-2 rounded-lg bg-red-bg border border-red/30 text-[11.5px] text-red animate-in">
            {error}
          </div>
        )}

        {/* 结果区 */}
        <div className="flex-1 min-h-0 overflow-y-auto space-y-4">
          {loading ? (
            /* ── 实时进度 ── */
            <div className="card p-4">
              <div className="flex items-center gap-3">
                <span className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin shrink-0" />
                <div className="min-w-0">
                  <p className="text-[12.5px] text-fg-muted font-medium">
                    {!progress
                      ? "正在拆解任务…"
                      : progress.phase === "decomposed"
                        ? `已拆解为 ${progress.total} 个任务，正在派发…`
                        : `执行中 ${progress.completed}/${progress.total}`}
                  </p>
                  {progress && progress.phase !== "decomposed" && (
                    <p className="text-[10.5px] text-fg-faint mt-0.5">
                      批次 {progress.batchIndex + 1}/{progress.batchTotal}
                    </p>
                  )}
                </div>
              </div>

              <div className="mt-3 h-1 rounded-full bg-n-800 overflow-hidden">
                <div
                  className="h-full bg-primary transition-all duration-300"
                  style={{ width: `${pct}%` }}
                />
              </div>

              {Object.keys(live).length > 0 && (
                <div className="mt-3 space-y-1">
                  {Object.entries(live).map(([id, t]) => (
                    <div key={id} className="flex items-center gap-2 text-[11px]">
                      <span className={`shrink-0 w-1.5 h-1.5 rounded-full ${
                        t.status === "running" ? "bg-yellow animate-pulse" : t.status === "ok" ? "bg-green" : "bg-red"
                      }`} />
                      <span className="text-fg-muted truncate">{t.title}</span>
                      <span className={`ml-auto shrink-0 ${t.status === "error" ? "text-red" : "text-fg-faint"}`}>
                        {t.status === "running" ? "执行中" : t.status === "ok" ? "完成" : "失败"}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : result ? (
            /* ── 执行结果 ── */
            <>
              {result.error && (
                <div className="px-3 py-2 rounded-lg bg-red-bg border border-red/30 text-[11.5px] text-red">
                  {result.error}
                </div>
              )}

              {/* DAG */}
              <div className="card p-4">
                <h2 className="text-[12.5px] font-semibold text-fg-muted mb-3">执行计划</h2>
                <div className="flex items-center gap-2 flex-wrap">
                  {batches.map((batch, bi) => (
                    <div key={bi} className="flex items-center gap-2">
                      {bi > 0 && <span className="text-fg-faint">→</span>}
                      <div className="rounded-lg border border-line bg-n-900/70 px-3 py-2">
                        <span className="block mb-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-fg-faint">
                          批次 {bi + 1}
                        </span>
                        <div className="flex gap-1.5">
                          {batch.map((t) => {
                            const wr = statusOf(t.id);
                            const color = wr ? (wr.success ? "bg-green" : "bg-red") : "bg-n-600";
                            return <span key={t.id} className={`w-2.5 h-2.5 rounded-full ${color}`} title={t.title} />;
                          })}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* 任务列表 */}
              <div className="card overflow-hidden">
                <div className="px-4 py-3 border-b border-line">
                  <h2 className="text-[12.5px] font-semibold text-fg-muted">任务（{tasks.length}）</h2>
                </div>
                <div className="divide-y divide-line">
                  {tasks.map((t) => {
                    const wr = statusOf(t.id);
                    const deps = (t.dependsOn?.length ?? 0) > 0
                      ? tasks.filter((x) => (t.dependsOn ?? []).includes(x.id)).map((x) => x.title).join("、")
                      : null;
                    return (
                      <div key={t.id} className="flex items-center gap-3 px-4 py-2.5">
                        <span className={`shrink-0 w-1.5 h-1.5 rounded-full ${
                          wr ? (wr.success ? "bg-green" : "bg-red") : "bg-n-600"
                        }`} />
                        <span className="flex-1 text-[12px] text-fg-muted truncate">{t.title}</span>
                        {wr?.error && (
                          <span className="text-[10.5px] text-red truncate max-w-[220px]" title={wr.error}>{wr.error}</span>
                        )}
                        {deps && <span className="text-[10.5px] text-fg-faint truncate max-w-[240px]">依赖：{deps}</span>}
                        <span className={`shrink-0 text-[10.5px] font-medium ${
                          wr ? (wr.success ? "text-green" : "text-red") : "text-fg-faint"
                        }`}>
                          {wr ? (wr.success ? "完成" : "失败") : "待执行"}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* 聚合输出（Markdown 渲染） */}
              {outputText && (
                <div className="card p-4">
                  <h2 className="text-[12.5px] font-semibold text-fg-muted mb-3">输出</h2>
                  <Markdown text={outputText} />
                </div>
              )}
            </>
          ) : (
            <EmptyState
              icon={<IconNetwork size={18} />}
              title="输入任务后点击执行"
              description="任务会按依赖关系分批并行执行；执行过程与历史结果都保留在这里。"
            />
          )}

          {/* 历史（不遮挡当前结果，置于结果下方） */}
          {!loading && history.length > 0 && (
            <div className="card overflow-hidden">
              <div className="px-4 py-3 border-b border-line flex items-center gap-2">
                <h2 className="text-[12.5px] font-semibold text-fg-muted">最近执行</h2>
                <span className="text-[10.5px] text-fg-faint">{history.length} 条</span>
                <button
                  onClick={loadHistory}
                  title="刷新历史"
                  className="ml-auto text-fg-faint hover:text-fg-muted transition-colors"
                >
                  <IconRefresh size={13} />
                </button>
              </div>
              <div className="divide-y divide-line max-h-64 overflow-y-auto">
                {history.map((h) => (
                  <button
                    key={h.id}
                    onClick={() => { setResult(h.result); setError(null); }}
                    className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-n-850/60 transition-colors text-left"
                  >
                    <span className={`shrink-0 w-1.5 h-1.5 rounded-full ${h.result.success ? "bg-green" : "bg-red"}`} />
                    <span className="flex-1 text-[12px] text-fg-muted truncate">{h.prompt}</span>
                    <span className="shrink-0 text-[10.5px] text-fg-faint">{h.result.tasks.length} 任务</span>
                    <span className="shrink-0 text-[10.5px] text-fg-faint">
                      {new Date(h.createdAt).toLocaleString()}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </PageShell>
  );
}
