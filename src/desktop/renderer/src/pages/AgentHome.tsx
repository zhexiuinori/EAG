import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import * as ipc from "../lib/ipc.ts";
import { listSessions } from "../lib/sessions.ts";
import PageShell from "../components/PageShell.tsx";
import Button from "../components/Button.tsx";
import EmptyState from "../components/EmptyState.tsx";
import FileBrowser from "../components/FileBrowser.tsx";
import { Modal } from "../components/Modal.tsx";
import { useWorkerStore } from "../stores/workerStore.ts";
import {
  IconChat, IconClock, IconWorkspace, IconShield, IconBook, IconPlay,
} from "../components/icons.tsx";
import type { AuditEntry, ExecutionEvent, FileDiffResult, Worker } from "@shared/types.ts";

type TabKey = "chat" | "progress" | "files" | "changes" | "usage";

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "chat", label: "对话" },
  { key: "progress", label: "进度" },
  { key: "files", label: "文件" },
  { key: "changes", label: "变更" },
  { key: "usage", label: "用量" },
];

const VERDICT_LABEL: Record<ExecutionEvent["verdict"], string> = {
  allowed: "允许",
  blocked: "被拦截",
  observed: "仅观察",
};

/** 进度：合并该助手各会话的统一执行历史（Agent + 终端），按时间倒序。 */
function ProgressTab({ workerId }: { workerId: string }) {
  const [events, setEvents] = useState<ExecutionEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const sessions = listSessions(workerId).slice(0, 10);
      const all: ExecutionEvent[] = [];
      for (const s of sessions) {
        try {
          const r = await ipc.executionList({ sessionId: s.id, limit: 50 });
          all.push(...r.events);
        } catch {
          /* 单个会话取数失败不阻塞整体 */
        }
      }
      if (cancelled) return;
      all.sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
      setEvents(all.slice(0, 50));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [workerId]);

  if (loading) {
    return <div className="card px-4 py-10 text-center text-[11.5px] text-fg-faint">加载中…</div>;
  }
  if (events.length === 0) {
    return (
      <div className="card">
        <EmptyState
          icon={<IconWorkspace size={18} />}
          title="还没有执行记录"
          description="开始对话后，Agent 与终端执行的命令会按时间线列在这里。"
        />
      </div>
    );
  }
  return (
    <div className="card divide-y divide-line">
      {events.map((e) => (
        <div key={e.id} className="px-4 py-2.5 flex items-center gap-3">
          <span
            className={`shrink-0 text-[9.5px] px-1.5 py-0.5 rounded border ${
              e.verdict === "blocked"
                ? "bg-red-bg text-red border-red/30"
                : e.verdict === "observed"
                  ? "bg-yellow-bg text-yellow border-yellow/30"
                  : "bg-green-bg text-green border-green/30"
            }`}
          >
            {VERDICT_LABEL[e.verdict]}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[11.5px] font-mono text-fg-muted truncate" title={e.command}>
              {e.command}
            </div>
            <div className="text-[10px] text-fg-faint mt-0.5">
              {e.source === "agent" ? "Agent 执行" : "终端执行"} · {new Date(e.startedAt).toLocaleString("zh-CN")}
              {e.exitCode != null && ` · 退出码 ${e.exitCode}`}
              {e.blockedReason && ` · ${e.blockedReason}`}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** 变更：从该助手的审计记录中提取文件写操作，可按需查看改前快照 diff。 */
function ChangesTab({ workerId }: { workerId: string }) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [diff, setDiff] = useState<{ path: string; data: FileDiffResult } | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await ipc.auditList({ workerId, limit: 300 });
        const files = new Map<string, AuditEntry>();
        for (const e of r.entries) {
          if (e.phase !== "result") continue;
          if (!/write|edit|create|delete|move|rename/i.test(e.toolName)) continue;
          const p = typeof e.input?.path === "string"
            ? e.input.path
            : typeof e.input?.file_path === "string"
              ? e.input.file_path
              : undefined;
          if (!p || files.has(p)) continue;
          files.set(p, e);
        }
        if (!cancelled) setEntries([...files.values()]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [workerId]);

  const openDiff = async (path: string) => {
    setDiffLoading(true);
    try {
      const data = await ipc.fileDiff({ workerId, path });
      setDiff({ path, data });
    } finally {
      setDiffLoading(false);
    }
  };

  if (loading) {
    return <div className="card px-4 py-10 text-center text-[11.5px] text-fg-faint">加载中…</div>;
  }
  return (
    <>
      {entries.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={<IconWorkspace size={18} />}
            title="还没有文件变更"
            description="Agent 修改文件后，变更会列在这里，可对比改前快照（Web 模式暂不提供）。"
          />
        </div>
      ) : (
        <div className="card divide-y divide-line">
          {entries.map((e) => {
            const p = typeof e.input?.path === "string" ? e.input.path : String(e.input?.file_path ?? "");
            return (
              <div key={`${e.timestamp}-${p}`} className="px-4 py-2.5 flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-[11.5px] font-mono text-fg-muted truncate" title={p}>{p}</div>
                  <div className="text-[10px] text-fg-faint mt-0.5">
                    {e.toolName} · {new Date(e.timestamp).toLocaleString("zh-CN")}
                    {e.isError && " · 执行出错"}
                  </div>
                </div>
                <Button size="sm" variant="ghost" disabled={diffLoading} onClick={() => void openDiff(p)}>
                  查看改动
                </Button>
              </div>
            );
          })}
        </div>
      )}

      <Modal
        open={diff !== null}
        title={`变更对比 · ${diff?.path ?? ""}`}
        onClose={() => setDiff(null)}
        footer={<Button onClick={() => setDiff(null)}>关闭</Button>}
      >
        {diff && !diff.data.found ? (
          <p className="text-[11.5px] text-fg-faint">没有找到该文件的改前快照（可能是新建文件）。</p>
        ) : diff ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-[60vh] overflow-auto">
            <div>
              <div className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint mb-1.5">改前（审计快照）</div>
              <pre className="text-[10.5px] font-mono text-fg-subtle bg-n-900 border border-line rounded-lg p-2.5 overflow-auto max-h-[52vh] whitespace-pre-wrap">
                {diff.data.before ?? "（无快照 / 新建文件）"}
              </pre>
            </div>
            <div>
              <div className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint mb-1.5">当前（磁盘）</div>
              <pre className="text-[10.5px] font-mono text-fg-subtle bg-n-900 border border-line rounded-lg p-2.5 overflow-auto max-h-[52vh] whitespace-pre-wrap">
                {diff.data.after ?? "（文件已删除或不可读）"}
              </pre>
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  );
}

/** 用量：静态配置 + 从审计记录实时聚合的成本 / 调用 / 拦截统计。 */
function UsageTab({ worker }: { worker: Worker }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    ipc.auditList({ workerId: worker.id, limit: 500 })
      .then((r) => { if (!cancelled) setEntries(r.entries); })
      .catch(() => { if (!cancelled) setEntries([]); });
    return () => { cancelled = true; };
  }, [worker.id]);

  const stats = useMemo(() => {
    if (!entries) return null;
    const results = entries.filter((e) => e.phase === "result");
    const cost = entries.reduce((sum, e) => sum + (e.costUsd ?? 0), 0);
    const errors = results.filter((e) => e.isError).length;
    const byTool = new Map<string, number>();
    for (const e of results) byTool.set(e.toolName, (byTool.get(e.toolName) ?? 0) + 1);
    const topTools = [...byTool.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    return { calls: results.length, cost, errors, topTools };
  }, [entries]);

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center gap-1.5">
        <IconPlay size={13} className="text-fg-faint" />
        <h3 className="text-[12px] font-semibold text-fg">用量与范围</h3>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[12px]">
        <div className="rounded-lg border border-line p-3">
          <div className="text-fg-faint text-[10.5px] mb-1">预算上限</div>
          <div className="text-fg">
            {worker.config.budgetLimitUsd != null ? `$${worker.config.budgetLimitUsd}` : "未设置"}
          </div>
          {stats && worker.config.budgetLimitUsd != null && (
            <div className="text-[10px] text-fg-faint mt-1">
              已用 ${stats.cost.toFixed(4)} · 剩余 ${Math.max(worker.config.budgetLimitUsd - stats.cost, 0).toFixed(4)}
            </div>
          )}
        </div>
        <div className="rounded-lg border border-line p-3">
          <div className="text-fg-faint text-[10.5px] mb-1">可访问范围</div>
          <div className="text-fg">
            {(worker.assignedGroupIds?.length ?? 0) > 0 ? "团队共享" : worker.type === "personal" ? "个人" : "项目"}
          </div>
        </div>
        <div className="rounded-lg border border-line p-3">
          <div className="text-fg-faint text-[10.5px] mb-1 flex items-center gap-1">
            <IconBook size={10} />
            知识库
          </div>
          <div className="text-fg">
            {(worker.config.knowledgeIds?.length ?? 0) > 0
              ? `${worker.config.knowledgeIds!.length} 个已挂载`
              : "未挂载"}
          </div>
        </div>
        <div className="rounded-lg border border-line p-3">
          <div className="text-fg-faint text-[10.5px] mb-1 flex items-center gap-1">
            <IconClock size={10} />
            累计成本
          </div>
          <div className="text-fg">
            {stats ? `$${stats.cost.toFixed(4)}` : "统计中…"}
          </div>
          {stats && (
            <div className="text-[10px] text-fg-faint mt-1">
              工具调用 {stats.calls} 次 · 出错 {stats.errors} 次（近 500 条审计）
            </div>
          )}
        </div>
      </div>
      {stats && stats.topTools.length > 0 && (
        <div className="rounded-lg border border-line p-3">
          <div className="text-fg-faint text-[10.5px] mb-2">常用工具（近 500 条审计）</div>
          <div className="space-y-1.5">
            {stats.topTools.map(([name, count]) => (
              <div key={name} className="flex items-center gap-2">
                <span className="text-[11px] font-mono text-fg-muted truncate flex-1">{name}</span>
                <span className="text-[10.5px] text-fg-faint shrink-0">{count} 次</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {stats && entries && entries.length === 0 && (
        <p className="text-[10px] text-fg-faint">暂无审计数据（Web 模式不返回审计统计，桌面端可见完整数据）。</p>
      )}
    </div>
  );
}

/**
 * Agent 工作区壳：对话 / 进度 / 文件 / 变更 / 用量 五个 tab。
 * 进度=统一执行历史时间线；文件=受治理文件工作区；变更=审计驱动的文件改动 + 改前快照对比；
 * 用量=配置 + 审计聚合的成本与调用统计。
 */
export default function AgentHome() {
  const { workerId = "" } = useParams();
  const nav = useNavigate();

  const workers = useWorkerStore((s) => s.mine);
  const loaded = useWorkerStore((s) => s.loadedMine);
  const loadMine = useWorkerStore((s) => s.loadMine);

  const [tab, setTab] = useState<TabKey>("chat");

  useEffect(() => { void loadMine(); }, [loadMine]);

  const worker = workers.find((w) => w.id === workerId);

  if (loaded && !worker) {
    return (
      <PageShell title="助手不存在" description="它可能已被移除，或你没有访问权限">
        <div className="card">
          <EmptyState
            icon={<IconWorkspace size={18} />}
            title="找不到这个助手"
            description="返回我的助手列表看看。"
            action={<Button variant="primary" onClick={() => nav("/app")}>返回我的助手</Button>}
          />
        </div>
      </PageShell>
    );
  }

  const running = worker?.status === "running";

  return (
    <PageShell
      title={worker?.name ?? "…"}
      description={worker?.description || undefined}
      actions={
        <Button
          variant="primary"
          icon={<IconChat size={13} />}
          onClick={() => nav(`/app/chat/${workerId}`)}
        >
          进入对话
        </Button>
      }
    >
      <div className="space-y-4 max-w-4xl">
        {/* 状态条：运行状态 / 模型 / 受控标识 */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="relative flex items-center justify-center shrink-0">
            <span className={`w-1.5 h-1.5 rounded-full ${running ? "bg-green" : "bg-n-600"}`} />
            {running && <span className="absolute w-1.5 h-1.5 rounded-full bg-green animate-breathe-soft" />}
          </span>
          <span className="text-[12px] text-fg-subtle">{running ? "运行中" : "空闲"}</span>
          <span className="text-[11px] text-fg-muted">
            模型 · {worker?.config.modelName || "默认"}
          </span>
          <span
            className="text-[10px] px-1.5 py-0.5 rounded bg-primary-bg text-primary border border-primary-border inline-flex items-center gap-1"
            title="该助手的操作受企业策略保护，被拦截的操作会记录在你的操作记录里"
          >
            <IconShield size={10} />
            受控
          </span>
        </div>

        {/* Tab 导航 */}
        <div className="flex items-center gap-1 border-b border-line">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-3 py-2 text-[12.5px] rounded-t-lg transition-colors ${
                tab === t.key
                  ? "text-fg font-medium border-b-2 border-primary -mb-px"
                  : "text-fg-subtle hover:text-fg-muted"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab 内容 */}
        {tab === "chat" && (
          <div className="card">
            <EmptyState
              icon={<IconChat size={18} />}
              title="开始对话"
              description="对话在专属聊天页进行，支持流式回复、工具卡片与附件。"
              action={
                <Button variant="primary" onClick={() => nav(`/app/chat/${workerId}`)}>
                  进入对话
                </Button>
              }
            />
          </div>
        )}

        {tab === "progress" && <ProgressTab workerId={workerId} />}

        {tab === "files" && <FileBrowser />}

        {tab === "changes" && <ChangesTab workerId={workerId} />}

        {tab === "usage" && worker && <UsageTab worker={worker} />}
      </div>
    </PageShell>
  );
}
