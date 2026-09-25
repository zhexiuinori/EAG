import type { PolicyMap } from "../../extension/policy.ts";

// -- Worker ------------------------------------------------------------------
export type WorkerType = "personal" | "project";
export type WorkerStatus = "running" | "stopped" | "error";

/** Which embedded agent engine drives this worker. Missing = legacy "pi". */
export type AgentKind = "claude-code" | "codex" | "pi" | "qwenpaw" | "openclaw";

export interface WorkerPolicy {
  path: string;
  access: "rw" | "r" | "hidden";
}

export interface WorkerConfig {
  modelProviderId: string;
  modelName: string;
  agentKind?: AgentKind;
  policies: WorkerPolicy[];
  sessionIsolation: boolean;
  auditEnabled: boolean;
  /**
   * 管理员为 Worker 设定的角色与规范，会前置到每次对话的 prompt 中。
   * 这是平台相对"直接用 CLI"的核心增量之一。
   */
  systemPrompt?: string;
  /**
   * 预算封顶（USD）：该 Worker 累计消耗超过此值时拒绝发起新对话。
   * 缺省 = 不限制。成本数据来自各引擎的 cost 事件（claude / codex 有效，
   * pi 无 cost 上报故不参与）。
   */
  budgetLimitUsd?: number;
  /**
   * 挂载的知识库（RAG）：对话前用用户消息检索这些集合，命中片段注入 prompt。
   * 缺省 = 不检索（零额外开销）。
   */
  knowledgeIds?: string[];
}

export interface Worker {
  id: string;
  name: string;
  description: string;
  type: WorkerType;
  status: WorkerStatus;
  /** 主负责人（userId）。多用户分配后 = assignedUserIds[0]（向后兼容旧数据） */
  assignedTo: string;
  /**
   * 多用户分配：完整可见用户列表（含主负责人）。
   * 缺省/为空时回退到 assignedTo，保证旧数据语义不变。
   */
  assignedUserIds?: string[];
  /** 可见的用户组：组成员均可使用该 Agent（团队共享的中间粒度） */
  assignedGroupIds?: string[];
  config: WorkerConfig;
  createdAt: string;
  updatedAt: string;
}

export interface WorkerListResult { workers: Worker[] }
export interface WorkerCreateInput {
  name: string; description: string; type: WorkerType;
  assignedTo: string; config: WorkerConfig;
  /** 创建时即可指定多用户 / 组（缺省时回退 assignedTo） */
  assignedUserIds?: string[];
  assignedGroupIds?: string[];
}
export interface WorkerUpdateInput { id: string; patch: Partial<Worker> }

/** 重新分配：谁能用这个 Agent（用户 + 组）。 */
export interface WorkerAssignInput {
  id: string;
  userIds: string[];
  groupIds: string[];
}

// -- 用户组 ------------------------------------------------------------------

/** 用户组：团队共享 Agent 的中间粒度（比"单人"宽、比"全员 project"窄）。 */
export interface UserGroup {
  id: string;
  name: string;
  memberIds: string[];
  createdAt: string;
}

export interface GroupListResult { groups: UserGroup[] }
export interface GroupUpsertInput { id?: string; name: string; memberIds: string[] }
export interface GroupDeleteInput { id: string }

// -- User --------------------------------------------------------------------
export type UserRole = "admin" | "user";

/**
 * 用户（对外公共视图，绝不含密码）。
 * canManageConsole：非管理员亦可被单独授予后台权限（服务端/前端守卫共用）。
 */
export interface User {
  id: string;
  name: string;
  /** 登录账号（唯一） */
  username: string;
  role: UserRole;
  /** 是否允许访问管理控制台（/admin/*） */
  canManageConsole: boolean;
  createdAt: string;
}

/** 服务端内部记录：额外持有密码哈希（scrypt 加盐），禁止出网。 */
export interface UserRecord extends User {
  passwordHash: string;
}

export interface UserListResult { users: User[] }
export interface UserCreateInput {
  name: string;
  username: string;
  role: UserRole;
  password: string;
  canManageConsole?: boolean;
}
export interface UserDeleteInput { id: string }
/** 用户更新（仅管理端可调）：改名称/角色/后台授权/重置密码 */
export interface UserUpdateInput {
  id: string;
  name?: string;
  role?: UserRole;
  canManageConsole?: boolean;
  /** 提供即重置密码（保留旧值时不传） */
  password?: string;
}

