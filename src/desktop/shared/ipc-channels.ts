export const IPC_CHANNELS = {
  // Workspace — user side
  WORKSPACE_LIST: "workspace:list",
  WORKSPACE_CHAT_SEND: "workspace:chat:send",
  WORKSPACE_CHAT_ABORT: "workspace:chat:abort",

  // Admin — worker management
  WORKER_LIST: "worker:list",
  WORKER_CREATE: "worker:create",
  WORKER_UPDATE: "worker:update",
  WORKER_DELETE: "worker:delete",
  /** 归档/恢复（归档不删除，可恢复） */
  WORKER_ARCHIVE: "worker:archive",
  /** 以现有 Worker 为模板克隆副本 */
  WORKER_CLONE: "worker:clone",
  /** 回滚配置到历史版本 */
  WORKER_ROLLBACK_CONFIG: "worker:rollback-config",
  WORKER_START: "worker:start",
  WORKER_STATUS: "worker:status",
  /** 重新分配（多用户 + 用户组） */
  WORKER_ASSIGN: "worker:assign",

  // Admin — user groups
  GROUP_LIST: "group:list",
  GROUP_UPSERT: "group:upsert",
  GROUP_DELETE: "group:delete",

  // Agent adapters (governance portal engines)
  ADAPTERS_LIST: "adapters:list",

  // Admin — user management
  USER_LIST: "user:list",
  USER_CREATE: "user:create",
  USER_UPDATE: "user:update",
  USER_DELETE: "user:delete",
  /** 吊销某用户的全部登录会话（强制重新登录） */
  USER_REVOKE_TOKENS: "user:revoke-tokens",

  // Admin — auth
  AUTH_LOGIN: "auth:login",
  AUTH_LOGOUT: "auth:logout",
  AUTH_SESSION: "auth:session",
  AUTH_CHANGE_PASSWORD: "auth:change-password",
  /** 认证事件历史（登录/登出/吊销/改密，源自审计日志） */
  AUTH_LOGIN_HISTORY: "auth:login-history",

  // Admin — policy
  POLICY_GET: "policy:get",
  POLICY_UPDATE: "policy:update",
  POLICY_CHECK: "policy:check",
  POLICY_EFFECTIVE: "policy:effective",

  // Admin — audit
  AUDIT_LIST: "audit:list",
  /** 校验某天审计日志的哈希链完整性（不可篡改证明） */
  AUDIT_VERIFY: "audit:verify",

  // Admin — 审批（高危操作的挂起与放行）
  APPROVAL_LIST: "approval:list",
  APPROVAL_DECIDE: "approval:decide",

  // 会话内文件 diff（用户查看自己 Agent 的改动）
  FILE_DIFF: "file:diff",

  // 文件快照链与回滚（检查点）
  FILE_SNAPSHOTS: "file:snapshots",
  FILE_RESTORE: "file:restore",

  // 受治理的文件工作区
  FILE_LIST: "file:list",
  FILE_READ: "file:read",
  FILE_WRITE: "file:write",

  // 受治理的终端（命令过策略 + 全量审计）
  TERMINAL_START: "terminal:start",
  TERMINAL_WRITE: "terminal:write",
  TERMINAL_STOP: "terminal:stop",
  TERMINAL_STATUS: "terminal:status",
  TERMINAL_CLEAR: "terminal:clear",

  // 统一执行历史（Agent + 用户终端）
  EXECUTION_LIST: "execution:list",

  // 后台任务（异步执行，不阻塞当前对话）
  TASK_SUBMIT: "task:submit",
  TASK_LIST: "task:list",
  TASK_CANCEL: "task:cancel",

  // Admin — swarm
  SWARM_EXECUTE: "swarm:execute",
  SWARM_HISTORY: "swarm:history",

  // Admin — 定时任务（无人值守 Agent；执行走同一治理通道）
  SCHEDULE_LIST: "schedule:list",
  SCHEDULE_UPSERT: "schedule:upsert",
  SCHEDULE_DELETE: "schedule:delete",
  SCHEDULE_RUN: "schedule:run",

  // Admin — 通知（无人值守结果：站内铃铛 + Webhook 外推）
  NOTIFY_LIST: "notify:list",
  NOTIFY_READ: "notify:read",
  NOTIFY_CLEAR: "notify:clear",
  NOTIFY_TEST: "notify:test",

  // Admin — 子 Agent 委派（记录视图，供治理总览时间线）
  DELEGATION_LIST: "delegation:list",

  // Admin — 配置体检（Provider 连通性 + Agent 可运行性）
  PROVIDER_HEALTH: "provider:health",

  // Admin — Knowledge（RAG：向量化走 API，检索写审计）
  KNOWLEDGE_LIST: "knowledge:list",
  KNOWLEDGE_UPSERT: "knowledge:upsert",
  KNOWLEDGE_DELETE: "knowledge:delete",
  KNOWLEDGE_DETAIL: "knowledge:detail",
  KNOWLEDGE_DOC_DELETE: "knowledge:doc:delete",
  KNOWLEDGE_INGEST: "knowledge:ingest",
  KNOWLEDGE_SEARCH: "knowledge:search",

  // Admin — MCP（外部工具，调用过策略 + 审计）
  MCP_LIST: "mcp:list",
  MCP_UPSERT: "mcp:upsert",
  MCP_DELETE: "mcp:delete",
  MCP_TOOLS: "mcp:tools",
  MCP_CALL: "mcp:call",
  MCP_STOP: "mcp:stop",

  // Admin — egress
  EGRESS_WHITELIST: "egress:whitelist",

  // Admin — config / providers
  CONFIG_GET: "config:get",
  CONFIG_UPDATE: "config:update",
  PROVIDER_TEST: "provider:test",

  // Admin — pi process
  PI_START: "pi:start",
  PI_STOP: "pi:stop",
  PI_STATUS: "pi:status",
  PI_EXEC: "pi:exec",

  // Admin — legacy (to be deprecated)
  STATUS_GET: "status:get",

  // Admin — 治理总览（聚合：沙箱/出网/护栏/预算/审计完整性）
  GOVERNANCE_SUMMARY: "governance:summary",
} as const;

