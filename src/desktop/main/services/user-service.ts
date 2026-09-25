// ---------------------------------------------------------------------------
// EAG Desktop — User Service
//
// 账户体系：
//   · username + password（scrypt 加盐哈希）持久化到 <项目根>/users/users.json
//   · 会话：进程内 currentSession（桌面 IPC）+ 可验证 token（Web 请求）
//   · token 由进程内签发/校验（含 userId、哈希指纹），登录、退出、改密后失效
//   · 面向管理端 API 的 User 视图绝不含 passwordHash（见 toPublic）
//
// 默认账号：admin / admin123（首启落盘，建议立即修改）
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { PROJECT_ROOT } from "../paths.ts";
import { appendAuditEntry } from "./audit-api.ts";
import type {
  User, UserRecord, UserCreateInput, UserUpdateInput,
  AuthSession, AuthLoginInput, AuthLoginResult,
} from "../../shared/types.ts";

const USERS_DIR = path.join(PROJECT_ROOT, "users");

function usersFile(): string {
  return path.join(USERS_DIR, "users.json");
}

// ---------------------------------------------------------------------------
// 密码哈希（scrypt 加盐，与登录校验一致的参数）
// ---------------------------------------------------------------------------

const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 32, SCRYPT_OPTS).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const calc = crypto.scryptSync(password, salt, 32, SCRYPT_OPTS).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(calc, "hex"), Buffer.from(hash, "hex"));
}

// ---------------------------------------------------------------------------
// 持久化
// ---------------------------------------------------------------------------

const DEFAULT_USERS: UserRecord[] = [
  {
    id: "u-admin",
    name: "Admin",
    username: "admin",
    role: "admin",
    canManageConsole: true,
    createdAt: "2026-09-01T00:00:00Z",
    passwordHash: hashPassword("admin123"),
  },
];

function load(): UserRecord[] {
  try {
    const raw = fs.readFileSync(usersFile(), "utf-8");
    const list = JSON.parse(raw);
    if (Array.isArray(list) && list.length > 0) {
      // 迁移旧数据：v1 无 username/password/canManageConsole
      //  → 管理员账号用户名固定为 admin，其余用 id；密码统一初始化为 admin123，
      //    保证升级后仍能登录（提示尽快修改）。迁移结果同步落盘，避免每次重算。
      const migrated = list.map((u: Record<string, any>): UserRecord => {
        const isAdmin = u.role === "admin";
        return {
          id: u.id,
          name: u.name,
          username: u.username ?? (isAdmin ? "admin" : u.id),
          role: u.role ?? "user",
          canManageConsole: u.canManageConsole ?? isAdmin,
          createdAt: u.createdAt ?? new Date().toISOString(),
          passwordHash: u.passwordHash ?? hashPassword("admin123"),
        };
      });
      try {
        fs.mkdirSync(USERS_DIR, { recursive: true });
        fs.writeFileSync(usersFile(), JSON.stringify(migrated, null, 2), "utf-8");
      } catch {
        // 写盘失败不影响内存使用
      }
      return migrated;
    }
  } catch {
    // 首次运行：落默认用户
  }
  try {
    fs.mkdirSync(USERS_DIR, { recursive: true });
    fs.writeFileSync(usersFile(), JSON.stringify(DEFAULT_USERS, null, 2), "utf-8");
  } catch {
    // 写盘失败时退回内存
  }
  return [...DEFAULT_USERS];
}

const users: UserRecord[] = load();

let currentSession: AuthSession = { userId: "", userName: "", username: "", role: "user", canManageConsole: false };

function save(): void {
  try {
    fs.mkdirSync(USERS_DIR, { recursive: true });
    fs.writeFileSync(usersFile(), JSON.stringify(users, null, 2), "utf-8");
  } catch (err) {
    console.error("[Users] Failed to persist:", err);
  }
}

// ---------------------------------------------------------------------------
// 公共视图（绝不含 passwordHash）
// ---------------------------------------------------------------------------

export function toPublic(u: UserRecord): User {
  const { passwordHash: _ph, ...pub } = u;
  return pub;
}

export function listUsers(): User[] {
  return users.map(toPublic);
}

export function getUser(id: string): UserRecord | undefined {
  return users.find((u) => u.id === id);
}

export function toSession(u: UserRecord): AuthSession {
  return {
    userId: u.id,
    userName: u.name,
    username: u.username,
    role: u.role,
    canManageConsole: u.canManageConsole,
  };
}