// -- Auth --------------------------------------------------------------------
export interface AuthLoginInput { username: string; password: string }
export interface AuthSession {
  userId: string;
  userName: string;
  username: string;
  role: UserRole;
  canManageConsole: boolean;
}
/** 登录成功：会话 + 后续请求所需凭证。 */
export interface AuthLoginResult {
  session: AuthSession;
  token: string;
}
/** 修改自己的密码：需校验旧密码，成功后签发新 token（旧 token 立即失效）。 */
export interface ChangePasswordInput {
  oldPassword: string;
  newPassword: string;
}

// -- MCP（Model Context Protocol）-------------------------------------------

/**
 * 一个 MCP 服务器配置。
 * transport 目前只支持 stdio（本地子进程），这也是绝大多数 MCP server 的形态。
 * env 支持 "${ENV_VAR}" 占位符，密钥不落明文（与 config-api 一致）。
 */
export interface McpServerConfig {
  id: string;
  name: string;
  /** 启动命令，如 npx / node / python */
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  enabled: boolean;
  createdAt: string;
}

/** 对外视图：不返回 env 明文，只回占位符或空（避免密钥泄漏到前端）。 */
export interface McpServerView extends Omit<McpServerConfig, "env"> {
  envKeys: string[];
  /** 进程是否在运行（供 UI 展示状态） */
  running: boolean;
}

/** MCP 工具描述（来自 tools/list）。 */
export interface McpTool {
  /** 带命名空间的名字：serverId::toolName */
  qualifiedName: string;
  serverId: string;
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpListResult { servers: McpServerView[] }
export interface McpUpsertInput {
  id?: string;
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  enabled?: boolean;
}
export interface McpDeleteInput { id: string }
export interface McpToolsInput { id: string }
export interface McpToolsResult { tools: McpTool[]; running: boolean; error?: string }
export interface McpCallInput {
  id: string;
  tool: string;
  args?: Record<string, unknown>;
  /** 关联到哪个 Worker（用于策略与审计归属）；缺省为 console */
  workerId?: string;
}
export interface McpCallResult {
  ok: boolean;
  /** 被策略拦截时为空 */
  result?: unknown;
  error?: string;
  blocked?: boolean;
  blockedReason?: string;
}

// -- Policy ------------------------------------------------------------------
export interface PolicyGetResult { policies: PolicyMap }
export interface PolicyUpdateInput { policies: PolicyMap }
export interface PolicyCheckInput { path: string }
/** 查询某 Worker 实际生效的策略（全局默认 + Worker 覆盖） */
export interface PolicyEffectiveInput { workerId: string }
export interface PolicyCheckResult { allowed: boolean; access: string | null }

// -- Audit ------------------------------------------------------------------
export interface AuditListInput { date?: string; limit?: number; search?: string; workerId?: string }
export interface AuditEntry {
  timestamp: string; userId: string; toolName: string;
  toolCallId: string | undefined; phase: "call" | "result";
  input: Record<string, unknown> | undefined; content?: string;
  isError?: boolean; reason?: string; preImage?: string;
  workerId?: string; costUsd?: number;
}
export interface AuditListResult { entries: AuditEntry[]; date: string }

// -- 受治理的文件工作区 -----------------------------------------------------
export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  /** 策略判定结果；hidden 条目不会返回给前端 */
  access?: "rw" | "r" | "hidden";
  size?: number;
}

export interface FileListResult {
  root: string;
  parent: string | null;
  entries: FileEntry[];
  /** 当前目录是否可写，决定前端是否显示编辑入口 */
  writable: boolean;
}

export interface FileReadResult {
  ok: boolean;
  path: string;
  content?: string;
  error?: string;
  access?: "rw" | "r" | "hidden";
  truncated?: boolean;
}

export interface FileWriteResult {
  ok: boolean;
  path: string;
  error?: string;
}

// -- 统一执行通道 -----------------------------------------------------------

/** 命令来源：Agent 自动执行 / 用户在平台终端执行 */
export type ExecutionSource = "agent" | "user";

/**
 * 执行判定三态。
 * `observed` 表示平台只能看到、无法拦截（当前 claude / codex 的状态），
 * 不能把它当成"已管控"。
 */
export type ExecutionVerdict = "allowed" | "blocked" | "observed";

