// user-service 权限加固测试：token TTL / 登录限流 / 密码策略 / 初始口令提醒。
// 用 EAG_USERS_DIR + EAG_AUDIT_DIR 把持久化重定向到临时目录，配合
// vi.resetModules + 动态 import 让每个用例拿到全新的服务实例（默认 admin）。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let tmpDir: string;
let svc: typeof import("./user-service.ts");

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-users-test-"));
  process.env.EAG_USERS_DIR = tmpDir;
  process.env.EAG_AUDIT_DIR = path.join(tmpDir, "audit");
  vi.resetModules();
  svc = await import("./user-service.ts");
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.EAG_USERS_DIR;
  delete process.env.EAG_AUDIT_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const ADMIN = { username: "admin", password: "admin123" };

// ---------------------------------------------------------------------------
// 密码策略
// ---------------------------------------------------------------------------

describe("passwordPolicyError", () => {
  it("拒绝过短 / 纯数字 / 纯字母，接受字母+数字组合", () => {
    expect(svc.passwordPolicyError("abc")).toBe("密码至少 8 位");
    expect(svc.passwordPolicyError("")).toBe("密码至少 8 位");
    expect(svc.passwordPolicyError(undefined)).toBe("密码至少 8 位");
    expect(svc.passwordPolicyError("12345678")).toBe("密码需同时包含字母和数字");
    expect(svc.passwordPolicyError("abcdefgh")).toBe("密码需同时包含字母和数字");
    expect(svc.passwordPolicyError("abcd1234")).toBeNull();
    // 初始口令本身符合策略（是否弱口令由 passwordWeak 单独标记）
    expect(svc.passwordPolicyError(svc.INITIAL_PASSWORD)).toBeNull();
  });

  it("createUser 应用密码策略", () => {
    expect(() =>
      svc.createUser({ name: "A", username: "a", role: "user", password: "123456" }),
    ).toThrow("密码至少 8 位");
    expect(() =>
      svc.createUser({ name: "A", username: "a", role: "user", password: "abcdefgh" }),
    ).toThrow("密码需同时包含字母和数字");
    const u = svc.createUser({ name: "A", username: "a", role: "user", password: "abcd1234" });
    expect(u.username).toBe("a");
  });
});

// ---------------------------------------------------------------------------
// token：三段式 + TTL + 改密失效
// ---------------------------------------------------------------------------

describe("token", () => {
  it("登录成功签发三段式 token，且可验证", () => {
    const r = svc.login(ADMIN);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.token.split(".")).toHaveLength(3);
    const s = svc.verifyToken(r.token);
    expect(s?.userId).toBe("u-admin");
  });

  it("旧两段式 token 一律拒绝", () => {
    const legacy = `${Buffer.from("u-admin").toString("base64url")}.${Buffer.from("whatever").toString("base64url")}`;
    expect(svc.verifyToken(legacy)).toBeUndefined();
  });

  it("超过 TTL（12h）的 token 验证失败", () => {
    vi.useFakeTimers();
    const r = svc.login(ADMIN);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(svc.verifyToken(r.token)).toBeDefined();
    // 前进 13 小时 → 过期
    vi.setSystemTime(Date.now() + 13 * 60 * 60 * 1000);
    expect(svc.verifyToken(r.token)).toBeUndefined();
  });

  it("签发时间晚于现在（超过 5 分钟容忍）的 token 拒绝", () => {
    vi.useFakeTimers();
    const r = svc.login(ADMIN);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 把时钟往回拨 10 分钟：token 的签发时间变成"未来 10 分钟" → 拒绝
    vi.setSystemTime(Date.now() - 10 * 60 * 1000);
    expect(svc.verifyToken(r.token)).toBeUndefined();
  });

  it("改密后旧 token 立即失效，新 token 可用", () => {
    const r = svc.login(ADMIN);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const changed = svc.changePassword("u-admin", "admin123", "abcd1234");
    expect(changed).toBeDefined();
    expect(svc.verifyToken(r.token)).toBeUndefined();
    expect(svc.verifyToken(changed!.token)?.userId).toBe("u-admin");
  });
});

// ---------------------------------------------------------------------------
// 登录：锁定 / 弱口令标记
// ---------------------------------------------------------------------------

describe("login", () => {
  it("初始口令登录成功但标记 passwordWeak", () => {
    const r = svc.login(ADMIN);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.passwordWeak).toBe(true);
  });

  it("改密后不再标记 passwordWeak", () => {
    svc.changePassword("u-admin", "admin123", "abcd1234");
    const r = svc.login({ username: "admin", password: "abcd1234" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.passwordWeak).toBe(false);
  });

  it("凭证错误返回 bad_credentials", () => {
    const r = svc.login({ username: "admin", password: "wrong-pass-1" });
    expect(r).toEqual({ ok: false, reason: "bad_credentials" });
  });

  it(`连续失败 ${5} 次后锁定：正确密码也拒绝，锁定期满后可登录`, () => {
    vi.useFakeTimers();
    svc.createUser({ name: "Bob", username: "bob", role: "user", password: "bob-pass-1234" });
    for (let i = 0; i < svc.LOGIN_MAX_FAILURES; i++) {
      const r = svc.login({ username: "bob", password: `wrong-${i}` });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("bad_credentials");
    }
    // 第 6 次：即使密码正确也被锁定
    const locked = svc.login({ username: "bob", password: "bob-pass-1234" });
    expect(locked.ok).toBe(false);
    if (!locked.ok) {
      expect(locked.reason).toBe("locked");
      expect(locked.retryAfterSec).toBeGreaterThan(0);
    }
    // 前进 16 分钟 > 锁定时长 → 恢复
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);
    const after = svc.login({ username: "bob", password: "bob-pass-1234" });
    expect(after.ok).toBe(true);
  });

  it("成功登录清零失败计数", () => {
    svc.createUser({ name: "Bob", username: "bob", role: "user", password: "bob-pass-1234" });
    for (let i = 0; i < svc.LOGIN_MAX_FAILURES - 1; i++) {
      svc.login({ username: "bob", password: `wrong-${i}` });
    }
    const ok = svc.login({ username: "bob", password: "bob-pass-1234" });
    expect(ok.ok).toBe(true);
    // 计数已清零：再失败 MAX-1 次仍不应锁定
    for (let i = 0; i < svc.LOGIN_MAX_FAILURES - 1; i++) {
      const r = svc.login({ username: "bob", password: `wrong-again-${i}` });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("bad_credentials");
    }
  });
});

// ---------------------------------------------------------------------------
// changePassword 密码策略
// ---------------------------------------------------------------------------

describe("changePassword", () => {
  it("新密码不符合策略时拒绝", () => {
    expect(svc.changePassword("u-admin", "admin123", "short")).toBeUndefined();
    expect(svc.changePassword("u-admin", "admin123", "12345678")).toBeUndefined();
    expect(svc.changePassword("u-admin", "admin123", "abcd1234")).toBeDefined();
  });

  it("旧密码错误时拒绝", () => {
    expect(svc.changePassword("u-admin", "not-the-password", "abcd1234")).toBeUndefined();
  });
});
