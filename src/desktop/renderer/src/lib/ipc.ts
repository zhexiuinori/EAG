// lib/ipc.ts — Dual-mode IPC layer
// - Electron: uses window.eag IPC bridge
// - Browser: uses fetch("/api/...") to the EAG API server

import { IPC_CHANNELS } from "@shared/ipc-channels.ts";
import type {
  PolicyGetResult, PolicyUpdateInput, PolicyCheckInput, PolicyCheckResult, PolicyEffectiveInput,
  AuditListInput, AuditListResult, FileDiffInput, FileDiffResult,
  FileSnapshotsInput, FileSnapshotsResult, FileRestoreInput, FileRestoreResult,
  FileListInput, FileListResult, FileReadInput, FileReadResult,
  FileWriteInput, FileWriteResult,
  TerminalStartInput, TerminalWriteInput, TerminalStopInput, TerminalStatus,
  ExecutionListInput, ExecutionListResult,
  SwarmExecuteInput, SwarmHistoryEntry,
  SystemStatus, PiStartInput, PiStatusResult,
  EgressWhitelistResult, AppConfig, ModelProviderTestInput, ModelProviderTestResult,
  WorkerListResult, WorkerCreateInput, WorkerUpdateInput, WorkerAssignInput,
  WorkerArchiveInput, WorkerCloneInput, WorkerRollbackInput,
  UserGroup, GroupListResult, GroupUpsertInput, GroupDeleteInput,
  UserListResult, UserCreateInput, UserUpdateInput, UserDeleteInput, UserRevokeTokensInput,
  LoginHistoryInput, LoginHistoryResult,
  AuthSession, AuthLoginInput, AuthLoginResult,
  AuthLoginOutcome, ChangePasswordInput,
  McpListResult, McpServerView, McpUpsertInput, McpDeleteInput, McpToolsInput, McpToolsResult,
  McpCallInput, McpCallResult,
  KnowledgeCollection, KnowledgeListResult, KnowledgeUpsertInput, KnowledgeDeleteInput,
  KnowledgeDetailResult, KnowledgeDocDeleteInput, KnowledgeIngestInput, KnowledgeIngestResult,
  KnowledgeSearchInput, KnowledgeSearchResult,
  ScheduledJob, SchedulerListResult, ScheduledJobUpsertInput, ScheduledJobDeleteInput,
  NotifyEvent, NotificationListResult, NotificationReadInput, NotificationTestResult,
  DelegationRecord, DelegationListResult, ProviderHealthResult,
  WorkspaceChatSendInput, WorkspaceChatSendResult, WorkspaceChatAbortInput, AgentEvent,
  AdapterListResult,
  SwarmProgressEvent,
  BackgroundTask, TaskSubmitInput, TaskListInput, TaskListResult, TaskCancelInput,
  ApprovalRecord, ApprovalListResult, ApprovalDecideInput,
  Worker,
} from "@shared/types.ts";

// =========================================================================
// Detect mode
// =========================================================================

function isElectron(): boolean {
  return typeof (window as any).eag !== "undefined";
}

function getApi() { return (window as any).eag ?? {}; }

// =========================================================================
// Electron IPC
// =========================================================================

function invokeIPC<T>(channel: string, ...args: unknown[]): Promise<T> {
  const fn = getApi()[channel];
  if (!fn) return Promise.reject(new Error(`IPC "${channel}" unavailable`));
  return fn(...args) as Promise<T>;
}

// =========================================================================
// Browser HTTP
// =========================================================================

/**
 * 登录凭证（Web 模式）。
 *
 * 登录成功后在 localStorage 保存 token + 用户 id：
 *   · token 随每个请求以 x-eag-token 头发送 —— server 据此解析请求级身份，
 *     多标签页各自持有身份，互不干扰（不再共享进程级全局 session）。
 *   · 用户 id 同时以 x-eag-user 头发送，供 server 在兼容期/降级时兜底。
 * 由 userStore 写入；直接读 localStorage 而非 import store，避免 ipc ↔ store 循环依赖。
 */
const TOKEN_KEY = "eag-auth-token";

function currentUserId(): string | null {
  try {
    return localStorage.getItem("eag-current-user");
  } catch {
    return null;
  }
}

function currentToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function clearAuthToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
}

/** 持久化登录凭证：登录 / 改密后调用，否则后续请求不带 token，管理接口会 403。 */
export function setAuthToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // ignore
  }
}

/**
 * 401 统一拦截：token 过期/失效（token 已有 12h TTL，过期是常态）时，
 * 清掉本地凭证并引导回登录页（带 from 回跳 + expired 提示），
 * 避免各页面各自静默坏掉。登录接口本身走裸 fetch，不经这里。
 */
