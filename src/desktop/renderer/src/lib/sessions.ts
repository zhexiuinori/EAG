/**
 * 会话存储。
 *
 * 修复的问题：此前一个 Worker 只对应一条对话（key = `eag-chat-{workerId}`），
 * 无法新建会话，"新建对话"按钮实际上只是跳回首页。
 *
 * 现在：Worker 是 Agent 定义，其下可以有 N 个会话。
 *   · 索引：localStorage["eag-sessions"]        —— 不含消息体，避免体积膨胀
 *   · 消息：localStorage["eag-session-{id}"]    —— 每会话独立
 *   · 旧数据：首次访问某 Worker 时自动迁移为一个会话
 */

export interface ToolCard {
  name: string;
  target?: string;
  status: "running" | "ok" | "error";
  /** 工具入参（格式化后的 JSON，截断），供卡片展开查看 */
  detail?: string;
  /** 工具结果摘要（截断），供卡片展开查看 */
  result?: string;
}

export interface ChatMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  tool?: ToolCard;
  /** cost 事件记录的单轮成本，用于用量统计 */
  costUsd?: number;
  /** 计划模式下产出的"执行计划"（消息下方提供一键执行） */
  plan?: boolean;
}

export interface ChatSession {
  id: string;
  workerId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** 置顶（排序优先） */
  pinned?: boolean;
  /** 有新回复但用户尚未查看（参考 QwenPaw 的注意力体系） */
  unread?: boolean;
}

const LEGACY_PREFIX = "eag-chat-";

/** 单个会话保留的最大消息数 */
const MAX_MESSAGES = 200;

const TITLE_MAX = 24;

// ---------------------------------------------------------------------------
// 存储键：按用户隔离
// ---------------------------------------------------------------------------

/**
 * 会话按用户隔离。
 *
 * 此前索引与消息使用全局 key（eag-sessions / eag-session-*）：同机切换身份后，
 * 用户 A 的会话会出现在用户 B 的侧栏里，消息也可被 B 读到 —— 隔离缺陷。
 * 现在所有 key 都带当前用户前缀；旧全局数据由首个登录用户一次性继承。
 * 当前用户由 userStore 在会话就绪后写入 localStorage["eag-current-user"]。
 */
const CURRENT_USER_KEY = "eag-current-user";
const LEGACY_INDEX_KEY = "eag-sessions";

function userScope(): string {
  try {
    return localStorage.getItem(CURRENT_USER_KEY) || "anon";
  } catch {
    return "anon";
  }
}

function indexKey(): string {
  return `eag-sessions:${userScope()}`;
}

function msgKey(sessionId: string): string {
  return `eag-session:${userScope()}:${sessionId}`;
}

/** 一次性迁移：旧版全局数据（无用户维度）由首个登录用户继承。 */
function migrateGlobalData(): void {
  if (userScope() === "anon") return; // 身份未就绪，暂不迁移
  try {
    const globalIndex = localStorage.getItem(LEGACY_INDEX_KEY);
    if (!globalIndex) return;

    if (localStorage.getItem(indexKey())) {
      // 本用户已有自己的数据：仅清掉旧全局索引，避免其他用户误继承
      localStorage.removeItem(LEGACY_INDEX_KEY);
      return;
    }

    localStorage.setItem(indexKey(), globalIndex);
    localStorage.removeItem(LEGACY_INDEX_KEY);

    const list = JSON.parse(globalIndex) as ChatSession[];
    if (Array.isArray(list)) {
      for (const s of list) {
        const old = localStorage.getItem(`eag-session-${s.id}`);
        if (old) {
          localStorage.setItem(msgKey(s.id), old);
          localStorage.removeItem(`eag-session-${s.id}`);
        }
      }
    }
  } catch {
    // 迁移失败不阻塞使用
  }
}

// ---------------------------------------------------------------------------
// 索引读写
// ---------------------------------------------------------------------------

function readIndex(): ChatSession[] {
  migrateGlobalData();
  try {
    const raw = JSON.parse(localStorage.getItem(indexKey()) || "[]");
    return Array.isArray(raw) ? (raw as ChatSession[]) : [];
  } catch {
    return [];
  }
}

