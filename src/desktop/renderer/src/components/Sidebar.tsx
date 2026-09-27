import { useCallback, useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  IconWorkspace, IconNetwork, IconSliders, IconList, IconShield, IconUsers,
  IconChat, IconArrowLeft, IconPlus, IconSparkle, IconChevronRight, IconChevronDown,
  IconTrash, IconSearch, IconPin, IconInbox, IconGauge, IconBook, IconClock, IconLogout,
} from "./icons.tsx";
import { Modal } from "./Modal.tsx";
import { useToast } from "./Toast.tsx";
import * as ipc from "../lib/ipc.ts";
import type { ScheduledJob } from "@shared/types.ts";
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
  const userName = useUserStore((s) => s.session?.userName);
  const logout = useUserStore((s) => s.logout);
  /** 底部用户区菜单 / 记忆管理弹窗 */
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);

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

          {/* 定时任务区（Dolphin 形态）：当前助手的无人值守任务 */}
          <ScheduleSection workerId={agentView} />
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

      {/* 底部：管理控制台入口 + 用户区（Dolphin 形态） */}
      <div className="p-2 border-t border-line space-y-0.5">
        {canConsole && (
          <button
            onClick={() => nav("/admin/workers")}
            className="group w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-[11px] text-fg-subtle hover:text-fg-muted hover:bg-n-850/60 transition-colors"
          >
            <IconShield size={14} className="text-fg-faint group-hover:text-fg-subtle" />
            管理控制台
            <IconChevronRight size={13} className="ml-auto text-fg-faint" />
          </button>
        )}

        <div className="relative">
          {userMenuOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setUserMenuOpen(false)} />
              <div className="absolute bottom-full left-0 right-0 mb-1 z-40 rounded-lg border border-line bg-elevated shadow-xl p-1 animate-in">
                <button
                  onClick={() => { setUserMenuOpen(false); setMemoryOpen(true); }}
                  className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-[12px] text-fg-subtle hover:text-fg hover:bg-n-850/60 transition-colors"
                >
                  <IconBook size={13} className="text-fg-faint" />
                  记忆管理
                </button>
                <button
                  onClick={() => { setUserMenuOpen(false); void logout().finally(() => nav("/login")); }}
                  className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-[12px] text-red hover:bg-red-bg transition-colors"
                >
                  <IconLogout size={13} />
                  退出登录
                </button>
              </div>
            </>
          )}
          <button
            onClick={() => setUserMenuOpen((v) => !v)}
            title="账户"
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-n-850/60 transition-colors"
          >
            <span className="size-6 rounded-full bg-primary-strong text-white flex items-center justify-center text-[11px] font-semibold shrink-0">
              {(userName ?? "?").slice(0, 1).toUpperCase()}
            </span>
            <span className="text-[12px] text-fg truncate flex-1 text-left">{userName ?? "未登录"}</span>
            <IconChevronDown size={12} className={`text-fg-faint transition-transform ${userMenuOpen ? "rotate-180" : ""}`} />
          </button>
        </div>
      </div>

      <MemoryModal open={memoryOpen} onClose={() => setMemoryOpen(false)} />
    </aside>
  );
}

/**
 * 定时任务区（Dolphin 形态）：当前助手的无人值守任务。
 * 定时任务属治理域（服务端 /admin/schedules）：无权限时整区静默隐藏，不打扰普通用户。
 */