function redirectToLoginOn401(): void {
  clearAuthToken();
  const here = window.location.pathname + window.location.search;
  if (window.location.pathname.startsWith("/login")) return;
  window.location.href = `/login?from=${encodeURIComponent(here)}&expired=1`;
}

async function http<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = currentToken();
  const uid = currentUserId();
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { "x-eag-token": token } : {}),
      ...(uid ? { "x-eag-user": uid } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) redirectToLoginOn401();
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`.slice(0, 300));
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

function httpGet<T>(path: string): Promise<T> { return http<T>("GET", path); }
function httpPost<T>(path: string, body?: unknown): Promise<T> { return http<T>("POST", path, body); }
function httpPut<T>(path: string, body?: unknown): Promise<T> { return http<T>("PUT", path, body); }
function httpDel<T>(path: string): Promise<T> { return http<T>("DELETE", path); }

// =========================================================================
// Unified call
// =========================================================================

function call<T>(channel: string, electronImpl: () => Promise<T>, httpImpl: () => Promise<T>): Promise<T> {
  if (isElectron()) return electronImpl();
  return httpImpl();
}

// =========================================================================
// Exports
// =========================================================================

// -- Workspace --
export const workspaceList = () =>
  call<WorkerListResult>(IPC_CHANNELS.WORKSPACE_LIST, () => invokeIPC(IPC_CHANNELS.WORKSPACE_LIST), () => httpGet("/workspace"));
/**
 * Send a chat message.
 *
 *   · Electron：AgentEvent 经 IPC（onWorkspaceChatEvent）推送，onEvent 不用。
 *   · Web：POST 响应体是 **NDJSON 事件流**（每行一个事件，最后一行 done），
 *     逐行解析后交给 onEvent —— 与 Electron 的事件形态完全一致，
 *     上层可以复用同一套渲染逻辑（文本增量 / 工具卡片 / 委派卡片）。
 */
export const workspaceChatSend = (i: WorkspaceChatSendInput, onEvent?: (ev: AgentEvent) => void) =>
  call<WorkspaceChatSendResult>(
    IPC_CHANNELS.WORKSPACE_CHAT_SEND,
    () => invokeIPC<WorkspaceChatSendResult>(IPC_CHANNELS.WORKSPACE_CHAT_SEND, i),
    async () => {
      const token = currentToken();
      const uid = currentUserId();
      const res = await fetch(`/api/chat/${i.workerId}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/x-ndjson",
          ...(token ? { "x-eag-token": token } : {}),
          ...(uid ? { "x-eag-user": uid } : {}),
        },
        body: JSON.stringify({
          message: i.text,
          modelProviderId: i.modelProviderId,
          modelName: i.modelName,
          attachments: i.attachments,
          planOnly: i.planOnly === true,
        }),
      });
      if (res.status === 401) redirectToLoginOn401();
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200) || res.statusText}`);
      }
      // 极端情况（老服务端 / 中间层去掉了 body 流）：退回一次性 JSON
      if (!res.body) {
        const r = (await res.json()) as { reply?: string; error?: string };
        return { reply: r.reply, error: r.error };
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let out: WorkspaceChatSendResult = {};
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line) as { type?: string; event?: AgentEvent; reply?: string; error?: string };
            if (msg.type === "event" && msg.event) onEvent?.(msg.event);
            else if (msg.type === "done") out = { reply: msg.reply, error: msg.error };
          } catch {
            // 坏行（半截 JSON）忽略：下一轮会补齐
          }
        }
      }
      return out;
    },
  );

/** Subscribe to streamed agent events (Electron mode; no-op in browser). */
export function onWorkspaceChatEvent(cb: (ev: AgentEvent) => void): () => void {
  const api = getApi();
  if (typeof api.onWorkspaceChatEvent === "function") return api.onWorkspaceChatEvent(cb) as () => void;
  return () => {};
}

/** 中止当前这一轮对话（杀掉 Agent 子进程）。 */
export const workspaceChatAbort = (i: WorkspaceChatAbortInput) =>
  call<boolean>(
    IPC_CHANNELS.WORKSPACE_CHAT_ABORT,
    () => invokeIPC(IPC_CHANNELS.WORKSPACE_CHAT_ABORT, i),
    async () => {
      const r = await httpPost<{ aborted: boolean }>(`/chat/${i.workerId}/abort`);
      return r.aborted;
    },
  );

/** 订阅 Swarm 执行进度（Electron 模式；浏览器模式为 no-op）。 */
export function onSwarmEvent(cb: (ev: SwarmProgressEvent) => void): () => void {
  const api = getApi();
  if (typeof api.onSwarmEvent === "function") return api.onSwarmEvent(cb) as () => void;
  return () => {};
}

// -- Worker management （Web 模式走 /api/admin/*，需后台权限） --
export const workerList = () =>
  call<WorkerListResult>(IPC_CHANNELS.WORKER_LIST, () => invokeIPC(IPC_CHANNELS.WORKER_LIST), () => httpGet("/admin/workers"));
export const workerCreate = (i: WorkerCreateInput) =>
  call<any>(IPC_CHANNELS.WORKER_CREATE, () => invokeIPC(IPC_CHANNELS.WORKER_CREATE, i), () => httpPost("/admin/workers", i));
export const workerUpdate = (i: WorkerUpdateInput) =>
  call<any>(IPC_CHANNELS.WORKER_UPDATE, () => invokeIPC(IPC_CHANNELS.WORKER_UPDATE, i), () => httpPut(`/admin/workers/${i.id}`, i.patch));
export const workerDelete = (i: { id: string }) =>
  call<any>(IPC_CHANNELS.WORKER_DELETE, () => invokeIPC(IPC_CHANNELS.WORKER_DELETE, i), () => httpDel(`/admin/workers/${i.id}`));
export const workerArchive = (i: WorkerArchiveInput) =>
  call<Worker | undefined>(IPC_CHANNELS.WORKER_ARCHIVE, () => invokeIPC(IPC_CHANNELS.WORKER_ARCHIVE, i), () => httpPost<Worker>(`/admin/workers/${i.id}/archive`, { archived: i.archived }));
export const workerClone = (i: WorkerCloneInput) =>
  call<Worker | undefined>(IPC_CHANNELS.WORKER_CLONE, () => invokeIPC(IPC_CHANNELS.WORKER_CLONE, i), () => httpPost<Worker>(`/admin/workers/${i.id}/clone`, { name: i.name }));
export const workerRollbackConfig = (i: WorkerRollbackInput) =>
  call<Worker | undefined>(IPC_CHANNELS.WORKER_ROLLBACK_CONFIG, () => invokeIPC(IPC_CHANNELS.WORKER_ROLLBACK_CONFIG, i), () => httpPost<Worker>(`/admin/workers/${i.id}/rollback-config`, { versionIndex: i.versionIndex }));
export const workerStart = (i: { id: string }) =>
  call<boolean>(IPC_CHANNELS.WORKER_START, () => invokeIPC(IPC_CHANNELS.WORKER_START, i), async () => { const r = await httpPost<{ started: boolean }>(`/admin/workers/${i.id}/start`); return r.started; });
/** 重新分配（多用户 + 用户组）。 */
export const workerAssign = (i: WorkerAssignInput) =>
  call<Worker | undefined>(IPC_CHANNELS.WORKER_ASSIGN, () => invokeIPC(IPC_CHANNELS.WORKER_ASSIGN, i), async () => httpPost<Worker>(`/admin/workers/${i.id}/assign`, { userIds: i.userIds, groupIds: i.groupIds }));

// -- 用户组 --
export const groupList = () =>
  call<GroupListResult>(IPC_CHANNELS.GROUP_LIST, () => invokeIPC(IPC_CHANNELS.GROUP_LIST), () => httpGet("/admin/groups"));
export const groupUpsert = (i: GroupUpsertInput) =>
  call<UserGroup>(IPC_CHANNELS.GROUP_UPSERT, () => invokeIPC(IPC_CHANNELS.GROUP_UPSERT, i), () => httpPost("/admin/groups", i));
export const groupDelete = (i: GroupDeleteInput) =>
  call<boolean>(IPC_CHANNELS.GROUP_DELETE, () => invokeIPC(IPC_CHANNELS.GROUP_DELETE, i), () => httpDel(`/admin/groups/${i.id}`));
export const workerStatus = (i: { id: string }) =>
  call<{ running: boolean; pid: number | null; spentUsd?: number; budgetLimitUsd?: number; memorySummary?: string }>(
    IPC_CHANNELS.WORKER_STATUS,
    () => invokeIPC(IPC_CHANNELS.WORKER_STATUS, i),
    async () => ({ running: false, pid: null }),
  );

// -- Agent adapters --
export const adaptersList = () =>
  call<AdapterListResult>(IPC_CHANNELS.ADAPTERS_LIST, () => invokeIPC(IPC_CHANNELS.ADAPTERS_LIST), () => httpGet("/adapters"));

// -- Users --
export const userList = () =>
  call<UserListResult>(IPC_CHANNELS.USER_LIST, () => invokeIPC(IPC_CHANNELS.USER_LIST), () => httpGet("/admin/users"));
export const userCreate = (i: UserCreateInput) =>
  call<any>(IPC_CHANNELS.USER_CREATE, () => invokeIPC(IPC_CHANNELS.USER_CREATE, i), () => httpPost("/admin/users", i));
export const userUpdate = (i: UserUpdateInput) =>
  call<any>(IPC_CHANNELS.USER_UPDATE, () => invokeIPC(IPC_CHANNELS.USER_UPDATE, i), () => httpPut(`/admin/users/${i.id}`, i));
export const userDelete = (i: UserDeleteInput) =>
  call<any>(IPC_CHANNELS.USER_DELETE, () => invokeIPC(IPC_CHANNELS.USER_DELETE, i), () => httpDel(`/admin/users/${i.id}`));
/** 吊销某用户的全部登录会话（强制重新登录；不改密码）。 */
export const userRevokeTokens = (i: UserRevokeTokensInput) =>
  call<any>(IPC_CHANNELS.USER_REVOKE_TOKENS, () => invokeIPC(IPC_CHANNELS.USER_REVOKE_TOKENS, i), () => httpPost(`/admin/users/${i.id}/revoke-tokens`, {}));
/** 认证事件历史（登录/登出/吊销/改密，源自审计日志）。 */
export const loginHistory = (i?: LoginHistoryInput) =>
  call<LoginHistoryResult>(
    IPC_CHANNELS.AUTH_LOGIN_HISTORY,
    () => invokeIPC(IPC_CHANNELS.AUTH_LOGIN_HISTORY, i),
    () => {
      const qs = new URLSearchParams();
      if (i?.userId) qs.set("userId", i.userId);
      if (i?.days) qs.set("days", String(i.days));
      if (i?.limit) qs.set("limit", String(i.limit));
      const suffix = qs.size > 0 ? `?${qs.toString()}` : "";
      return httpGet(`/admin/login-history${suffix}`);
    },
  );

// -- Auth --
export const authLogin = (i: AuthLoginInput) =>
  call<AuthLoginOutcome>(
    IPC_CHANNELS.AUTH_LOGIN,
    () => invokeIPC<AuthLoginOutcome>(IPC_CHANNELS.AUTH_LOGIN, i),
    async (): Promise<AuthLoginOutcome> => {
      // 登录接口需要区分 401（凭证错误）/ 423（锁定），httpPost 会把非 2xx 抛成
      // 笼统 Error，丢失状态码 —— 这里直接 fetch，按状态码映射为可判别结果。
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(i),
      });
      if (res.status === 423) {
        const data = (await res.json().catch(() => ({}))) as { retryAfterSec?: number };
        return { ok: false, reason: "locked", retryAfterSec: data?.retryAfterSec };
      }
      if (!res.ok) return { ok: false, reason: "bad_credentials" };
      const r = (await res.json()) as AuthLoginResult;
      if (r?.token) setAuthToken(r.token);
      return { ok: true, ...r };
    },
  );
/** 修改自己的密码（需旧密码）。成功返回新凭证，旧 token 立即失效。 */
export const authChangePassword = (i: ChangePasswordInput) =>
  call<AuthLoginResult | undefined>(
    IPC_CHANNELS.AUTH_CHANGE_PASSWORD,
    () => invokeIPC<AuthLoginResult | undefined>(IPC_CHANNELS.AUTH_CHANGE_PASSWORD, i),
    async () => {
      const r = await httpPost<AuthLoginResult | undefined>("/auth/change-password", i);
      if (r?.token) setAuthToken(r.token);
      return r;
    },
  );
export const authLogout = () =>
  call<boolean>(IPC_CHANNELS.AUTH_LOGOUT, () => invokeIPC(IPC_CHANNELS.AUTH_LOGOUT), () => httpPost("/auth/logout"));
export const authSession = () =>
  call<AuthSession>(IPC_CHANNELS.AUTH_SESSION, () => invokeIPC(IPC_CHANNELS.AUTH_SESSION), () => httpGet("/auth/session"));

// -- 配置体检（Provider 连通性 + Agent 可运行性） --
export const providerHealth = () =>
  call<ProviderHealthResult>(IPC_CHANNELS.PROVIDER_HEALTH, () => invokeIPC(IPC_CHANNELS.PROVIDER_HEALTH), () => httpGet("/admin/providers/health"));

// -- 子 Agent 委派（记录视图） --
export const delegationList = () =>
  call<DelegationListResult>(IPC_CHANNELS.DELEGATION_LIST, () => invokeIPC(IPC_CHANNELS.DELEGATION_LIST), () => httpGet("/admin/delegations"));

// -- 通知（无人值守结果：站内铃铛 + Webhook 外推） --
export const notifyList = () =>
  call<NotificationListResult>(IPC_CHANNELS.NOTIFY_LIST, () => invokeIPC(IPC_CHANNELS.NOTIFY_LIST), () => httpGet("/admin/notifications"));
export const notifyRead = (i: NotificationReadInput) =>
  call<NotificationListResult>(IPC_CHANNELS.NOTIFY_READ, () => invokeIPC(IPC_CHANNELS.NOTIFY_READ, i), () => httpPost("/admin/notifications/read", i));
export const notifyClear = () =>
  call<boolean>(IPC_CHANNELS.NOTIFY_CLEAR, () => invokeIPC(IPC_CHANNELS.NOTIFY_CLEAR), () => httpPost("/admin/notifications/clear"));
export const notifyTest = () =>
  call<NotificationTestResult>(IPC_CHANNELS.NOTIFY_TEST, () => invokeIPC(IPC_CHANNELS.NOTIFY_TEST), () => httpPost("/admin/notifications/test"));

// -- 定时任务（无人值守 Agent；执行走同一治理通道） --
export const scheduleList = () =>
  call<SchedulerListResult>(IPC_CHANNELS.SCHEDULE_LIST, () => invokeIPC(IPC_CHANNELS.SCHEDULE_LIST), () => httpGet("/admin/schedules"));
export const scheduleUpsert = (i: ScheduledJobUpsertInput) =>
  call<ScheduledJob>(IPC_CHANNELS.SCHEDULE_UPSERT, () => invokeIPC(IPC_CHANNELS.SCHEDULE_UPSERT, i), () => httpPost("/admin/schedules", i));
export const scheduleDelete = (i: ScheduledJobDeleteInput) =>
  call<boolean>(IPC_CHANNELS.SCHEDULE_DELETE, () => invokeIPC(IPC_CHANNELS.SCHEDULE_DELETE, i), () => httpDel(`/admin/schedules/${i.id}`));
export const scheduleRun = (i: ScheduledJobDeleteInput) =>
  call<{ ok: boolean; error?: string }>(IPC_CHANNELS.SCHEDULE_RUN, () => invokeIPC(IPC_CHANNELS.SCHEDULE_RUN, i), () => httpPost(`/admin/schedules/${i.id}/run`));

// -- Knowledge（RAG；向量化走配置的 Embedding Provider） --
export const knowledgeList = () =>
  call<KnowledgeListResult>(IPC_CHANNELS.KNOWLEDGE_LIST, () => invokeIPC(IPC_CHANNELS.KNOWLEDGE_LIST), () => httpGet("/admin/knowledge"));
export const knowledgeUpsert = (i: KnowledgeUpsertInput) =>
  call<KnowledgeCollection>(IPC_CHANNELS.KNOWLEDGE_UPSERT, () => invokeIPC(IPC_CHANNELS.KNOWLEDGE_UPSERT, i), () => httpPost("/admin/knowledge", i));
export const knowledgeDelete = (i: KnowledgeDeleteInput) =>
  call<boolean>(IPC_CHANNELS.KNOWLEDGE_DELETE, () => invokeIPC(IPC_CHANNELS.KNOWLEDGE_DELETE, i), () => httpDel(`/admin/knowledge/${i.id}`));
export const knowledgeDetail = (i: KnowledgeDeleteInput) =>
  call<KnowledgeDetailResult>(IPC_CHANNELS.KNOWLEDGE_DETAIL, () => invokeIPC(IPC_CHANNELS.KNOWLEDGE_DETAIL, i), () => httpGet(`/admin/knowledge/${i.id}`));
export const knowledgeDocDelete = (i: KnowledgeDocDeleteInput) =>
  call<boolean>(IPC_CHANNELS.KNOWLEDGE_DOC_DELETE, () => invokeIPC(IPC_CHANNELS.KNOWLEDGE_DOC_DELETE, i), () => httpDel(`/admin/knowledge/${i.collectionId}/docs/${i.docId}`));
export const knowledgeIngest = (i: KnowledgeIngestInput) =>
  call<KnowledgeIngestResult>(
    IPC_CHANNELS.KNOWLEDGE_INGEST,
    () => invokeIPC(IPC_CHANNELS.KNOWLEDGE_INGEST, i),
    () => httpPost(`/admin/knowledge/${i.collectionId}/ingest`, { title: i.title, text: i.text, path: i.path }),
  );
export const knowledgeSearch = (i: KnowledgeSearchInput) =>
  call<KnowledgeSearchResult>(
    IPC_CHANNELS.KNOWLEDGE_SEARCH,
    () => invokeIPC(IPC_CHANNELS.KNOWLEDGE_SEARCH, i),
    () => httpPost("/admin/knowledge/search", i),
  );

// -- MCP（外部工具；Web 模式走 /api/admin/mcp） --
export const mcpList = () =>
  call<McpListResult>(IPC_CHANNELS.MCP_LIST, () => invokeIPC(IPC_CHANNELS.MCP_LIST), () => httpGet("/admin/mcp"));
export const mcpUpsert = (i: McpUpsertInput) =>
  call<McpServerView>(IPC_CHANNELS.MCP_UPSERT, () => invokeIPC(IPC_CHANNELS.MCP_UPSERT, i), () => httpPost("/admin/mcp", i));
export const mcpDelete = (i: McpDeleteInput) =>
  call<boolean>(IPC_CHANNELS.MCP_DELETE, () => invokeIPC(IPC_CHANNELS.MCP_DELETE, i), () => httpDel(`/admin/mcp/${i.id}`));
export const mcpStop = (i: McpDeleteInput) =>
  call<boolean>(IPC_CHANNELS.MCP_STOP, () => invokeIPC(IPC_CHANNELS.MCP_STOP, i), () => httpPost(`/admin/mcp/${i.id}/stop`));
export const mcpTools = (i: McpToolsInput) =>
  call<McpToolsResult>(IPC_CHANNELS.MCP_TOOLS, () => invokeIPC(IPC_CHANNELS.MCP_TOOLS, i), () => httpGet(`/admin/mcp/${i.id}/tools`));
export const mcpCall = (i: McpCallInput) =>
  call<McpCallResult>(
    IPC_CHANNELS.MCP_CALL,
    () => invokeIPC(IPC_CHANNELS.MCP_CALL, i),
    () => httpPost(`/admin/mcp/${i.id}/call`, { tool: i.tool, args: i.args, workerId: i.workerId }),
  );

// -- Policy --
export const policyGet = () =>
  call<PolicyGetResult>(IPC_CHANNELS.POLICY_GET, () => invokeIPC(IPC_CHANNELS.POLICY_GET), () => httpGet("/admin/policy"));
export const policyUpdate = (i: PolicyUpdateInput) =>
  call<void>(IPC_CHANNELS.POLICY_UPDATE, () => invokeIPC(IPC_CHANNELS.POLICY_UPDATE, i), () => httpPut("/admin/policy", i));
export const policyCheck = (i: PolicyCheckInput) =>
  call<PolicyCheckResult>(IPC_CHANNELS.POLICY_CHECK, () => invokeIPC(IPC_CHANNELS.POLICY_CHECK, i), () => httpGet(`/admin/policy?path=${encodeURIComponent(i.path)}`));

/** 某 Worker 实际生效的策略（全局默认 + Worker 覆盖） */
export const policyEffective = (i: PolicyEffectiveInput) =>
  call<PolicyGetResult>(
    IPC_CHANNELS.POLICY_EFFECTIVE,
    () => invokeIPC(IPC_CHANNELS.POLICY_EFFECTIVE, i),
    async () => ({ policies: [] }),
  );

// -- Audit --
export const auditList = (i?: AuditListInput) =>
  call<AuditListResult>(IPC_CHANNELS.AUDIT_LIST, () => invokeIPC(IPC_CHANNELS.AUDIT_LIST, i), async () => ({ entries: [], date: "" }));

/** 校验某天审计日志的哈希链完整性（不可篡改证明）。Web 模式返回未校验。 */
export const auditVerify = (date?: string) =>
  call<{ valid: boolean; brokenAt?: number; checked: number }>(
    IPC_CHANNELS.AUDIT_VERIFY,
    () => invokeIPC(IPC_CHANNELS.AUDIT_VERIFY, { date }),
    async () => ({ valid: false, checked: 0 }),
  );

/** 取某个 Worker 对某文件的改动（改前快照 + 当前内容）。 */
export const fileDiff = (i: FileDiffInput) =>
  call<FileDiffResult>(
    IPC_CHANNELS.FILE_DIFF,
    () => invokeIPC(IPC_CHANNELS.FILE_DIFF, i),
    async () => ({ found: false, path: i.path, before: null, after: null }),
  );

/** 文件的历史版本（检查点）列表。 */
export const fileSnapshots = (i: FileSnapshotsInput) =>
  call<FileSnapshotsResult>(
    IPC_CHANNELS.FILE_SNAPSHOTS,
    () => invokeIPC(IPC_CHANNELS.FILE_SNAPSHOTS, i),
    async () => ({ path: i.path, snapshots: [] }),
  );

/** 恢复到某个历史版本（恢复前自动为当前内容补快照）。 */
export const fileRestore = (i: FileRestoreInput) =>
  call<FileRestoreResult>(
    IPC_CHANNELS.FILE_RESTORE,
    () => invokeIPC(IPC_CHANNELS.FILE_RESTORE, i),
    async () => ({ ok: false, path: i.path, error: "Web 模式暂不支持文件回滚" }),
  );

/** 受治理的文件工作区 */
export const fileList = (i: FileListInput) =>
  call<FileListResult>(
    IPC_CHANNELS.FILE_LIST,
    () => invokeIPC(IPC_CHANNELS.FILE_LIST, i),
    async () => ({ root: i?.path ?? "", parent: null, entries: [], writable: false }),
  );

export const fileRead = (i: FileReadInput) =>
  call<FileReadResult>(
    IPC_CHANNELS.FILE_READ,
    () => invokeIPC(IPC_CHANNELS.FILE_READ, i),
    async () => ({ ok: false, path: i.path, error: "Web 模式暂不支持文件工作区" }),
  );

export const fileWrite = (i: FileWriteInput) =>
  call<FileWriteResult>(
    IPC_CHANNELS.FILE_WRITE,
    () => invokeIPC(IPC_CHANNELS.FILE_WRITE, i),
    async () => ({ ok: false, path: i.path, error: "Web 模式暂不支持文件工作区" }),
  );

/** 受治理的终端 */
export const terminalStart = (i: TerminalStartInput) =>
  call<TerminalStatus>(
    IPC_CHANNELS.TERMINAL_START,
    () => invokeIPC(IPC_CHANNELS.TERMINAL_START, i),
    async () => ({ running: false, cwd: "", shell: "", blockedCount: 0 }),
  );

export const terminalWrite = (i: TerminalWriteInput) =>
  call<{ sent: boolean; blocked: boolean; reason?: string }>(
    IPC_CHANNELS.TERMINAL_WRITE,
    () => invokeIPC(IPC_CHANNELS.TERMINAL_WRITE, i),
    async () => ({ sent: false, blocked: false, reason: "Web 模式不支持终端" }),
  );

export const terminalStop = (i: TerminalStopInput) =>
  call<boolean>(
    IPC_CHANNELS.TERMINAL_STOP,
    () => invokeIPC(IPC_CHANNELS.TERMINAL_STOP, i),
    async () => false,
  );

export const terminalStatus = (i: TerminalStartInput) =>
  call<TerminalStatus>(
    IPC_CHANNELS.TERMINAL_STATUS,
    () => invokeIPC(IPC_CHANNELS.TERMINAL_STATUS, i),
    async () => ({ running: false, cwd: "", shell: "", blockedCount: 0 }),
  );

export const terminalClear = (i: TerminalStartInput) =>
  call<void>(
    IPC_CHANNELS.TERMINAL_CLEAR,
    () => invokeIPC(IPC_CHANNELS.TERMINAL_CLEAR, i),
    async () => undefined,
  );

/** 统一执行历史（Agent + 用户终端） */
export const executionList = (i?: ExecutionListInput) =>
  call<ExecutionListResult>(
    IPC_CHANNELS.EXECUTION_LIST,
    () => invokeIPC(IPC_CHANNELS.EXECUTION_LIST, i),
    async () => ({ events: [] }),
  );

/** 订阅终端输出流 */
export interface TerminalChunk { sessionId: string; text: string }
export function onTerminalEvent(cb: (chunk: TerminalChunk) => void): () => void {
  const api = getApi();
  if (typeof api.onTerminalEvent === "function") return api.onTerminalEvent(cb) as () => void;
  return () => {};
}

// -- Config --
export const configGet = () =>
  call<AppConfig>(IPC_CHANNELS.CONFIG_GET, () => invokeIPC(IPC_CHANNELS.CONFIG_GET), () => httpGet("/admin/config"));
export const configUpdate = (i: Partial<AppConfig>) =>
  call<void>(IPC_CHANNELS.CONFIG_UPDATE, () => invokeIPC(IPC_CHANNELS.CONFIG_UPDATE, i), () => httpPut("/admin/config", i));

// -- Egress --
export const egressWhitelist = () =>
  call<EgressWhitelistResult>(IPC_CHANNELS.EGRESS_WHITELIST, () => invokeIPC(IPC_CHANNELS.EGRESS_WHITELIST), async () => ({ endpoints: [] }));

// -- 审批 --
export const approvalList = () =>
  call<ApprovalListResult>(IPC_CHANNELS.APPROVAL_LIST, () => invokeIPC(IPC_CHANNELS.APPROVAL_LIST), async () => ({ approvals: [] }));
export const approvalDecide = (i: ApprovalDecideInput) =>
  call<boolean>(IPC_CHANNELS.APPROVAL_DECIDE, () => invokeIPC(IPC_CHANNELS.APPROVAL_DECIDE, i), async () => false);
export function onApprovalEvent(cb: (rec: ApprovalRecord) => void): () => void {
  const api = getApi();
  if (typeof api.onApprovalEvent === "function") return api.onApprovalEvent(cb) as () => void;
  return () => {};
}

// -- 后台任务 --
export const taskSubmit = (i: TaskSubmitInput) =>
  call<BackgroundTask>(IPC_CHANNELS.TASK_SUBMIT, () => invokeIPC(IPC_CHANNELS.TASK_SUBMIT, i), async () => {
    throw new Error("Web 模式暂不支持后台任务");
  });
export const taskList = (i?: TaskListInput) =>
  call<TaskListResult>(IPC_CHANNELS.TASK_LIST, () => invokeIPC(IPC_CHANNELS.TASK_LIST, i), async () => ({ tasks: [] }));
export const taskCancel = (i: TaskCancelInput) =>
  call<boolean>(IPC_CHANNELS.TASK_CANCEL, () => invokeIPC(IPC_CHANNELS.TASK_CANCEL, i), async () => false);

/** 订阅后台任务状态（Electron 模式；浏览器模式为 no-op）。 */
export function onTaskEvent(cb: (task: BackgroundTask) => void): () => void {
  const api = getApi();
  if (typeof api.onTaskEvent === "function") return api.onTaskEvent(cb) as () => void;
  return () => {};
}

// -- Swarm --
export const swarmExecute = (i: SwarmExecuteInput) =>
  call<unknown>(IPC_CHANNELS.SWARM_EXECUTE, () => invokeIPC(IPC_CHANNELS.SWARM_EXECUTE, i), async () => ({}));
export const swarmHistory = () =>
  call<SwarmHistoryEntry[]>(IPC_CHANNELS.SWARM_HISTORY, () => invokeIPC(IPC_CHANNELS.SWARM_HISTORY), async () => []);

// -- Pi process --
export const piStart = (i?: PiStartInput) =>
  call<boolean>(IPC_CHANNELS.PI_START, () => invokeIPC(IPC_CHANNELS.PI_START, i), async () => false);
export const piStop = () =>
  call<boolean>(IPC_CHANNELS.PI_STOP, () => invokeIPC(IPC_CHANNELS.PI_STOP), async () => false);
export const piStatus = () =>
  call<PiStatusResult>(IPC_CHANNELS.PI_STATUS, () => invokeIPC(IPC_CHANNELS.PI_STATUS), async () => ({ running: false, pid: null }));
// pi:exec 具备命令执行语义，已对渲染进程隐藏且不注册主进程 handler（见
// shared/ipc-channels.ts 的 BLOCKED_FROM_RENDERER），故此处不提供包装。

// -- Provider test --
export const providerTest = (i: ModelProviderTestInput) =>
  call<ModelProviderTestResult>(IPC_CHANNELS.PROVIDER_TEST, () => invokeIPC(IPC_CHANNELS.PROVIDER_TEST, i), () => httpPost("/providers/test", i));

// -- Legacy --
export const statusGet = () =>
  call<SystemStatus>(IPC_CHANNELS.STATUS_GET, () => invokeIPC(IPC_CHANNELS.STATUS_GET), () => httpGet("/status"));

// -- 治理总览 --
export const governanceSummary = () =>
  call<{
    workers: Array<{ id: string; name: string; spentUsd: number; budgetLimitUsd?: number }>;
    blockedToday: number;
    guardrailToday: number;
    egress: { enforced: boolean; endpoints: string[] };
    sandboxMode: "local" | "docker";
    audit: { valid: boolean; checked: number };
  }>(
    IPC_CHANNELS.GOVERNANCE_SUMMARY,
    () => invokeIPC(IPC_CHANNELS.GOVERNANCE_SUMMARY),
    async () => ({ workers: [], blockedToday: 0, guardrailToday: 0, egress: { enforced: false, endpoints: [] }, sandboxMode: "local", audit: { valid: false, checked: 0 } }),
  );

// -- Deprecated --
// agentSend / agentAbort / agentNew 引用了 IPC_CHANNELS 中并不存在的
// AGENT_SEND / AGENT_ABORT / AGENT_NEW，且无调用方，已移除。
export interface AgentStreamEvent { type: string; delta?: string; toolName?: string; input?: unknown; isError?: boolean; message?: string }
export function onAgentEvent(cb: (event: AgentStreamEvent) => void): () => void {
  const api = getApi();
  if (typeof api.onAgentEvent === "function") return api.onAgentEvent(cb) as () => void;
  return () => {};
}