export interface ExecutionEvent {
  id: string;
  source: ExecutionSource;
  sessionId: string;
  command: string;
  cwd: string;
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  /** 输出摘要（截断），避免审计与内存膨胀 */
  outputPreview?: string;
  verdict: ExecutionVerdict;
  blockedReason?: string;
}

export interface ExecutionListInput {
  sessionId?: string;
  source?: ExecutionSource;
  limit?: number;
}
export interface ExecutionListResult { events: ExecutionEvent[] }

// -- 受治理的终端 -----------------------------------------------------------
export interface TerminalStartInput { sessionId: string; cwd?: string }
export interface TerminalWriteInput { sessionId: string; command: string }
export interface TerminalStopInput { sessionId: string }
export interface TerminalStatus {
  running: boolean;
  cwd: string;
  shell: string;
  startedAt?: number;
  /** 被策略阻断的命令数 */
  blockedCount: number;
}

export interface FileListInput { path: string }
export interface FileReadInput { path: string }
export interface FileWriteInput { path: string; content: string }

/** 内容级 diff：改前快照（审计日志）+ 改后内容（磁盘当前）。 */
export interface FileDiffInput { workerId: string; path: string }
export interface FileDiffResult {
  found: boolean;
  path: string;
  /** 修改前内容；null = 新建文件或无快照 */
  before: string | null;
  /** 当前内容；null = 文件已被删除 */
  after: string | null;
  changedAt?: string;
  note?: string;
}

// -- 文件快照链（检查点 / 回滚） ---------------------------------------------

export interface FileSnapshot {
  timestamp: string;
  /** 快照内容字符数 */
  size: number;
  /** 是否为最近一次改动前的版本 */
  latest?: boolean;
}

export interface FileSnapshotsInput { workerId: string; path: string }
export interface FileSnapshotsResult { path: string; snapshots: FileSnapshot[] }

export interface FileRestoreInput { workerId: string; path: string; timestamp: string }
export interface FileRestoreResult { ok: boolean; path: string; error?: string }

// -- 审批（高危操作的挂起与放行） ---------------------------------------------

/**
 * 审批请求：Agent 触达被策略拒绝的写操作时挂起，等待管理员裁决。
 * 读操作不进入审批（保持 ENOENT 伪装，不通过审批行为暴露文件存在性）。
 */
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface ApprovalRecord {
  id: string;
  toolName: string;
  path: string;
  /** 被拒原因类别：hidden（策略不可见）/ read-only（只读路径） */
  access: string;
  reason?: string;
  ts: string;
  cwd?: string;
  pid?: number;
  status: ApprovalStatus;
  decidedAt?: string;
}

export interface ApprovalListResult { approvals: ApprovalRecord[] }
export interface ApprovalDecideInput { id: string; approved: boolean }

// -- 后台任务 ----------------------------------------------------------------

/**
 * 后台任务状态机（参考 QwenPaw 的 background task）：
 *   queued → running → done / error / cancelled
 */
export type BackgroundTaskStatus = "queued" | "running" | "done" | "error" | "cancelled";

export interface BackgroundTask {
  id: string;
  workerId: string;
  /** 提交者（userId）：任务列表按此隔离；审计归属也用它（提交后切换身份不影响归属） */
  userId: string;
  /** Worker 名称快照，便于列表展示 */
  workerName?: string;
  text: string;
  status: BackgroundTaskStatus;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  /** 最新输出预览（滚动截断） */
  outputPreview: string;
  error?: string;
}

export interface TaskSubmitInput { workerId: string; text: string }
export interface TaskListInput { workerId?: string }
export interface TaskListResult { tasks: BackgroundTask[] }
export interface TaskCancelInput { id: string }

// -- 定时任务（无人值守 Agent）----------------------------------------------

/**
 * 定时任务：按周期自动把 prompt 交给某个 Worker 执行。
 * 触发规则二选一：everyMinutes（每 N 分钟）或 dailyAt（每天 HH:MM）。
 * 执行同样受治理：预算检查、策略、审计（operatorId = scheduler）。
 */
