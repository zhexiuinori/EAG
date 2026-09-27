import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import Button from "../components/Button.tsx";
import EmptyState from "../components/EmptyState.tsx";
import Dropdown, { MenuItem, MenuDivider } from "../components/Dropdown.tsx";
import { useWorkerStore } from "../stores/workerStore.ts";
import { useUserStore } from "../stores/userStore.ts";
import { getSeenAgentIds, markAgentsSeen } from "../lib/seen.ts";
import { createSession, listAllSessions, type ChatSession } from "../lib/sessions.ts";
import {
  IconWorkspace, IconChat, IconClock, IconShield, IconSparkle,
  IconSend, IconPlus, IconChevronDown, IconCheck,
} from "../components/icons.tsx";

/** 最近会话数量上限 */
const RECENT_LIMIT = 5;

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

/** 按时段的问候语 */
function greeting(): string {
  const h = new Date().getHours();
  if (h < 6) return "夜深了";
  if (h < 12) return "上午好";
  if (h < 14) return "中午好";
  if (h < 18) return "下午好";
  return "晚上好";
}

/** 可读的助手类型 */
function typeLabel(type: string): string {
  return type === "personal" ? "个人" : "项目";
}

/** 引擎标识色（Dolphin 形态：卡片用引擎色头像区分助手类型） */
const ENGINE_COLOR: Record<string, string> = {
  pi: "bg-primary-strong",
  claude: "bg-yellow",
  codex: "bg-green",
};

/** 记住用户上次选用的助手（按用户隔离） */
function savedAgentKey(userId: string | undefined): string {
  return `eag-portal-agent:${userId ?? "anon"}`;
}

/**
 * 用户端首页（Dolphin 形态：会话优先 Portal）。
 *
 * 不再是仪表盘式概览 —— 用户进来第一件事是"找助手说话"：
 * 居中的问候 + 大输入框（选助手、直接开聊）+ 助手卡片 + 最近会话。
 */