export const AGENT_EVENT_CHANNEL = "agent:event";
export const WORKSPACE_CHAT_EVENT = "workspace:chat:event";
export const TERMINAL_EVENT = "terminal:event";
/** Swarm 执行进度推送（主进程 → 渲染进程）。 */
export const SWARM_EVENT = "swarm:event";
/** 后台任务状态推送（主进程 → 渲染进程）。 */
export const TASK_EVENT = "task:event";
/** 审批请求/决策推送（主进程 → 渲染进程）。 */
export const APPROVAL_EVENT = "approval:event";
export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
export const ALL_IPC_CHANNELS: readonly string[] = Object.values(IPC_CHANNELS);

/**
 * 特权 channel：仅管理员会话可调用。
 *
 * 主进程 `ipc-handlers.ts` 会校验调用者角色；preload 侧的裁剪只用于缩小
 * 攻击面，真正的安全边界始终在主进程（渲染进程不可信）。
 */
export const PRIVILEGED_IPC_CHANNELS: ReadonlySet<string> = new Set<string>([
  IPC_CHANNELS.POLICY_UPDATE,
  IPC_CHANNELS.CONFIG_UPDATE,
  // worker:list 返回全量 Worker（含他人配置）——仅管理员可调；
  // 普通用户的可见列表走 workspace:list（按用户/组/全员过滤）。
  IPC_CHANNELS.WORKER_LIST,
  IPC_CHANNELS.WORKER_CREATE,
  IPC_CHANNELS.WORKER_UPDATE,
  IPC_CHANNELS.WORKER_DELETE,
  IPC_CHANNELS.WORKER_ARCHIVE,
  IPC_CHANNELS.WORKER_CLONE,
  IPC_CHANNELS.WORKER_ROLLBACK_CONFIG,
  IPC_CHANNELS.WORKER_ASSIGN,
  IPC_CHANNELS.USER_CREATE,
  IPC_CHANNELS.USER_UPDATE,
  IPC_CHANNELS.USER_DELETE,
  // 吊销会话与登录历史属身份治理操作/信息，仅管理员
  IPC_CHANNELS.USER_REVOKE_TOKENS,
  IPC_CHANNELS.AUTH_LOGIN_HISTORY,
  IPC_CHANNELS.GROUP_UPSERT,
  IPC_CHANNELS.GROUP_DELETE,
  IPC_CHANNELS.SWARM_EXECUTE,
  // 审计完整性校验属治理信息（证明日志未被篡改），仅管理员可调
  IPC_CHANNELS.AUDIT_VERIFY,
  // 审批属于治理信息（含被拦截路径）：列表与决策都仅限管理员
  IPC_CHANNELS.APPROVAL_LIST,
  IPC_CHANNELS.APPROVAL_DECIDE,
  IPC_CHANNELS.PI_START,
  IPC_CHANNELS.PI_STOP,
  // MCP 服务器配置属管理数据；工具调用具备外部副作用，同样限后台权限
  IPC_CHANNELS.MCP_UPSERT,
  IPC_CHANNELS.MCP_DELETE,
  IPC_CHANNELS.MCP_CALL,
  IPC_CHANNELS.MCP_STOP,
  // 知识库：摄取/删除/检索都涉及数据面与审计，限后台权限
  IPC_CHANNELS.KNOWLEDGE_UPSERT,
  IPC_CHANNELS.KNOWLEDGE_DELETE,
  IPC_CHANNELS.KNOWLEDGE_DOC_DELETE,
  IPC_CHANNELS.KNOWLEDGE_INGEST,
  IPC_CHANNELS.KNOWLEDGE_SEARCH,
  // 定时任务：能让 Agent 无人值守执行，属高权限配置
  IPC_CHANNELS.SCHEDULE_UPSERT,
  IPC_CHANNELS.SCHEDULE_DELETE,
  IPC_CHANNELS.SCHEDULE_RUN,
  // 通知：反映无人值守运行状态与 Webhook 配置，同属后台面
  IPC_CHANNELS.NOTIFY_LIST,
  IPC_CHANNELS.NOTIFY_READ,
  IPC_CHANNELS.NOTIFY_CLEAR,
  IPC_CHANNELS.NOTIFY_TEST,
  // 委派记录：暴露 Agent 之间的协作轨迹，属治理信息
  IPC_CHANNELS.DELEGATION_LIST,
  // 体检会带密钥探测外部端点，属后台面
  IPC_CHANNELS.PROVIDER_HEALTH,
  // 终端具备命令执行语义，属于高危操作
  IPC_CHANNELS.TERMINAL_START,
  IPC_CHANNELS.TERMINAL_WRITE,
  IPC_CHANNELS.TERMINAL_STOP,
]);

/**
 * 对渲染进程完全隐藏的高危 channel。
 * `pi:exec` 具备命令执行语义，当前 UI 无消费者，故不暴露到 window.eag。
 */
export const BLOCKED_FROM_RENDERER: ReadonlySet<string> = new Set<string>([
  IPC_CHANNELS.PI_EXEC,
]);

/** 渲染进程可见的 channel 白名单。 */
export const RENDERER_IPC_CHANNELS: readonly string[] = ALL_IPC_CHANNELS.filter(
  (c) => !BLOCKED_FROM_RENDERER.has(c),
);