export interface ScheduledJob {
  id: string;
  name: string;
  workerId: string;
  prompt: string;
  /** 每 N 分钟触发（与 dailyAt 二选一） */
  everyMinutes?: number;
  /** 每天 HH:MM 触发（与 everyMinutes 二选一） */
  dailyAt?: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  lastStatus?: "ok" | "error";
  lastError?: string;
  /** 由服务端计算，供 UI 展示 */
  nextRunAt?: string;
}
export interface SchedulerListResult { jobs: ScheduledJob[] }
export interface ScheduledJobUpsertInput {
  id?: string;
  name: string;
  workerId: string;
  prompt: string;
  everyMinutes?: number;
  dailyAt?: string;
  enabled?: boolean;
}
export interface ScheduledJobDeleteInput { id: string }

// -- Swarm ------------------------------------------------------------------
import type { UserRequest, SwarmResult, WorkerPoolConfig, SwarmProgressEvent } from "../../swarm/types.ts";
export type { SwarmProgressEvent };
export interface SwarmExecuteInput { request: UserRequest; config?: Partial<WorkerPoolConfig> }
export interface SwarmHistoryEntry { id: string; prompt: string; result: SwarmResult; createdAt: string }

// -- Model Provider ---------------------------------------------------------
export type ProviderType = "ollama" | "openai" | "anthropic" | "deepseek" | "custom";
export interface ModelProvider {
  id: string; name: string; type: ProviderType;
  baseUrl: string; apiKey?: string;
  models: string[]; activeModel: string; isDefault?: boolean;
}
export interface ModelProviderTestInput { type: ProviderType; baseUrl: string; apiKey?: string; model: string }
export interface ModelProviderTestResult { success: boolean; latencyMs?: number; error?: string }

// -- 配置体检（Provider 连通性 + Agent 可运行性）------------------------------

/**
 * 体检结论分类 —— 每一类对应一种**不同的修法**（这正是体检的意义：
 * 不要笼统地报"连不上"，而是告诉用户改哪里）。
 */
export type ProviderHealthStatus =
  /** 网络可达 + 鉴权通过 + 模型列表可读 */
  | "ok"
  /** 未配置 API 密钥（引擎不会注入鉴权头，多半会回落到厂商默认端点） */
  | "no-key"
  /** 网络层失败：DNS / 拒绝连接 / 超时 / TLS 握手 */
  | "unreachable"
  /** 密钥被拒（401/403） */
  | "unauthorized"
  /** 端点路径不对（404） */
  | "bad-endpoint"
  /** 其他错误 */
  | "error";

export interface ProviderHealth {
  providerId: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  hasKey: boolean;
  status: ProviderHealthStatus;
  httpStatus?: number;
  latencyMs?: number;
  /** 模型列表条数（探测到的） */
  modelCount?: number;
  /** 实际探测的 URL（便于核对 baseUrl 是否写对） */
  probe?: string;
  /** 人话诊断 + 修复建议 */
  message: string;
}

/** 单个 Agent（Worker）能不能真正跑起来：引擎装了？端点通吗？ */
export interface WorkerReadiness {
  workerId: string;
  name: string;
  agentKind: AgentKind;
  engineInstalled: boolean;
  providerId?: string;
  providerName?: string;
  providerStatus?: ProviderHealthStatus;
  runnable: boolean;
  /** 阻塞原因（人话），runnable=false 时非空 */
  blockers: string[];
}

export interface ProviderHealthResult {
  providers: ProviderHealth[];
  workers: WorkerReadiness[];
  checkedAt: string;
}

// -- Pi ---------------------------------------------------------------------
export interface PiStartInput { args?: string[] }
export interface PiStatusResult { running: boolean; pid: number | null }
export interface PiExecInput { command: string; model?: string }
export interface PiExecResult { success: boolean; output: string; durationMs: number }

// -- Egress -----------------------------------------------------------------
export interface EgressWhitelistResult { endpoints: string[] }

// -- System status ---------------------------------------------------------
/** 顶栏用的系统状态快照（对应 status:get）。 */
export interface SystemStatus {
  piRunning: boolean;
  piPid: number | null;
  userId: string;
  policyEntryCount: number;
  auditTodayCount: number;
  uptime: number;
}

// -- Config -----------------------------------------------------------------
/**
 * Embedding 配置（RAG 用）。
 * 不引入独立密钥体系：直接复用某个 ModelProvider 的 baseUrl + apiKey
 * 调它的 OpenAI 兼容 /embeddings（或 Ollama 的 /api/embed）。
 * providerId 为空 = 未配置 RAG（检索会明确报错，不静默降级成假结果）。
 */