export default function Workspace() {
  const nav = useNavigate();

  // 助手列表走全局缓存（与 Sidebar / WorkChat 共用同一份数据）
  const workers = useWorkerStore((s) => s.mine);
  const loadedWorkers = useWorkerStore((s) => s.loadedMine);
  const loadMine = useWorkerStore((s) => s.loadMine);

  const userId = useUserStore((s) => s.session?.userId);
  const userName = useUserStore((s) => s.session?.userName);
  const canConsole = useUserStore(
    (s) => !!s.session && (s.session.role === "admin" || s.session.canManageConsole),
  );

  const [recent, setRecent] = useState<ChatSession[]>([]);
  const loading = !loadedWorkers;

  // 大输入框：选定助手 + 首条消息
  const [draft, setDraft] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!userId) return;
    setRecent(listAllSessions(RECENT_LIMIT));
  }, [userId]);

  // 身份就绪/切换后加载可见 Agent
  useEffect(() => {
    if (!userId) return;
    void loadMine();
  }, [userId, loadMine]);

  // 选定助手：已选且仍可见 > 上次使用 > 列表第一个
  useEffect(() => {
    if (workers.length === 0) return;
    setSelectedId((cur) => {
      if (cur && workers.some((w) => w.id === cur)) return cur;
      const saved = localStorage.getItem(savedAgentKey(userId));
      if (saved && workers.some((w) => w.id === saved)) return saved;
      return workers[0].id;
    });
  }, [workers, userId]);

  // 输入框随内容增长（上限 160px）
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);

  const selected = workers.find((w) => w.id === selectedId) ?? null;

  const chooseAgent = (id: string) => {
    setSelectedId(id);
    localStorage.setItem(savedAgentKey(userId), id);
  };

  /** 从首页直接开聊：先建会话，把首条消息经路由 state 带进会话页自动发出 */
  const startChat = () => {
    const text = draft.trim();
    if (!text || !selected) return;
    markAgentsSeen([selected.id]);
    const s = createSession(selected.id);
    nav(`/app/chat/${selected.id}/${s.id}`, { state: { prompt: text } });
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 pt-[9vh] pb-16">
        {/* 问候区 */}
        <div className="text-center mb-8 animate-in">
          <div className="mx-auto size-12 rounded-2xl bg-gradient-to-br from-primary to-primary-strong flex items-center justify-center brand-glow mb-4">
            <IconSparkle size={22} className="text-white" />
          </div>
          <h1 className="text-[24px] font-semibold text-fg tracking-tight">
            {greeting()}，{userName ?? "朋友"}
          </h1>
          <p className="text-[13px] text-fg-subtle mt-1.5">
            选择一个助手开始工作，或直接说出你的任务
          </p>
        </div>

        {/* 大输入框：助手选择 + 首条消息 */}
        {workers.length > 0 && (
          <div className="rounded-2xl border border-line bg-surface shadow-lg shadow-black/10 focus-within:border-primary-border transition-colors animate-in">
            <textarea
              ref={taRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  startChat();
                }
              }}
              rows={3}
              placeholder={selected ? `交给「${selected.name}」去做…` : "输入你的任务…"}
              className="w-full max-h-[160px] px-4 pt-3.5 pb-2 bg-transparent text-[13.5px] leading-relaxed text-fg placeholder-fg-faint outline-none resize-none"
            />
            <div className="flex items-center gap-2 px-3 pb-3">
              {/* 助手选择 */}
              <Dropdown
                widthClass="w-64"
                trigger={() => (
                  <button
                    title="选择要对话的助手"
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-n-900 border border-line hover:border-line-strong text-[12px] text-fg-muted transition-colors"
                  >
                    <span className={`size-4 rounded flex items-center justify-center text-[9px] font-bold text-white shrink-0 ${ENGINE_COLOR[selected?.config.agentKind ?? ""] ?? "bg-n-700"}`}>
                      {(selected?.name ?? "?").slice(0, 1)}
                    </span>
                    <span className="max-w-[140px] truncate">{selected?.name ?? "选择助手"}</span>
                    <IconChevronDown size={11} className="text-fg-faint" />
                  </button>
                )}
              >
                {(close) => (
                  <>
                    <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-faint">
                      我的助手
                    </div>
                    <div className="max-h-64 overflow-y-auto">
                      {workers.map((w) => (
                        <MenuItem
                          key={w.id}
                          active={w.id === selectedId}
                          label={w.name}
                          hint={w.id === selectedId ? <IconCheck size={12} className="text-primary" /> : undefined}
                          onClick={() => { chooseAgent(w.id); close(); }}
                        />
                      ))}
                    </div>
                    <MenuDivider />
                    <div className="px-3 py-1.5 text-[10px] text-fg-faint">
                      Enter 发送 · Shift+Enter 换行
                    </div>
                  </>
                )}
              </Dropdown>

              <div className="flex-1" />

              <button
                onClick={startChat}
                disabled={!draft.trim() || !selected}
                title="开始对话（Enter）"
                className="flex items-center gap-1.5 px-4 py-1.5 bg-primary-strong hover:bg-primary disabled:opacity-40 disabled:cursor-not-allowed text-white text-[12px] font-medium rounded-lg transition-colors"
              >
                <IconSend size={12} />
                发送
              </button>
            </div>
          </div>
        )}

        {/* 助手卡片 */}
        <div className="mt-10">
          <div className="flex items-center gap-1.5 mb-3">
            <IconWorkspace size={13} className="text-fg-faint" />
            <h2 className="text-[10.5px] font-semibold text-fg-faint uppercase tracking-[0.06em]">
              我的助手
            </h2>
            {canConsole && (
              <button
                onClick={() => nav("/admin/workers")}
                className="ml-auto flex items-center gap-1 text-[11px] text-fg-faint hover:text-primary transition-colors"
              >
                <IconShield size={12} />
                管理控制台
              </button>
            )}
          </div>

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
                const running = w.status === "running";
                const isNew = !getSeenAgentIds().has(w.id);
                return (
                  <button
                    key={w.id}
                    onClick={() => { markAgentsSeen([w.id]); nav(`/app/chat/${w.id}`); }}
                    className="card card-hover text-left p-4 group"
                  >
                    <div className="flex items-center gap-2.5 mb-2">
                      <span className={`size-8 rounded-lg flex items-center justify-center text-[13px] font-bold text-white shrink-0 ${ENGINE_COLOR[w.config.agentKind ?? ""] ?? "bg-n-700"}`}>
                        {w.name.slice(0, 1)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[13px] font-medium text-fg truncate">{w.name}</span>
                          {isNew && (
                            <span className="shrink-0 text-[9px] font-bold px-1 py-px rounded bg-primary text-white" title="新分配给你的助手">
                              NEW
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1 mt-0.5">
                          <span className="relative flex items-center justify-center shrink-0">
                            <span className={`w-1.5 h-1.5 rounded-full ${running ? "bg-green" : "bg-n-600"}`} />
                            {running && <span className="absolute w-1.5 h-1.5 rounded-full bg-green animate-breathe-soft" />}
                          </span>
                          <span className="text-[10.5px] text-fg-faint">
                            {running ? "运行中" : "空闲"} · {typeLabel(w.type)}
                          </span>
                        </div>
                      </div>
                      <IconChat
                        size={14}
                        className="shrink-0 text-fg-faint group-hover:text-primary transition-colors"
                      />
                    </div>

                    <p className="text-[12px] text-fg-subtle line-clamp-2 min-h-[2.1rem]">
                      {w.description || "暂无描述"}
                    </p>

                    <div className="mt-3 flex items-center gap-2 flex-wrap">
                      <span className="text-[11px] text-fg-muted">
                        模型 · {w.config.modelName || "默认"}
                      </span>
                      {w.config.auditEnabled && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary-bg text-primary border border-primary-border" title="该助手的操作受策略约束并记录审计">
                          受控
                        </span>
                      )}
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
                    </div>
                  </button>
                );
              })}

              {/* 新建助手（管理员入口） */}
              {canConsole && (
                <button
                  onClick={() => nav("/admin/workers")}
                  className="rounded-xl border border-dashed border-line-strong text-fg-faint hover:text-primary hover:border-primary-border transition-colors p-4 flex flex-col items-center justify-center gap-1.5 min-h-[104px]"
                >
                  <IconPlus size={18} />
                  <span className="text-[12px] font-medium">新建助手</span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* 最近会话 */}
        {recent.length > 0 && (
          <div className="mt-8">
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
    </div>
  );
}