// ---------------------------------------------------------------------------
// 用户管理
// ---------------------------------------------------------------------------

export function createUser(input: UserCreateInput): User {
  if (!input.username?.trim()) throw new Error("用户名不能为空");
  if (!input.password || input.password.length < 6) throw new Error("密码至少 6 位");
  if (users.some((u) => u.username === input.username.trim())) {
    throw new Error(`用户名「${input.username.trim()}」已存在`);
  }
  const rec: UserRecord = {
    id: `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: input.name,
    username: input.username.trim(),
    role: input.role,
    canManageConsole: input.canManageConsole ?? input.role === "admin",
    createdAt: new Date().toISOString(),
    passwordHash: hashPassword(input.password),
  };
  users.push(rec);
  save();
  return toPublic(rec);
}

export function updateUser(input: UserUpdateInput): User | undefined {
  const u = users.find((x) => x.id === input.id);
  if (!u) return undefined;
  if (input.name !== undefined && input.name.trim()) u.name = input.name.trim();
  if (input.role !== undefined) u.role = input.role;
  if (input.canManageConsole !== undefined) u.canManageConsole = input.canManageConsole;
  // 改密码：重算哈希 → 旧 token 立即失效（token 指纹含密码哈希）
  if (input.password) {
    if (input.password.length < 6) throw new Error("密码至少 6 位");
    u.passwordHash = hashPassword(input.password);
  }
  save();
  return toPublic(u);
}

export function deleteUser(id: string): boolean {
  const idx = users.findIndex((u) => u.id === id);
  if (idx === -1) return false;
  const [removed] = users.splice(idx, 1);
  save();
  // 若删除的是当前会话用户，回退到首个管理员
  if (currentSession.userId === id) {
    const fallback = users.find((u) => u.role === "admin");
    currentSession = fallback
      ? toSession(fallback)
      : { userId: "", userName: "", username: "", role: "user", canManageConsole: false };
  }
  tokenCache.delete(mkTokenKey(removed.id, removed));
  return true;
}

// ---------------------------------------------------------------------------
// 登录 / 会话 / token
//
// token = base64url(userId) + "." + base64url(sha256(userId|username|passwordHash))
// 进程内可完全验证；改密/删号即失效（无需全局存储失效表）。
// ---------------------------------------------------------------------------

/**
 * Token 签名密钥：**持久化到磁盘**，而不是每次启动随机生成。
 *
 * 为什么必须持久化：token = base64url(userId) + "." + hash(secret|user|passwordHash)。
 * 若密钥随进程随机，API 每重启一次，所有人的 token 都会因指纹不匹配而失效 ——
 * 而前端 `load()` 只把请求失败当成普通错误（不明示"未登录"），界面仍显示已登录，
 * 于是表现为"服务启动后各种操作突然全部失败/401"（本机实测踩到）。
 * 持久化后：重启不踢人，只有改密/删号才使 token 失效。
 */
const TOKEN_SECRET = (() => {
  try {
    const f = path.join(USERS_DIR, "token-secret");
    if (fs.existsSync(f)) return fs.readFileSync(f, "utf-8").trim();
    const secret = crypto.randomBytes(32).toString("hex");
    fs.mkdirSync(USERS_DIR, { recursive: true });
    fs.writeFileSync(f, secret, "utf-8");
    return secret;
  } catch {
    // 写盘失败（只读盘等）：退化为进程级临时密钥（每次重启失效，但不崩溃）
    return crypto.randomBytes(32).toString("hex");
  }
})();
const tokenCache = new Map<string, AuthSession>();

function mkTokenKey(userId: string, u: UserRecord): string {
  return crypto
    .createHash("sha256")
    .update(`${TOKEN_SECRET}|${userId}|${u.username}|${u.passwordHash}`)
    .digest("hex");
}

function issueToken(u: UserRecord): string {
  const key = mkTokenKey(u.id, u);
  const token = `${Buffer.from(u.id).toString("base64url")}.${Buffer.from(key).toString("base64url")}`;
  tokenCache.set(token, toSession(u));
  return token;
}

export function verifyToken(token: string | undefined | null): AuthSession | undefined {
  if (!token) return undefined;
  try {
    const [uEnc, kEnc] = token.split(".");
    const u = users.find((x) => x.id === Buffer.from(uEnc, "base64url").toString("utf8"));
    if (!u) return undefined;
    // 哈希指纹含 passwordHash：改密/删号后指纹不匹配 → 旧 token 立即失效
    const key = mkTokenKey(u.id, u);
    if (key !== Buffer.from(kEnc, "base64url").toString("utf8")) {
      // 清理可能残留的缓存
      tokenCache.delete(token);
      return undefined;
    }
    const s = toSession(u);
    tokenCache.set(token, s);
    return s;
  } catch {
    return undefined;
  }
}

export function login(input: AuthLoginInput): AuthLoginResult | undefined {
  const u = users.find((x) => x.username === input.username.trim());
  if (!u || !verifyPassword(input.password, u.passwordHash)) {
    // 登录失败也进审计（治理平台需要知道谁在尝试登录）
    try {
      appendAuditEntry({
        userId: input.username ?? "unknown",
        workerId: undefined,
        toolName: "__auth_login",
        toolCallId: undefined,
        phase: "call",
        input: { username: input.username, ok: false },
        isError: true,
        reason: "用户名或密码错误",
      });
    } catch { /* 审计失败不影响登录 */ }
    return undefined;
  }
  const session = toSession(u);
  currentSession = session; // 桌面 IPC 会话
  try {
    appendAuditEntry({
      userId: u.id,
      workerId: undefined,
      toolName: "__auth_login",
      toolCallId: undefined,
      phase: "call",
      input: { username: u.username, ok: true },
    });
  } catch { /* 审计失败不影响登录 */ }
  return { session, token: issueToken(u) };
}

/**
 * 用户修改自己的密码。
 * 必须校验旧密码（防止会话被劫持后直接改密接管账号）；
 * 改密后旧 token 立即失效（指纹含密码哈希），这里签发新 token 让当前会话续期，
 * 避免用户改完密码就被踢下线。
 */
export function changePassword(
  userId: string,
  oldPassword: string,
  newPassword: string,
): AuthLoginResult | undefined {
  const u = users.find((x) => x.id === userId);
  if (!u || !verifyPassword(oldPassword, u.passwordHash)) return undefined;
  if (!newPassword || newPassword.length < 6) return undefined;
  u.passwordHash = hashPassword(newPassword);
  save();
  const session = toSession(u);
  currentSession = session;
  try {
    appendAuditEntry({
      userId: u.id,
      workerId: undefined,
      toolName: "__auth_change_password",
      toolCallId: undefined,
      phase: "call",
      input: { username: u.username, ok: true },
    });
  } catch { /* 审计失败不影响改密 */ }
  return { session, token: issueToken(u) };
}

export function logout(token?: string): void {
  try {
    appendAuditEntry({
      userId: currentSession.userId || "unknown",
      workerId: undefined,
      toolName: "__auth_logout",
      toolCallId: undefined,
      phase: "call",
      input: { username: currentSession.username, ok: true },
    });
  } catch { /* 审计失败不影响登出 */ }
  if (token) tokenCache.delete(token);
  currentSession = { userId: "", userName: "", username: "", role: "user", canManageConsole: false };
}

export function getSession(): AuthSession {
  return currentSession;
}

/**
 * 请求级身份（Web）：token 优先（随 x-eag-token 头）。
 *
 * x-eag-user 旧式头已降级为"仅当携带 token 时做一致性校验"：
 * 未登录的请求仅凭 id 头不能冒充任意用户（那是 mock 身份时代的遗留）。
 * 无 token 时回退进程内全局会话（Electron IPC / curl），未登录即为空身份。
 */
export function resolveIdentity(token?: string | null, userId?: string | null): AuthSession {
  const t = verifyToken(token);
  if (t) {
    // 双头不一致（如 token 属于 A 却带 B 的 id）：以 token 为准，防伪冒
    if (userId && userId !== t.userId) return t;
    return t;
  }
  // 无有效 token：绝不回退到进程内全局 session（那是登录后写入的共享状态，
  // 若回退，其他客户端"上次登录的 admin"会泄漏给未登录请求 —— 已复现的漏洞）。
  // 无 token 即视为未登录（空身份），管理接口守卫据此返回 403。
  return EMPTY_SESSION;
}

/** 未登录空身份（Web 无状态调用的兜底）。 */
export const EMPTY_SESSION: AuthSession = {
  userId: "",
  userName: "",
  username: "",
  role: "user",
  canManageConsole: false,
};
