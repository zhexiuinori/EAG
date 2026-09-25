import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  IconWorkspace, IconNetwork, IconSliders, IconList, IconShield, IconUsers,
  IconChat, IconArrowLeft, IconPlus, IconSparkle, IconChevronRight,
  IconTrash, IconSearch, IconPin, IconInbox, IconGauge, IconBook, IconClock,
} from "./icons.tsx";
import { useToast } from "./Toast.tsx";
import { useWorkerStore } from "../stores/workerStore.ts";
import { useUserStore } from "../stores/userStore.ts";
import { getSeenAgentIds, markAgentsSeen } from "../lib/seen.ts";
import { listSessions, createSession, deleteSession, pinSession, groupSessions, type ChatSession } from "../lib/sessions.ts";

interface Props { isAdmin: boolean }

const ADMIN_NAV = [
  { path: "/admin/inbox", label: "Inbox", icon: IconInbox },
  { path: "/admin/governance", label: "治理总览", icon: IconGauge },
  { path: "/admin/workers", label: "Workers", icon: IconWorkspace },
  { path: "/admin/knowledge", label: "知识库", icon: IconBook },
  { path: "/admin/schedules", label: "定时任务", icon: IconClock },
  { path: "/admin/models", label: "Models", icon: IconSliders },
  { path: "/admin/audit", label: "Audit", icon: IconList },
  { path: "/admin/policy", label: "Policy", icon: IconShield },
  { path: "/admin/swarm", label: "Swarm", icon: IconNetwork },
  { path: "/admin/settings", label: "Settings", icon: IconUsers },
];

/** 品牌标识：渐变方块 + 光晕 */
function BrandMark() {
  return (
    <div className="size-7 rounded-lg bg-gradient-to-br from-primary to-primary-strong flex items-center justify-center brand-glow shrink-0">
      <IconSparkle size={14} className="text-white" />
    </div>
  );
}

