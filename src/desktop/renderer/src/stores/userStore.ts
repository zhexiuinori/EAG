import { create } from "zustand";
import * as ipc from "../lib/ipc.ts";
import { useWorkerStore } from "./workerStore.ts";
import { useTaskStore } from "./taskStore.ts";
import { useApprovalStore } from "./approvalStore.ts";
import type { AuthSession, AuthLoginOutcome, User } from "@shared/types.ts";

/**
 * 用户与身份状态。
 *
 * Web 模式为账号 + 密码登录：成功后持久化 token（localStorage），
 * 后续请求自动携带；会话、可见 Agent、任务与审批都按当前用户加载。
 * canManageConsole 表示是否可访问管理控制台（admin 或获单独授权）。
 */

const CURRENT_USER_KEY = "eag-current-user";

function persistCurrentUser(userId: string | undefined): void {
  try {
    if (userId) localStorage.setItem(CURRENT_USER_KEY, userId);
    else localStorage.removeItem(CURRENT_USER_KEY);
  } catch {
    // ignore
  }
}

interface UserState {
  users: User[];
  session: AuthSession | null;
  loaded: boolean;
  loading: boolean;

  load: (force?: boolean) => Promise<void>;
  /** 账号密码登录；成功后持久化 session/token 并刷新各数据层。失败返回可判别原因（凭证错误 / 锁定）。 */
  login: (username: string, password: string) => Promise<AuthLoginOutcome>;
  /** 退出登录：清 token / 本地身份，回到登录页 */
  logout: () => Promise<void>;
  /** 修改自己的密码（需旧密码）；成功后自动续期凭证 */
  changePassword: (oldPassword: string, newPassword: string) => Promise<boolean>;
  /** 当前身份是否可访问管理控制台 */
  canManageConsole: () => boolean;
}

export const useUserStore = create<UserState>((set, get) => ({
  users: [],
  session: null,
  loaded: false,
  loading: false,

  load: async (force = false) => {
    if (get().loaded && !force) return;
    set({ loading: true });
    try {
      const session = await ipc.authSession();
      // 未登录 / token 无效：server 返回空身份（userId 为空）→ 按未登录处理
      const valid = session && session.userId ? session : null;
      let users: User[] = [];
      if (valid && (valid.role === "admin" || valid.canManageConsole)) {
        // 仅后台权限用户拉用户列表（userList 现在受控）；普通用户不拉
        const usersRes = await ipc.userList();
        users = usersRes.users ?? [];
      }
      persistCurrentUser(valid?.userId);
      set({ users, session: valid, loaded: true, loading: false });
    } catch {
      // 未登录或 token 失效：保持空会话（登录页守卫会拦截）
      persistCurrentUser(undefined);
      set({ users: [], session: null, loaded: true, loading: false });
    }
  },

  login: async (username, password) => {
    try {
      const r = await ipc.authLogin({ username, password });
      if (!r.ok) return r;
      persistCurrentUser(r.session.userId);
      set({ session: r.session, loaded: true, loading: false });
      // 身份确定：Agent 可见性、会话、任务与审批都按新用户加载
      useWorkerStore.getState().reset();
      void useWorkerStore.getState().loadMine(true);
      void useTaskStore.getState().load();
      void useApprovalStore.getState().load();
      return r;
    } catch {
      return { ok: false, reason: "bad_credentials" };
    }
  },

  changePassword: async (oldPassword, newPassword) => {
    try {
      const r = await ipc.authChangePassword({ oldPassword, newPassword });
      if (!r) return false;
      // 新凭证由 ipc 层写入 localStorage；同步会话，避免被自己改密踢下线
      set({ session: r.session, loaded: true });
      return true;
    } catch {
      return false;
    }
  },

  logout: async () => {
    try {
      await ipc.authLogout();
    } catch {
      // 忽略：本地也要清
    }
    ipc.clearAuthToken();
    persistCurrentUser(undefined);
    set({ session: null, users: [], loaded: true });
    useWorkerStore.getState().reset();
  },

  canManageConsole: () => {
    const s = get().session;
    return !!s && (s.role === "admin" || s.canManageConsole);
  },
}));