function ScheduleSection({ workerId }: { workerId: string }) {
  const toast = useToast();
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [available, setAvailable] = useState(true);
  const [open, setOpen] = useState(true);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  // 新建表单：触发规则二选一（每天 HH:MM / 每 N 分钟），与 ScheduledJob 模型一致
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<"daily" | "every">("daily");
  const [dailyAt, setDailyAt] = useState("09:00");
  const [everyMinutes, setEveryMinutes] = useState("60");

  const load = useCallback(() => {
    ipc.scheduleList()
      .then((r) => {
        setAvailable(true);
        setJobs((r.jobs ?? []).filter((j) => j.workerId === workerId));
      })
      .catch(() => setAvailable(false));
  }, [workerId]);

  useEffect(() => { load(); }, [load]);

  if (!available) return null;

  const describe = (j: ScheduledJob) =>
    j.everyMinutes ? `每 ${j.everyMinutes} 分钟` : j.dailyAt ? `每天 ${j.dailyAt}` : "未设置触发";

  const submit = async () => {
    const n = name.trim();
    const p = prompt.trim();
    if (!n || !p) {
      toast.error("请填写任务名称和任务内容");
      return;
    }
    const minutes = Number(everyMinutes);
    if (mode === "every" && (!Number.isFinite(minutes) || minutes < 1)) {
      toast.error("间隔分钟数需 ≥ 1");
      return;
    }
    setBusy(true);
    try {
      await ipc.scheduleUpsert({
        name: n,
        workerId,
        prompt: p,
        enabled: true,
        ...(mode === "every" ? { everyMinutes: minutes } : { dailyAt }),
      });
      toast.success("定时任务已创建");
      setCreating(false);
      setName("");
      setPrompt("");
      load();
    } catch (e: any) {
      toast.error(`创建失败：${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  };

  const toggleEnabled = async (j: ScheduledJob) => {
    try {
      await ipc.scheduleUpsert({
        id: j.id,
        name: j.name,
        workerId: j.workerId,
        prompt: j.prompt,
        everyMinutes: j.everyMinutes,
        dailyAt: j.dailyAt,
        enabled: !j.enabled,
      });
      load();
    } catch (e: any) {
      toast.error(`操作失败：${e?.message ?? e}`);
    }
  };

  const remove = async (j: ScheduledJob) => {
    try {
      await ipc.scheduleDelete({ id: j.id });
      toast.success("定时任务已删除");
      load();
    } catch (e: any) {
      toast.error(`删除失败：${e?.message ?? e}`);
    }
  };

  return (
    <div className="border-t border-line">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1.5 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-faint hover:text-fg-subtle transition-colors"
      >
        <IconClock size={11} />
        定时任务
        <span className="opacity-60 font-normal normal-case tracking-normal">{jobs.length}</span>
        <IconChevronDown size={11} className={`ml-auto transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>

      {open && (
        <div className="px-2 pb-2 space-y-0.5 max-h-44 overflow-y-auto">
          {jobs.length === 0 ? (
            <p className="px-2 py-1 text-[11px] text-fg-faint">暂无定时任务</p>
          ) : (
            jobs.map((j) => (
              <div key={j.id} className="group/job flex items-center gap-1.5 px-2 py-1.5 rounded-md hover:bg-n-850/60">
                <span
                  className={`shrink-0 w-1.5 h-1.5 rounded-full ${j.enabled ? "bg-green" : "bg-n-600"}`}
                  title={j.enabled ? "已启用" : "已停用"}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-[11.5px] text-fg-muted truncate" title={j.prompt}>{j.name}</div>
                  <div className="text-[10px] text-fg-faint">
                    {describe(j)}
                    {j.lastStatus === "error" && <span className="text-red"> · 上次执行失败</span>}
                  </div>
                </div>
                <div className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover/job:opacity-100 transition-opacity">
                  <button
                    onClick={() => void toggleEnabled(j)}
                    title={j.enabled ? "停用" : "启用"}
                    className="p-1 rounded text-fg-faint hover:text-primary hover:bg-primary-bg transition-colors"
                  >
                    <IconClock size={11} />
                  </button>
                  <button
                    onClick={() => void remove(j)}
                    title="删除"
                    className="p-1 rounded text-fg-faint hover:text-red hover:bg-red-bg transition-colors"
                  >
                    <IconTrash size={11} />
                  </button>
                </div>
              </div>
            ))
          )}
          <button
            onClick={() => setCreating(true)}
            className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md text-[11px] text-fg-faint hover:text-primary hover:bg-primary-bg/50 transition-colors"
          >
            <IconPlus size={12} />
            新建定时任务
          </button>
        </div>
      )}

      <Modal
        open={creating}
        title="新建定时任务"
        onClose={() => setCreating(false)}
        footer={
          <>
            <button
              onClick={() => setCreating(false)}
              className="px-3 py-1.5 rounded-lg border border-line text-[12px] text-fg-subtle hover:text-fg-muted transition-colors"
            >
              取消
            </button>
            <button
              onClick={() => void submit()}
              disabled={busy}
              className="px-3 py-1.5 rounded-lg bg-primary-strong hover:bg-primary disabled:opacity-40 text-white text-[12px] font-medium transition-colors"
            >
              {busy ? "创建中…" : "创建"}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="block text-[11px] font-semibold text-fg-subtle mb-1.5">任务名称</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如：每日代码巡检"
              className="field !h-9"
            />
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-fg-subtle mb-1.5">任务内容（交给助手执行的指令）</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              placeholder="如：检查工作区内未提交的改动并给出整理建议"
              className="w-full px-3 py-2 bg-n-900 border border-line rounded-lg text-[12.5px] leading-relaxed text-fg placeholder-fg-faint outline-none focus:border-primary-border transition-colors resize-none"
            />
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-fg-subtle mb-1.5">触发方式</label>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setMode("daily")}
                className={`px-2.5 py-1.5 rounded-lg border text-[11.5px] transition-colors ${
                  mode === "daily"
                    ? "bg-primary-bg border-primary-border text-primary"
                    : "border-line text-fg-subtle hover:text-fg-muted"
                }`}
              >
                每天
              </button>
              <button
                onClick={() => setMode("every")}
                className={`px-2.5 py-1.5 rounded-lg border text-[11.5px] transition-colors ${
                  mode === "every"
                    ? "bg-primary-bg border-primary-border text-primary"
                    : "border-line text-fg-subtle hover:text-fg-muted"
                }`}
              >
                每隔 N 分钟
              </button>
              {mode === "daily" ? (
                <input
                  type="time"
                  value={dailyAt}
                  onChange={(e) => setDailyAt(e.target.value)}
                  className="field !h-9 !w-28"
                />
              ) : (
                <input
                  type="number"
                  min={1}
                  value={everyMinutes}
                  onChange={(e) => setEveryMinutes(e.target.value)}
                  className="field !h-9 !w-28"
                />
              )}
            </div>
            <p className="mt-1.5 text-[10.5px] text-fg-faint">
              执行同样受治理：预算检查、策略、审计一个不少
            </p>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/** 记忆管理：各助手沉淀的长期记忆（治理透明化；只读视图） */
function MemoryModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const workers = useWorkerStore((s) => s.mine);
  const [items, setItems] = useState<Array<{ id: string; name: string; summary?: string }> | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setItems(null);
    void Promise.all(
      workers.map(async (w) => {
        const s = await ipc.workerStatus({ id: w.id }).catch(() => null);
        return { id: w.id, name: w.name, summary: s?.memorySummary };
      }),
    ).then((r) => { if (alive) setItems(r); });
    return () => { alive = false; };
  }, [open, workers]);

  return (
    <Modal open={open} title="记忆管理" onClose={onClose}>
      {items === null ? (
        <p className="text-[12px] text-fg-faint">读取中…</p>
      ) : items.length === 0 ? (
        <p className="text-[12px] text-fg-faint">还没有分配到助手</p>
      ) : (
        <div className="space-y-3 max-h-80 overflow-y-auto">
          {items.map((it) => (
            <div key={it.id}>
              <div className="text-[11px] font-medium text-fg mb-1">{it.name}</div>
              {it.summary ? (
                <p className="text-[11.5px] text-fg-subtle leading-relaxed rounded-lg border border-line bg-n-900/50 px-3 py-2">
                  {it.summary}
                </p>
              ) : (
                <p className="text-[11px] text-fg-faint">未开启长期记忆（对话后自动积累）</p>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