export default function Sidebar({ isAdmin }: Props) {
  const nav = useNavigate();
  const loc = useLocation();
  const toast = useToast();
  const canConsole = useUserStore(
    (s) => !!s.session && (s.session.role === "admin" || s.session.canManageConsole),
  );

  // Worker 列表走全局缓存：与 Workspace / WorkChat 共用，避免重复请求
  const workers = useWorkerStore((s) => s.mine);
  const loadingAgents = useWorkerStore((s) => s.loadingMine);
  const loadMine = useWorkerStore((s) => s.loadMine);

  const seenAgents = getSeenAgentIds();

  useEffect(() => { void loadMine(); }, [loadMine]);

  /** 展开的 Agent（进入其会话列表视图）；null = 显示 Agent 列表 */
  const [agentView, setAgentView] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ChatSession[]>([]);

  // 进入聊天页时自动展开对应 Agent
  useEffect(() => {
    const matched = loc.pathname.match(/^\/app\/chat\/([^/]+)/);
    if (matched) setAgentView(matched[1]);
  }, [loc.pathname]);

  const [sessionFilter, setSessionFilter] = useState("");
  const [tick, setTick] = useState(0);

  // 会话按用户隔离：身份就绪且切换时重新读取
  const userId = useUserStore((s) => s.session?.userId);
  useEffect(() => {
    setSessions(userId && agentView ? listSessions(agentView) : []);
  }, [agentView, loc.pathname, tick, userId]);

  const removeSession = (s: ChatSession) => {
    deleteSession(s.id);
    setTick((v) => v + 1);
    toast.success("会话已删除");
    // 删除的是当前打开的会话：跳到同 Agent 的下一个会话
    if (loc.pathname === `/app/chat/${s.workerId}/${s.id}`) {
      const rest = listSessions(s.workerId);
      if (rest[0]) nav(`/app/chat/${s.workerId}/${rest[0].id}`, { replace: true });
      else nav("/app");
    }
  };

  const shownSessions = sessionFilter.trim()
    ? sessions.filter((s) => s.title.toLowerCase().includes(sessionFilter.trim().toLowerCase()))
    : sessions;

  if (isAdmin) {
    return (
      <aside className="w-56 shrink-0 flex flex-col bg-surface border-r border-line">
        {/* 品牌区 */}
        <div className="h-14 flex items-center gap-2.5 px-4 border-b border-line">
          <BrandMark />
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-fg leading-tight">EAG</div>
            <div className="text-[10px] text-fg-faint leading-tight">Admin Console</div>
          </div>
        </div>

        {/* 导航 */}
        <div className="px-3 pt-4 pb-1.5">
          <span className="text-[10px] font-semibold text-fg-faint uppercase tracking-[0.08em]">
            治理控制台
          </span>
        </div>
        <nav className="flex-1 px-2 space-y-0.5 overflow-y-auto">
          {ADMIN_NAV.map((item) => {
            const active = loc.pathname.startsWith(item.path);
            const Icon = item.icon;
            return (
              <button
                key={item.path}
                onClick={() => nav(item.path)}
                className={`item-interactive group relative w-full flex items-center gap-2.5 pl-3.5 pr-2.5 py-2 rounded-lg text-[13px] ${
                  active ? "item-active" : "text-fg-subtle"
                }`}
              >
                {/* 选中指示条 */}
                <span
                  className={`absolute left-0 top-1/2 -translate-y-1/2 w-0.5 rounded-r-full transition-all duration-150 ${
                    active ? "h-4 bg-primary" : "h-0 bg-transparent"
                  }`}
                />
                <Icon size={15} className={active ? "text-primary" : "text-fg-faint group-hover:text-fg-subtle"} />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* 返回工作区 */}
        <div className="p-2 border-t border-line">
          <button
            onClick={() => nav("/app")}
            className="group w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-[11px] text-fg-subtle hover:text-fg-muted hover:bg-n-850/60 transition-colors"
          >
            <IconArrowLeft size={14} className="text-fg-faint group-hover:text-fg-subtle" />
            返回工作区
          </button>
        </div>
      </aside>
    );
  }

  // ── 用户工作区侧边栏 ──────────────────────────────────────────────
  return (
    <aside className="w-56 shrink-0 flex flex-col bg-surface border-r border-line">
      <div className="h-14 flex items-center gap-2.5 px-4 border-b border-line">
        <BrandMark />
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-fg leading-tight">EAG</div>
          <div className="text-[10px] text-fg-faint leading-tight">Agent Workspace</div>
        </div>
      </div>

      {agentView ? (
        /* ── 会话列表（展开某个 Agent 后） ── */
        <>
          <div className="px-3 pt-3 pb-2">
            <button
              onClick={() => { setAgentView(null); nav("/app"); }}
              className="flex items-center gap-1.5 text-[11px] text-fg-subtle hover:text-fg-muted transition-colors"
            >
              <IconArrowLeft size={13} />
              所有助手
            </button>
            <div className="mt-2 text-[12.5px] font-medium text-fg truncate">
              {workers.find((w) => w.id === agentView)?.name ?? agentView}
            </div>
          </div>

          <div className="px-3 pb-2">
            <button
              onClick={() => {
                const s = createSession(agentView);
                nav(`/app/chat/${agentView}/${s.id}`);
              }}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-primary-strong hover:bg-primary text-white text-[12px] font-medium transition-colors"
            >
              <IconPlus size={14} />
              新会话
            </button>
          </div>

          {/* 会话搜索：会话较多时按标题过滤 */}
          {sessions.length > 3 && (
            <div className="px-3 pb-1.5">
              <div className="relative">
                <IconSearch size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-fg-faint pointer-events-none" />
                <input
                  value={sessionFilter}
                  onChange={(e) => setSessionFilter(e.target.value)}
                  placeholder="搜索会话…"
                  className="field !h-7 !pl-7 !text-[11.5px]"
                />
              </div>
            </div>
          )}

          <nav className="flex-1 px-2 space-y-0.5 overflow-y-auto">
            {sessions.length === 0 ? (
              <p className="px-3 py-2 text-[11px] text-fg-faint">暂无会话</p>
            ) : shownSessions.length === 0 ? (
              <p className="px-3 py-2 text-[11px] text-fg-faint">没有匹配的会话</p>
            ) : (
              groupSessions(shownSessions).map((g) => (
                <div key={g.key}>
                  {/* sticky 组头：置顶 / 今天 / 近 7 天 / 更早 */}
                  <div className="sticky top-0 z-10 flex items-center gap-1.5 px-3 pt-2.5 pb-1 bg-surface/95 backdrop-blur-sm text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-faint">
                    {g.key === "pinned" && <IconPin size={10} />}
                    {g.label}
                    <span className="opacity-60 font-normal normal-case tracking-normal">{g.sessions.length}</span>
                  </div>
                  {g.sessions.map((s) => {
                    const active = loc.pathname === `/app/chat/${s.workerId}/${s.id}`;
                    return (
                      <div key={s.id} className="group/item relative">
                        <button
                          onClick={() => nav(`/app/chat/${s.workerId}/${s.id}`)}
                          title={s.title}
                          className={`item-interactive w-full flex items-center gap-2 px-2.5 py-2 pr-14 rounded-lg text-[12.5px] ${
                            active ? "item-active" : "text-fg-subtle"
                          }`}
                        >
                          {s.unread ? (
                            <span className="shrink-0 size-1.5 rounded-full bg-primary" title="有新回复" />
                          ) : (
                            <IconChat size={12} className={active ? "text-primary shrink-0" : "text-fg-faint shrink-0"} />
                          )}
                          <span className={`truncate flex-1 text-left ${s.unread ? "text-fg font-medium" : ""}`}>
                            {s.title}
                          </span>
                          {s.pinned && <IconPin size={11} className="shrink-0 text-fg-faint" />}
                        </button>
                        <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 group-hover/item:opacity-100 transition-opacity">
                          <button
                            onClick={(e) => { e.stopPropagation(); pinSession(s.id, !s.pinned); setTick((v) => v + 1); }}
                            title={s.pinned ? "取消置顶" : "置顶"}
                            className={`p-1 rounded transition-colors ${
                              s.pinned
                                ? "text-primary hover:bg-primary-bg"
                                : "text-fg-faint hover:text-primary hover:bg-primary-bg"
                            }`}
                          >
                            <IconPin size={11} />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); removeSession(s); }}
                            title="删除会话"
                            className="p-1 rounded text-fg-faint hover:text-red hover:bg-red-bg transition-colors"
                          >
                            <IconTrash size={11} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </nav>
        </>
      ) : (
        /* ── 助手列表 ── */
        <>
          {/* 全部动态：跨 Agent 时间线入口（PRD-001 R3） */}
          <div className="px-2 pt-3">
            <button
              onClick={() => nav("/app/activity")}
              className={`item-interactive group relative w-full flex items-center gap-2.5 pl-3.5 pr-2.5 py-2 rounded-lg text-[13px] ${
                loc.pathname.startsWith("/app/activity") ? "item-active" : "text-fg-subtle"
              }`}
            >
              <span
                className={`absolute left-0 top-1/2 -translate-y-1/2 w-0.5 rounded-r-full transition-all duration-150 ${
                  loc.pathname.startsWith("/app/activity") ? "h-4 bg-primary" : "h-0 bg-transparent"
                }`}
              />
              <IconClock size={15} className={loc.pathname.startsWith("/app/activity") ? "text-primary" : "text-fg-faint group-hover:text-fg-subtle"} />
              <span className="truncate">全部动态</span>
            </button>
          </div>

          <div className="px-3 pt-3 pb-1">
            <div className="flex items-center gap-1.5 mb-2">
              <span className="text-[10px] font-semibold text-fg-faint uppercase tracking-[0.08em]">
                我的助手
              </span>
              {workers.length > 0 && (
                <span className="text-[10px] text-fg-faint">{workers.length}</span>
              )}
            </div>
          </div>

          <nav className="flex-1 px-2 space-y-0.5 overflow-y-auto">
            {loadingAgents ? (
              <div className="space-y-1.5 px-1">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="animate-shimmer h-8 rounded-md" />
                ))}
              </div>
            ) : workers.length === 0 ? (
              <p className="px-3 py-2 text-[11px] text-fg-faint">尚未分配到助手</p>
            ) : (
              workers.map((w) => {
                const active = loc.pathname.startsWith(`/app/chat/${w.id}`);
                const running = w.status === "running";
                const isNew = !seenAgents.has(w.id);
                return (
                  <button
                    key={w.id}
                    onClick={() => { markAgentsSeen([w.id]); nav(`/app/chat/${w.id}`); }}
                    title={w.description || w.name}
                    className={`item-interactive group w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[13px] ${
                      active ? "item-active" : "text-fg-subtle"
                    }`}
                  >
                    <span className="relative flex items-center justify-center shrink-0">
                      <span className={`w-1.5 h-1.5 rounded-full ${running ? "bg-green" : "bg-n-600"}`} />
                      {running && <span className="absolute w-1.5 h-1.5 rounded-full bg-green animate-breathe-soft" />}
                    </span>
                    <span className="truncate flex-1 text-left">{w.name}</span>
                    {isNew && (
                      <span className="shrink-0 text-[9px] font-bold px-1 py-px rounded bg-primary text-white" title="新分配给你的助手">
                        NEW
                      </span>
                    )}
                    <IconChevronRight size={13} className="text-fg-faint shrink-0" />
                  </button>
                );
              })
            )}
          </nav>
        </>
      )}

      {canConsole && (
        <div className="p-2 border-t border-line">
          <button
            onClick={() => nav("/admin/workers")}
            className="group w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-[11px] text-fg-subtle hover:text-fg-muted hover:bg-n-850/60 transition-colors"
          >
            <IconShield size={14} className="text-fg-faint group-hover:text-fg-subtle" />
            管理控制台
            <IconChevronRight size={13} className="ml-auto text-fg-faint" />
          </button>
        </div>
      )}
    </aside>
  );
}