export interface EmbeddingConfig {
  providerId: string;
  /** embedding 模型，如 text-embedding-3-small / nomic-embed-text */
  model: string;
}

export interface AppConfig {
  providers: ModelProvider[];
  activeProviderId: string;
  searchProxy: string;
  auditDir: string;
  maxWorkers: number;
  taskTimeoutMs: number;
  /** RAG 向量化配置（缺省 = 未启用） */
  embedding?: EmbeddingConfig;
  /**
   * 通知外推地址（Webhook）。留空 = 只写站内通知。
   * 飞书/钉钉的群机器人地址会被自动识别并按各自格式发送，其余按通用 JSON。
   */
  notifyWebhook?: string;
  /**
   * 子 Agent 委派链的最大深度（默认 2）。
   * 1 = 只允许一层委派（子 Agent 不能再委派）；越大链路越长、越容易被滥用。
   */
  maxDelegationDepth?: number;
}

// -- 通知（无人值守结果的"喊人"通道）----------------------------------------

/**
 * 站内通知 + 可选 Webhook 外推。
 * 触发点：定时任务完成/失败、预算耗尽等后台事件 —— 用户不在电脑前也能知道。
 * 每条通知同时写审计（__notification），"通知了什么"可追溯。
 */
export interface NotifyEvent {
  id: string;
  title: string;
  body?: string;
  level: "info" | "success" | "warn" | "error";
  /** 来源标识，如 scheduler:job-xxx */
  source: string;
  at: string;
  read: boolean;
}
export interface NotifyInput {
  title: string;
  body?: string;
  level?: NotifyEvent["level"];
  source: string;
}
export interface NotificationListResult {
  items: NotifyEvent[];
  unread: number;
}
export interface NotificationReadInput {
  /** 省略 = 全部标记已读 */
  ids?: string[];
}
export interface NotificationTestResult {
  ok: boolean;
  /** 是否真的发出了外推请求（未配置 webhook 时为 false） */
  sent: boolean;
  error?: string;
}

// -- 子 Agent 委派（Delegation）----------------------------------------------

/**
 * 委派请求（由 MCP 代理进程写入 .eag/delegations/<id>.req.json）。
 * 身份字段来自代理注入的 env，Agent 只能控制 target / prompt 两个参数。
 */
export interface DelegationRequest {
  id: string;
  /** 目标：Worker 名称或 id；"list" 表示只查询可委派清单 */
  target: string;
  prompt: string;
  /** 发起方 Worker（用于深度限制 / 自委派拦截 / 计划模式拦截） */
  fromWorkerId?: string;
  /** 发起方用户（决定目标可见范围，也是执行时的 operatorId） */
  fromUserId: string;
  /**
   * 发起方会话的委派深度（由 MCP 代理从 env 读出后写入）：
   * 0 = 用户直接会话；n = 第 n 层子 Agent。执行时下一层为 n+1。
   */
  depth?: number;
  createdAt: string;
}

/** 委派记录（可视化用：req/ack/res 三份文件合并后的视图）。 */
export interface DelegationRecord {
  id: string;
  /** 原始 target 参数（可能是名称） */
  target: string;
  /** 解析后的目标名称（执行后可得） */
  targetName?: string;
  fromWorkerId?: string;
  fromWorkerName?: string;
  fromUserId: string;
  depth: number;
  prompt: string;
  status: "queued" | "running" | "done" | "error";
  outputPreview?: string;
  error?: string;
  createdAt: string;
  durationMs?: number;
}
export interface DelegationListResult { delegations: DelegationRecord[] }

/** 委派结果（EAG 侧写入 <id>.res.json，代理轮询读取）。 */
export interface DelegationResult {
  id: string;
  ok: boolean;
  targetWorkerId?: string;
  targetName?: string;
  output?: string;
  error?: string;
  startedAt?: string;
  finishedAt: string;
  durationMs?: number;
}

// -- Knowledge（RAG）--------------------------------------------------------

/** 知识库集合（管理员维护，可挂载到 Worker）。 */
export interface KnowledgeCollection {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  /** 派生字段（列表展示用） */
  docCount: number;
  chunkCount: number;
}

export interface KnowledgeListResult { collections: KnowledgeCollection[] }
export interface KnowledgeUpsertInput { id?: string; name: string; description?: string }
export interface KnowledgeDeleteInput { id: string }

