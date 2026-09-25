import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import StatCard from "../components/StatCard.tsx";
import PageShell from "../components/PageShell.tsx";
import Button from "../components/Button.tsx";
import EmptyState from "../components/EmptyState.tsx";
import { useWorkerStore } from "../stores/workerStore.ts";
import { useUserStore } from "../stores/userStore.ts";
import { getSeenAgentIds, markAgentsSeen } from "../lib/seen.ts";
import { listAllSessions, type ChatSession } from "../lib/sessions.ts";
import {
  IconWorkspace, IconPlay, IconChat, IconClock, IconShield,
} from "../components/icons.tsx";

/** 最近会话数量上限 */
const RECENT_LIMIT = 6;

/** 相对时间，比绝对时间更符合"最近"这一语义 */
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

/** 可读的助手类型 */
function typeLabel(type: string): string {
  return type === "personal" ? "个人" : "项目";
}

export default function Workspace() {
  const nav = useNavigate();

  // 助手列表走全局缓存（与 Sidebar / WorkChat 共用同一份数据）
  const workers = useWorkerStore((s) => s.mine);
  const loadedWorkers = useWorkerStore((s) => s.loadedMine);
  const loadMine = useWorkerStore((s) => s.loadMine);

  const userId = useUserStore((s) => s.session?.userId);
  const canConsole = useUserStore(
    (s) => !!s.session && (s.session.role === "admin" || s.session.canManageConsole),
  );

  const [recent, setRecent] = useState<ChatSession[]>([]);
  const loading = !loadedWorkers;

  useEffect(() => {
    if (!userId) return;
    setRecent(listAllSessions(RECENT_LIMIT));
  }, [userId]);

  // 身份就绪/切换后加载可见 Agent
  useEffect(() => {
    if (!userId) return;
    void loadMine();
  }, [userId, loadMine]);

  const running = workers.filter((w) => w.status === "running").length;

  return (
    <PageShell
      title="我的助手"
      description="你的 AI 助手与最近会话"
      actions={
        canConsole ? (
          <Button icon={<IconShield size={13} />} onClick={() => nav("/admin/workers")}>
            管理控制台
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-6 max-w-5xl">
        {/* 概览 */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard
            label="我的助手"
            value={loading ? "—" : workers.length}
            hint={loading ? "" : "已分配给你的 AI 助手"}
            icon={<IconWorkspace size={13} />}
          />
          <StatCard
            label="运行中"
            value={loading ? "—" : running}
            tone={running > 0 ? "ok" : "default"}
            hint={loading ? "" : `共 ${workers.length} 个`}
            icon={<IconPlay size={13} />}
          />
          <StatCard
            label="最近会话"
            value={loading ? "—" : recent.length}
            hint="近期的对话"
            icon={<IconChat size={13} />}
          />
        </div>

        {/* 助手卡片 */}
        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {[1, 2, 3, 4].map((i) => <div key={i} className="animate-shimmer h-[104px] rounded-xl" />)}
          </div>
        ) : workers.length === 0 ? (
          <div className="card">
            <EmptyState
              icon={<IconWorkspace size={18} />}
              title="还没有分配到助手"
              description="管理员为你创建并分配 AI 助手后，它会出现在这里。"
              action={canConsole ? (
                <Button variant="primary" onClick={() => nav("/admin/workers")}>
                  前往管理控制台
                </Button>
              ) : undefined}
            />
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {workers.map((w) => {
              const running_ = w.status === "running";
              const isNew = !getSeenAgentIds().has(w.id);
              return (
                <button
                  key={w.id}
                  onClick={() => { markAgentsSeen([w.id]); nav(`/app/chat/${w.id}`); }}
                  className="card card-hover text-left p-4 group"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className="relative flex items-center justify-center shrink-0">
                      <span className={`w-1.5 h-1.5 rounded-full ${running_ ? "bg-green" : "bg-n-600"}`} />
                      {running_ && <span className="absolute w-1.5 h-1.5 rounded-full bg-green animate-breathe-soft" />}
                    </span>
                    <span className="text-[13px] font-medium text-fg truncate">{w.name}</span>
                    {isNew && (
                      <span className="shrink-0 text-[9px] font-bold px-1 py-px rounded bg-primary text-white" title="新分配给你的助手">
                        NEW
                      </span>
                    )}
                    <span className={`ml-auto shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded ${
                      w.type === "personal"
                        ? "bg-blue-bg text-blue"
                        : "bg-green-bg text-green"
                    }`}>
                      {typeLabel(w.type)}
                    </span>
                  </div>

                  <p className="text-[12px] text-fg-subtle line-clamp-2 min-h-[2.1rem]">
                    {w.description || "暂无描述"}
                  </p>

                    <div className="mt-3 flex items-center gap-2 flex-wrap">
                      <span className="text-[11px] text-fg-muted">
                        模型 · {w.config.modelName || "默认"}
                      </span>
                      {(w.config.knowledgeIds?.length ?? 0) > 0 && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-bg text-blue border border-blue/20">
                          知识库 · {w.config.knowledgeIds!.length}
                        </span>
                      )}
                      {w.config.budgetLimitUsd != null && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-bg text-yellow border border-yellow/20">
                          预算 · ${w.config.budgetLimitUsd}
                        </span>
                      )}
                      {(w.assignedGroupIds?.length ?? 0) > 0 && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-n-850 border border-line text-fg-subtle">
                          团队共享
                        </span>
                      )}
                      {w.config.systemPrompt && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary-bg text-primary border border-primary-border">
                          已配置指令
                        </span>
                      )}
                      <IconChat
                        size={14}
                        className="ml-auto text-fg-faint group-hover:text-primary transition-colors"
                      />
                    </div>
                </button>
              );
            })}
          </div>
        )}

        {/* 最近会话 */}
        {recent.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 mb-2.5">
              <IconClock size={13} className="text-fg-faint" />
              <h2 className="text-[10.5px] font-semibold text-fg-faint uppercase tracking-[0.06em]">
                最近会话
              </h2>
            </div>
            <div className="card divide-y divide-line overflow-hidden">
              {recent.map((s) => (
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
                      {s.title}
                    </p>
                    <p className="text-[10.5px] text-fg-faint truncate">
                      {workers.find((w) => w.id === s.workerId)?.name ?? s.workerId}
                    </p>
                  </div>
                  <span className="text-[10.5px] text-fg-faint shrink-0">
                    {relativeTime(s.updatedAt)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </PageShell>
  );
}
