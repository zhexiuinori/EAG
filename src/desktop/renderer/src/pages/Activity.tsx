import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import PageShell from "../components/PageShell.tsx";
import EmptyState from "../components/EmptyState.tsx";
import { useWorkerStore } from "../stores/workerStore.ts";
import { useUserStore } from "../stores/userStore.ts";
import { listAllSessions, type ChatSession } from "../lib/sessions.ts";
import { IconChat, IconClock } from "../components/icons.tsx";

/** 动态条数上限：本期数据源是本地会话索引，量级可控 */
const ACTIVITY_LIMIT = 50;

/** 与 Workspace 保持一致的相对时间语义 */
function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  return `${day} 天前`;
}

/** 按自然日分组：今天 / 昨天 / 更早，让跨 Agent 时间线可读 */
function dayLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.floor((startOfDay(now) - startOfDay(d)) / 86400000);
  if (diffDays <= 0) return "今天";
  if (diffDays === 1) return "昨天";
  return "更早";
}

/**
 * 全部动态（PRD-001 R1）：跨 Agent 的会话时间线。
 *
 * 数据源说明：本期用本地会话索引（lib/sessions.ts），只覆盖本机会话；
 * 切换执行总线 / 审计聚合是后续迭代（见 PRD-001 §五 假设 1）。
 */
export default function Activity() {
  const nav = useNavigate();
  const workers = useWorkerStore((s) => s.mine);
  const loadMine = useWorkerStore((s) => s.loadMine);
  const userId = useUserStore((s) => s.session?.userId);

  const [sessions, setSessions] = useState<ChatSession[]>([]);

  useEffect(() => {
    if (!userId) return;
    void loadMine();
    setSessions(listAllSessions(ACTIVITY_LIMIT));
  }, [userId, loadMine]);

  const workerName = (id: string) => workers.find((w) => w.id === id)?.name ?? id;

  // 分组保持时间线倒序，组内仍按更新时间倒序
  const groups: Array<{ label: string; items: ChatSession[] }> = [];
  for (const s of sessions) {
    const label = dayLabel(s.updatedAt);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(s);
    else groups.push({ label, items: [s] });
  }

  return (
    <PageShell
      title="全部动态"
      description="你所有助手的最新会话动态"
    >
      <div className="max-w-3xl">
        {sessions.length === 0 ? (
          <div className="card">
            <EmptyState
              icon={<IconClock size={18} />}
              title="还没有动态"
              description="和任意助手开始一段对话后，它会出现在这里。"
              action={undefined}
            />
          </div>
        ) : (
          groups.map((g) => (
            <div key={g.label} className="mb-5">
              <div className="flex items-center gap-1.5 mb-2.5">
                <IconClock size={13} className="text-fg-faint" />
                <h2 className="text-[10.5px] font-semibold text-fg-faint uppercase tracking-[0.06em]">
                  {g.label}
                </h2>
                <span className="text-[10px] text-fg-faint">{g.items.length}</span>
              </div>
              <div className="card divide-y divide-line overflow-hidden">
                {g.items.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => nav(`/app/chat/${s.workerId}/${s.id}`)}
                    className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-n-850/60 transition-colors text-left group"
                  >
                    <div className="size-7 rounded-lg bg-n-850 border border-line flex items-center justify-center shrink-0">
                      <IconChat size={12} className="text-fg-subtle" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[12px] text-fg-muted truncate group-hover:text-fg transition-colors">
                        {s.unread && <span className="inline-block size-1.5 rounded-full bg-primary mr-1.5 align-middle" />}
                        {s.title}
                      </p>
                      <p className="text-[10.5px] text-fg-faint truncate">
                        {workerName(s.workerId)}
                      </p>
                    </div>
                    <span className="text-[10.5px] text-fg-faint shrink-0">
                      {relativeTime(s.updatedAt)}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </PageShell>
  );
}