/** 单个文档（摄取后按其分块存储）。 */
export interface KnowledgeDocMeta {
  id: string;
  title: string;
  /** 来源路径 / URL（可追溯） */
  source?: string;
  chunks: number;
  createdAt: string;
}
export interface KnowledgeDetailResult {
  collection: KnowledgeCollection;
  docs: KnowledgeDocMeta[];
}
export interface KnowledgeDocDeleteInput { collectionId: string; docId: string }

/** 摄取：文本直贴，或从本地文件读取（二选一）。 */
export interface KnowledgeIngestInput {
  collectionId: string;
  title?: string;
  text?: string;
  path?: string;
}
export interface KnowledgeIngestResult {
  ok: boolean;
  docId?: string;
  chunks?: number;
  error?: string;
}

export interface KnowledgeSearchInput {
  /** 缺省 = 在所有知识库中检索 */
  collectionId?: string;
  query: string;
  topK?: number;
}
export interface KnowledgeHit {
  collectionId: string;
  collectionName: string;
  docTitle: string;
  text: string;
  score: number;
}
export interface KnowledgeSearchResult { hits: KnowledgeHit[]; error?: string }

// -- Workspace Chat ---------------------------------------------------------
/**
 * 用户上传的附件（多模态入口）。
 * 走 base64 传输，由主进程落盘到受治理的工作区目录，并把路径注入 prompt
 * —— 引擎用自带 Read 工具即可查看（不内联进 prompt，避免撑爆上下文）。
 */
export interface ChatAttachment {
  name: string;
  mime: string;
  /** base64（不含 data: 前缀） */
  dataBase64: string;
}

export interface WorkspaceChatSendInput {
  workerId: string;
  text: string;
  /** 附件（图片/文本），可选 */
  attachments?: ChatAttachment[];
  /**
   * 计划模式：只分析并输出执行计划，不允许改动文件。
   * 引擎侧落实（claude: --permission-mode plan / codex: read-only 沙箱），
   * 不依赖模型自觉 —— 治理平台不能只靠提示词约束。
   */
  planOnly?: boolean;
  /** Runtime model override — used when user switches model in the chat UI. */
  modelProviderId?: string;
  modelName?: string;
}

/** 中止当前这一轮对话（用户侧"停止生成"）。 */
export interface WorkspaceChatAbortInput { workerId: string }

/** Resolved model reference used to drive agent worker subprocesses. */
export interface ResolvedModelRef {
  providerId: string;
  providerName: string;
  modelName: string;
  baseUrl: string;
  /** Provider 协议类型，供 adapter 决定凭证注入方式。 */
  providerType: ProviderType;
  apiKey?: string;
}

/**
 * Unified agent event stream — every adapter (claude-code / codex / pi / ...)
 * normalizes its native output into these events. Consumed by WorkChat
 * (rendering) and audit logging in the main process.
 */
export type AgentEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_start"; toolName: string; input?: unknown }
  | { type: "tool_end"; toolName: string; input?: unknown; isError?: boolean; content?: string }
  | { type: "cost"; totalCostUsd?: number; usage?: unknown }
  | { type: "agent_end"; sessionId?: string; success?: boolean }
  | { type: "error"; message: string };

/** @deprecated Use AgentEvent */
export type WorkspaceChatStreamEvent = AgentEvent;

/** Result of a one-shot chat send (browser HTTP mode returns full reply). */
export interface WorkspaceChatSendResult {
  reply?: string;
  error?: string;
}

// -- Agent Adapters ---------------------------------------------------------
/** Declares which governance hooks an agent engine supports. */
export interface AdapterCapabilities {
  /** Tool-call interception before execution (hooks / execpolicy). */
  toolLevelApproval: boolean;
  /** Structured streaming output (stream-json / --json). */
  streamEvents: boolean;
  /** Sandboxing & file-permission control from the platform side. */
  sandboxControl: boolean;
  /** Native egress allowlist support. */
  egressControl: boolean;
  /** Cost / token usage reporting. */
  costReporting: boolean;
  /** Session resume across messages. */
  sessionResume: boolean;
}

/** Adapter info + live install status, for the admin UI. */
export interface AdapterStatus {
  kind: AgentKind;
  displayName: string;
  capabilities: AdapterCapabilities;
  installed: boolean;
  version?: string;
}
export interface AdapterListResult { adapters: AdapterStatus[] }
