// ---------------------------------------------------------------------------
// EAG — 记忆存储（Memory）
//
// 把 Agent 会话从"前端 localStorage"（一次性的，换机器即丢）迁到后端持久化。
// 这是记忆能力的**地基**：先有可持久化、可检索的存储，才谈得上后续
// L0-L3 分层沉淀、记忆注入、Worker Loadout。
//
// 设计（ponytail：最小可用，不引数据库）：
//   · 按用户 + Worker + 会话隔离，落 JSON 文件到 <root>/.eag/memory/<userId>/<workerId>/<sessionId>.json
//   · 每文件一条消息数组；写后自动追加"记忆摘要"字段（供后续注入）
//   · 纯文件操作，无外部依赖，可在主进程 / Express server 共用
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import { MEMORY_DIR } from "../paths.ts";

export interface MemoryMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  /** 工具调用卡片（读/写状态） */
  tool?: { name: string; status: "running" | "ok" | "error"; target?: string };
  costUsd?: number;
}

export interface MemorySession {
  id: string;
  workerId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  pinned?: boolean;
  unread?: boolean;
  /** 会话级记忆摘要：由后续提炼写入 */
  summary?: string;
  messages: MemoryMessage[];
}

/** 单会话消息上限，防止单文件无限膨胀。 */
const MAX_MESSAGES = 200;

function sessionDir(userId: string, workerId: string): string {
  return path.join(MEMORY_DIR, userId, workerId);
}

function sessionPath(userId: string, workerId: string, sessionId: string): string {
  return path.join(sessionDir(userId, workerId), `${sessionId}.json`);
}

function readSession(p: string): MemorySession | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as MemorySession;
  } catch {
    return null;
  }
}

/** 一个 Worker 的全部会话（索引 = 遍历目录，会话数通常 < 100，够用）。 */
export function listSessions(userId: string, workerId: string): MemorySession[] {
  const dir = sessionDir(userId, workerId);
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files
    .map((f) => readSession(path.join(dir, f)))
    .filter((s): s is MemorySession => s !== null)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/** 新建一个会话。 */
export function createSession(userId: string, workerId: string, title = "新对话"): MemorySession {
  const now = new Date().toISOString();
  const s: MemorySession = {
    id: `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    workerId,
    title,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  fs.mkdirSync(sessionDir(userId, workerId), { recursive: true });
  fs.writeFileSync(sessionPath(userId, workerId, s.id), JSON.stringify(s, null, 2), "utf-8");
  return s;
}

/** 取/建某会话，保证返回一个存在的 MemorySession。 */
export function ensureSession(userId: string, workerId: string, sessionId?: string): MemorySession {
  if (sessionId) {
    const found = readSession(sessionPath(userId, workerId, sessionId));
    if (found && found.workerId === workerId) return found;
  }
  const existing = listSessions(userId, workerId)[0];
  return existing ?? createSession(userId, workerId);
}

/** 批量保存消息（截断到上限），并更新 updatedAt。 */
export function saveMessages(userId: string, workerId: string, sessionId: string, messages: MemoryMessage[]): void {
  const p = sessionPath(userId, workerId, sessionId);
  const cur = readSession(p);
  if (!cur) return;
  cur.messages = messages.slice(-MAX_MESSAGES);
  cur.updatedAt = new Date().toISOString();
  fs.writeFileSync(p, JSON.stringify(cur, null, 2), "utf-8");
}

/** 读一条会话的消息。 */
export function loadMessages(userId: string, workerId: string, sessionId: string): MemoryMessage[] {
  return readSession(sessionPath(userId, workerId, sessionId))?.messages ?? [];
}

/** 更新会话元数据（标题/置顶/未读）。 */
export function updateSessionMeta(
  userId: string, workerId: string, sessionId: string, patch: Partial<Pick<MemorySession, "title" | "pinned" | "unread">>,
): void {
  const p = sessionPath(userId, workerId, sessionId);
  const cur = readSession(p);
  if (!cur) return;
  Object.assign(cur, patch, { updatedAt: new Date().toISOString() });
  fs.writeFileSync(p, JSON.stringify(cur, null, 2), "utf-8");
}

/** 追加记忆摘要（后续由提炼写入，此处先落存接口）。 */
export function setSummary(userId: string, workerId: string, sessionId: string, summary: string): void {
  const p = sessionPath(userId, workerId, sessionId);
  const cur = readSession(p);
  if (!cur) return;
  cur.summary = summary;
  fs.writeFileSync(p, JSON.stringify(cur, null, 2), "utf-8");
}

/**
 * 从一轮对话中提取记忆摘要（规则式，最小可用）。
 *
 * 从用户消息里抓 "动作 + 主题" 短语，作为该 Worker 正在做什么的备忘。
 * 后续可升级为 LLM 提炼（L0→L1/L2/L3 沉淀）。
 * ponytail: 先用规则抓要点，LLM 提炼在记忆真正用起来后再加。
 */
export function deriveSummary(userText: string, reply: string): string {
  const user = userText.trim().replace(/\s+/g, " ");
  const replySig = reply.trim().replace(/\s+/g, " ").slice(0, 60);
  if (!user) return replySig;
  // 抓第一条有意义的用户消息前 80 字作为主题
  return user.length > 80 ? `${user.slice(0, 80)}…` : user;
}

/** 删除会话。 */
export function deleteSession(userId: string, workerId: string, sessionId: string): void {
  try {
    fs.unlinkSync(sessionPath(userId, workerId, sessionId));
  } catch {
    // 忽略：可能已删除
  }
}

// ---------------------------------------------------------------------------
// 自检（node --experimental-strip-types / tsx 直接运行时执行）
// 验证：创建 → 存取消息 → 元数据更新 → 删除，完整生命周期。
// ---------------------------------------------------------------------------

function demo(): void {
  const assert = (label: string, cond: boolean) => {
    if (!cond) { console.error(`✗ ${label}`); process.exitCode = 1; }
    else console.log(`✓ ${label}`);
  };

  const uid = "__test__", wid = "__w__";
  const s = createSession(uid, wid, "测试会话");
  assert("创建会话", s.id.length > 0);

  saveMessages(uid, wid, s.id, [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ]);
  assert("保存后能读到", loadMessages(uid, wid, s.id).length === 2);

  updateSessionMeta(uid, wid, s.id, { title: "改名" });
  assert("改标题持久化", listSessions(uid, wid)[0].title === "改名");

  setSummary(uid, wid, s.id, "用户打招呼");
  assert("摘要落存", listSessions(uid, wid)[0].summary === "用户打招呼");

  deleteSession(uid, wid, s.id);
  assert("删除后为空", listSessions(uid, wid).length === 0);

  // 清理测试目录
  try { fs.rmSync(path.join(MEMORY_DIR, uid), { recursive: true, force: true }); } catch { /* ignore */ }

  console.log(process.exitCode ? "\n自检失败" : "\n自检通过");
}

const isMain = typeof process !== "undefined" && process.argv?.[1]?.includes("memory");
if (isMain) demo();