function writeIndex(list: ChatSession[]): void {
  try {
    localStorage.setItem(indexKey(), JSON.stringify(list));
  } catch {
    // 存储配额满时静默失败，不影响对话
  }
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

/** 由首条用户消息推导标题 */
export function deriveTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  const text = (firstUser?.content ?? "").trim().replace(/\s+/g, " ");
  if (!text) return "新对话";
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX)}…` : text;
}

/** 置顶优先，其次按最近更新。 */
function compareSessions(a: ChatSession, b: ChatSession): number {
  if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
  return b.updatedAt.localeCompare(a.updatedAt);
}

export interface SessionGroup {
  key: "pinned" | "today" | "week" | "earlier";
  label: string;
  sessions: ChatSession[];
}

/** 按 置顶 / 今天 / 近 7 天 / 更早 分组（参考 QwenPaw 的日期分组 + sticky 组头）。 */
export function groupSessions(list: ChatSession[]): SessionGroup[] {
  const pinned: ChatSession[] = [];
  const today: ChatSession[] = [];
  const week: ChatSession[] = [];
  const earlier: ChatSession[] = [];

  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startWeek = startToday - 6 * 86_400_000;

  for (const s of list) {
    if (s.pinned) { pinned.push(s); continue; }
    const t = new Date(s.updatedAt).getTime();
    if (t >= startToday) today.push(s);
    else if (t >= startWeek) week.push(s);
    else earlier.push(s);
  }

  const groups: SessionGroup[] = [
    { key: "pinned", label: "置顶", sessions: pinned },
    { key: "today", label: "今天", sessions: today },
    { key: "week", label: "近 7 天", sessions: week },
    { key: "earlier", label: "更早", sessions: earlier },
  ];
  return groups.filter((g) => g.sessions.length > 0);
}

export function listSessions(workerId: string): ChatSession[] {
  return readIndex()
    .filter((s) => s.workerId === workerId)
    .sort(compareSessions);
}

/** 跨 Worker 的最近会话（工作区首页用） */
export function listAllSessions(limit = 10): ChatSession[] {
  return readIndex()
    .sort(compareSessions)
    .slice(0, limit);
}

export function getSession(id: string): ChatSession | undefined {
  return readIndex().find((s) => s.id === id);
}

export function createSession(workerId: string, title = "新对话"): ChatSession {
  const now = new Date().toISOString();
  const session: ChatSession = {
    id: `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    workerId,
    title,
    createdAt: now,
    updatedAt: now,
  };
  writeIndex([session, ...readIndex()]);
  return session;
}

/** 旧版单会话数据迁移：`eag-chat-{workerId}` → 一个正式会话 */
function migrateLegacy(workerId: string): ChatSession | undefined {
  const raw = localStorage.getItem(LEGACY_PREFIX + workerId);
  if (!raw) return undefined;

  try {
    const messages = JSON.parse(raw) as ChatMessage[];
    if (!Array.isArray(messages) || messages.length === 0) {
      localStorage.removeItem(LEGACY_PREFIX + workerId);
      return undefined;
    }
    const session = createSession(workerId, deriveTitle(messages));
    localStorage.setItem(msgKey(session.id), JSON.stringify(messages.slice(-MAX_MESSAGES)));
    localStorage.removeItem(LEGACY_PREFIX + workerId);
    return session;
  } catch {
    localStorage.removeItem(LEGACY_PREFIX + workerId);
    return undefined;
  }
}

/**
 * 解析要打开的会话：
 *   指定 id 且存在 → 用它
 *   有旧数据       → 迁移后使用
 *   已有会话       → 用最近一个
 *   都没有         → 新建
 */
export function ensureSession(workerId: string, sessionId?: string): ChatSession {
  if (sessionId) {
    const found = getSession(sessionId);
    if (found && found.workerId === workerId) return found;
  }

  const migrated = migrateLegacy(workerId);
  if (migrated) return migrated;

  const latest = listSessions(workerId)[0];
  if (latest) return latest;

  return createSession(workerId);
}

export function touchSession(sessionId: string): void {
  const list = readIndex();
  const idx = list.findIndex((s) => s.id === sessionId);
  if (idx === -1) return;
  list[idx] = { ...list[idx], updatedAt: new Date().toISOString() };
  writeIndex(list);
}

export function renameSession(sessionId: string, title: string): void {
  const list = readIndex();
  const idx = list.findIndex((s) => s.id === sessionId);
  if (idx === -1) return;
  const trimmed = title.trim();
  list[idx] = { ...list[idx], title: trimmed || list[idx].title, updatedAt: new Date().toISOString() };
  writeIndex(list);
}

export function deleteSession(sessionId: string): void {
  writeIndex(readIndex().filter((s) => s.id !== sessionId));
  try {
    localStorage.removeItem(msgKey(sessionId));
  } catch {
    // 忽略
  }
}

/** 置顶 / 取消置顶。 */
export function pinSession(sessionId: string, pinned: boolean): void {
  const list = readIndex();
  const idx = list.findIndex((s) => s.id === sessionId);
  if (idx === -1) return;
  list[idx] = { ...list[idx], pinned };
  writeIndex(list);
}

/** 标记会话有未读的新回复。 */
export function markSessionUnread(sessionId: string): void {
  const list = readIndex();
  const idx = list.findIndex((s) => s.id === sessionId);
  if (idx === -1 || list[idx].unread) return;
  list[idx] = { ...list[idx], unread: true };
  writeIndex(list);
}

/** 清除会话的未读标记（用户回到该会话查看时调用）。 */
export function markSessionRead(sessionId: string): void {
  const list = readIndex();
  const idx = list.findIndex((s) => s.id === sessionId);
  if (idx === -1 || !list[idx].unread) return;
  list[idx] = { ...list[idx], unread: false };
  writeIndex(list);
}

// ---------------------------------------------------------------------------
// 消息
// ---------------------------------------------------------------------------

export function loadMessages(sessionId: string): ChatMessage[] {
  try {
    const raw = JSON.parse(localStorage.getItem(msgKey(sessionId)) || "[]");
    return Array.isArray(raw) ? (raw as ChatMessage[]) : [];
  } catch {
    return [];
  }
}

export function saveMessages(sessionId: string, messages: ChatMessage[]): void {
  try {
    localStorage.setItem(msgKey(sessionId), JSON.stringify(messages.slice(-MAX_MESSAGES)));
  } catch {
    // 忽略配额错误
  }
  touchSession(sessionId);
}
