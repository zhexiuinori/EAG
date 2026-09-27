import { useEffect, useMemo, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  IconShield,
  IconChat, IconArrowLeft, IconPlus, IconSparkle, IconChevronRight, IconChevronDown,
  IconTrash, IconSearch, IconPin, IconBook, IconClock, IconLogout,
} from "./icons.tsx";
import { Modal } from "./Modal.tsx";
import { useToast } from "./Toast.tsx";
import * as ipc from "../lib/ipc.ts";
import { useWorkerStore } from "../stores/workerStore.ts";
import { useUserStore } from "../stores/userStore.ts";
import { useApprovalStore, countPendingApprovals } from "../stores/approvalStore.ts";
import { moduleOfPath } from "./adminNav.ts";
import { getSeenAgentIds, markAgentsSeen } from "../lib/seen.ts";
import { listSessions, createSession, deleteSession, pinSession, type ChatSession } from "../lib/sessions.ts";

interface Props { isAdmin: boolean }

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
  const approvals = useApprovalStore((s) => s.approvals);
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

  /** 单层会话树：各 Agent 分组的折叠状态（key = workerId，true = 折叠） */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [sessionFilter, setSessionFilter] = useState("");
  const [tick, setTick] = useState(0);
  const userId = useUserStore((s) => s.session?.userId);

  /** 各 Agent 的会话列表（按用户隔离；localStorage 读取，随 tick / 路径 / 助手列表刷新） */
  const sessionsByWorker = useMemo(() => {
    if (!userId) return {} as Record<string, ChatSession[]>;
    const map: Record<string, ChatSession[]> = {};
    for (const w of workers) map[w.id] = listSessions(w.id);
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workers, tick, userId, loc.pathname]);

  // 进入聊天页时确保对应 Agent 分组处于展开状态
  useEffect(() => {
    const matched = loc.pathname.match(/^\/app\/chat\/([^/]+)/);
    if (matched) {
      const wid = matched[1];
      setCollapsed((c) => (c[wid] ? { ...c, [wid]: false } : c));
    }
  }, [loc.pathname]);

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

  const searching = sessionFilter.trim().length > 0;
  const filterSessions = (list: ChatSession[]) =>
    searching
      ? list.filter((s) => s.title.toLowerCase().includes(sessionFilter.trim().toLowerCase()))
      : list;

  /** 单个会话项（会话树叶子节点） */
  const renderSessionItem = (s: ChatSession) => {
    const active = loc.pathname === `/app/chat/${s.workerId}/${s.id}`;
    return (
      <div key={s.id} className="group/item relative">
        <button
          onClick={() => nav(`/app/chat/${s.workerId}/${s.id}`)}
          title={s.title}
          className={`item-interactive w-full flex items-center gap-2 pl-7 pr-14 py-1.5 rounded-lg text-[12.5px] ${
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
  };

  if (isAdmin) {
    // 管理端：顶 header 已有品牌与模块 tab，左侧为「当前模块」的子菜单（Dolphin 控制台形态）
    const mod = moduleOfPath(loc.pathname);
    const pendingApprovals = countPendingApprovals(approvals);
    return (
      <aside className="w-52 shrink-0 flex flex-col bg-surface border-r border-line">
        {/* 当前模块名 */}
        <div className="h-14 flex items-center px-4 border-b border-line">
          <span className="text-[13px] font-semibold text-fg">{mod?.label ?? "管理控制台"}</span>
        </div>

        {/* 模块内页面 */}
        <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
          {(mod?.pages ?? []).map((item) => {
            const active = loc.pathname.startsWith(item.path);
            const Icon = item.icon;
            const badge = item.path === "/admin/inbox" ? pendingApprovals : 0;
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
                {badge > 0 && (
                  <span className="ml-auto min-w-[16px] h-[16px] px-1 rounded-full bg-yellow text-n-1000 text-[9px] font-bold flex items-center justify-center tabular-nums">
                    {badge > 99 ? "99+" : badge}
                  </span>
                )}
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

      {/* 会话搜索：跨全部 Agent 按标题过滤 */}
      <div className="px-3 pt-2.5">
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

      {/* 单层会话树：按 Agent 分组，组头可折叠 / 一键新会话，会话直接平铺（Dolphin 形态） */}
      <nav className="flex-1 px-2 pt-2 space-y-1 overflow-y-auto">
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
            const list = filterSessions(sessionsByWorker[w.id] ?? []);
            const isCollapsed = !searching && !!collapsed[w.id];
            const running = w.status === "running";
            const isNew = !seenAgents.has(w.id);
            return (
              <div key={w.id}>
                {/* Agent 组头：点击折叠/展开，悬停出现「+」新会话 */}
                <div className="group/agent relative">
                  <button
                    onClick={() => {
                      markAgentsSeen([w.id]);
                      setCollapsed((c) => ({ ...c, [w.id]: !c[w.id] }));
                    }}
                    title={w.description || w.name}
                    className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-[12px] font-medium text-fg-muted hover:bg-n-850/60 transition-colors"
                  >
                    <IconChevronDown
                      size={12}
                      className={`shrink-0 text-fg-faint transition-transform ${isCollapsed ? "-rotate-90" : ""}`}
                    />
                    <span className="relative flex items-center justify-center shrink-0">
                      <span className={`w-1.5 h-1.5 rounded-full ${running ? "bg-green" : "bg-n-600"}`} />
                      {running && <span className="absolute w-1.5 h-1.5 rounded-full bg-green animate-breathe-soft" />}
                    </span>
                    <span className="truncate flex-1 text-left pr-5">{w.name}</span>
                    {isNew && (
                      <span className="shrink-0 text-[9px] font-bold px-1 py-px rounded bg-primary text-white" title="新分配给你的助手">
                        NEW
                      </span>
                    )}
                  </button>
                  <button
                    onClick={() => {
                      markAgentsSeen([w.id]);
                      const s = createSession(w.id);
                      nav(`/app/chat/${w.id}/${s.id}`);
                    }}
                    title={`与 ${w.name} 开始新会话`}
                    className="absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded opacity-0 group-hover/agent:opacity-100 text-fg-faint hover:text-primary hover:bg-primary-bg transition-all"
                  >
                    <IconPlus size={12} />
                  </button>
                </div>

                {/* 该 Agent 的会话列表 */}
                {!isCollapsed && (
                  <div className="mt-0.5 space-y-0.5">
                    {list.length === 0 ? (
                      <p className="pl-7 py-1 text-[10.5px] text-fg-faint">
                        {searching ? "无匹配会话" : "暂无会话"}
                      </p>
                    ) : (
                      list.map(renderSessionItem)
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </nav>

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
