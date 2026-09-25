import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import {
  IPC_CHANNELS,
  PRIVILEGED_IPC_CHANNELS,
  WORKSPACE_CHAT_EVENT,
  SWARM_EVENT,
  TASK_EVENT,
  APPROVAL_EVENT,
  type IpcChannel,
} from "../shared/ipc-channels.ts";
import * as taskManager from "./services/task-manager.ts";
import * as approvalService from "./services/approval-service.ts";
import { WHITELISTED_ENDPOINTS } from "../../extension/egress.ts";
import * as policyApi from "./services/policy-api.ts";
import * as auditApi from "./services/audit-api.ts";
import * as fileApi from "./services/file-api.ts";
import * as terminalApi from "./services/terminal-api.ts";
import * as executionBus from "./services/execution-bus.ts";
import * as swarmApi from "./services/swarm-api.ts";
import * as piApi from "./services/pi-api.ts";
import * as configApi from "./services/config-api.ts";
import * as workerService from "./services/worker-service.ts";
import * as governanceSummary from "./services/governance-summary.ts";
import * as userService from "./services/user-service.ts";
import * as groupService from "./services/group-service.ts";
import * as mcpService from "./services/mcp-service.ts";
import * as knowledgeService from "./services/knowledge-service.ts";
import * as schedulerService from "./services/scheduler-service.ts";
import * as notificationService from "./services/notification-service.ts";
import * as delegationService from "./services/delegation-service.ts";
import * as providerHealthService from "./services/provider-health.ts";
import type * as T from "../shared/types.ts";

const START_TIME = Date.now();

/** Swarm 历史上限：避免内存无限增长（原先只限制返回值，不限制数组本身）。 */
const SWARM_HISTORY_LIMIT = 50;
const swarmHistory: T.SwarmHistoryEntry[] = [];

// ---------------------------------------------------------------------------
// 鉴权
// ---------------------------------------------------------------------------

/**
 * 特权操作守卫。
 *
 * 渲染进程不可信，任何会改变治理策略 / 配置 / 用户 / 进程状态的操作都必须
 * 在此校验调用者角色。当前会话实现仍是内存态 mock（恒为 admin），一旦接入
 * 真实身份体系（SSO / RBAC），这里的判定即刻生效。
 */
function assertAllowed(channel: IpcChannel): void {
  if (!PRIVILEGED_IPC_CHANNELS.has(channel)) return;
  const session = userService.getSession();
  // admin 或获授后台权限（canManageConsole）者均可执行管理操作
  if (session.role !== "admin" && !session.canManageConsole) {
    throw new Error(`权限不足：操作 "${channel}" 需要管理员角色（当前角色：${session.role}）`);
  }
}

type Handler<T> = (event: IpcMainInvokeEvent, ...args: any[]) => Promise<T> | T;

/** 注册带鉴权与错误归一化的 IPC handler。 */
function handle<T>(channel: IpcChannel, fn: Handler<T>): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    assertAllowed(channel);
    return fn(event, ...args) as Promise<T>;
  });
}

export function registerAllHandlers(): void {
  // 后台任务状态广播到所有窗口
  taskManager.setTaskEventSink((task) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(TASK_EVENT, task);
    }
  });

  // 审批请求/决策广播；扫描器持续消费 Agent 侧写入的请求文件
  approvalService.setApprovalSink((rec) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(APPROVAL_EVENT, rec);
    }
  });
  setInterval(() => approvalService.scanApprovals(), 1500);

  // -- Workspace (user side) --
  handle(IPC_CHANNELS.WORKSPACE_LIST, async () => {
    const session = userService.getSession();
    return { workers: workerService.listWorkersForUser(session.userId) };
  });

  handle(IPC_CHANNELS.WORKSPACE_CHAT_SEND, async (event, input: T.WorkspaceChatSendInput) => {
    const send = (data: unknown) => {
      if (!event.sender.isDestroyed()) event.sender.send(WORKSPACE_CHAT_EVENT, data);
    };
    try {
      await workerService.sendToWorker(input.workerId, input.text, {
        modelProviderId: input.modelProviderId,
        modelName: input.modelName,
      }, send as (ev: T.AgentEvent) => void, undefined, input.attachments, input.planOnly);
    } catch (err: any) {
      send({ type: "error", message: err?.message ?? String(err) });
    }
    return { success: true };
  });

  // 用户侧"停止生成"：终止当前这一轮的 Agent 子进程
  handle(IPC_CHANNELS.WORKSPACE_CHAT_ABORT, async (_e, i: T.WorkspaceChatAbortInput) =>
    workerService.abortChat(i.workerId),
  );

  // -- Worker management --
  handle(IPC_CHANNELS.WORKER_LIST, async () => ({ workers: workerService.listWorkers() }));
  handle(IPC_CHANNELS.WORKER_CREATE, async (_e, i: T.WorkerCreateInput) => workerService.createWorker(i));
  handle(IPC_CHANNELS.WORKER_UPDATE, async (_e, i: T.WorkerUpdateInput) => {
    // 禁止通过 patch 覆盖不可变字段；分配字段必须走 worker:assign
    // （assign 会写审计 —— 绕过它就等于分配变更不可追溯）
    const { id, createdAt, assignedTo, assignedUserIds, assignedGroupIds, ...patch } =
      (i.patch ?? {}) as Partial<T.Worker>;
    return workerService.updateWorker({ id: i.id, patch });
  });
  handle(IPC_CHANNELS.WORKER_DELETE, async (_e, i: { id: string }) => workerService.deleteWorker(i.id));
  handle(IPC_CHANNELS.WORKER_ARCHIVE, async (_e, i: T.WorkerArchiveInput) => workerService.archiveWorker(i));
  handle(IPC_CHANNELS.WORKER_CLONE, async (_e, i: T.WorkerCloneInput) => workerService.cloneWorker(i));
  handle(IPC_CHANNELS.WORKER_ROLLBACK_CONFIG, async (_e, i: T.WorkerRollbackInput) => workerService.rollbackWorkerConfig(i));
  handle(IPC_CHANNELS.WORKER_START, async (_e, i: { id: string }) => workerService.startWorker(i.id));
  handle(IPC_CHANNELS.WORKER_STATUS, async (_e, i: { id: string }) => workerService.getWorkerStatus(i.id));
  handle(IPC_CHANNELS.WORKER_ASSIGN, async (_e, i: T.WorkerAssignInput) => workerService.assignWorker(i));

  // -- 配置体检（Provider 连通性 + Agent 可运行性） --
  handle(IPC_CHANNELS.PROVIDER_HEALTH, async (): Promise<T.ProviderHealthResult> => providerHealthService.healthCheck());

  // -- 子 Agent 委派（记录视图） --
  handle(IPC_CHANNELS.DELEGATION_LIST, async (): Promise<T.DelegationListResult> => ({ delegations: delegationService.list() }));

  // -- 通知（无人值守结果：站内 + Webhook 外推） --
  handle(IPC_CHANNELS.NOTIFY_LIST, async (): Promise<T.NotificationListResult> => notificationService.list());
  handle(IPC_CHANNELS.NOTIFY_READ, async (_e, i: T.NotificationReadInput) => notificationService.markRead(i?.ids));
  handle(IPC_CHANNELS.NOTIFY_CLEAR, async () => notificationService.clear());
  handle(IPC_CHANNELS.NOTIFY_TEST, async (): Promise<T.NotificationTestResult> => notificationService.test());

  // -- 定时任务（无人值守 Agent；执行走同一治理通道） --
  handle(IPC_CHANNELS.SCHEDULE_LIST, async (): Promise<T.SchedulerListResult> => ({ jobs: schedulerService.listJobs() }));
  handle(IPC_CHANNELS.SCHEDULE_UPSERT, async (_e, i: T.ScheduledJobUpsertInput) => schedulerService.upsertJob(i));
  handle(IPC_CHANNELS.SCHEDULE_DELETE, async (_e, i: T.ScheduledJobDeleteInput) => schedulerService.deleteJob(i.id));
  handle(IPC_CHANNELS.SCHEDULE_RUN, async (_e, i: T.ScheduledJobDeleteInput) =>
    schedulerService.runJob(i.id, "manual"));

  // -- Knowledge（RAG；向量化走 API，检索写审计） --
  handle(IPC_CHANNELS.KNOWLEDGE_LIST, async (): Promise<T.KnowledgeListResult> => ({ collections: knowledgeService.listCollections() }));
  handle(IPC_CHANNELS.KNOWLEDGE_UPSERT, async (_e, i: T.KnowledgeUpsertInput) => knowledgeService.upsertCollection(i));
  handle(IPC_CHANNELS.KNOWLEDGE_DELETE, async (_e, i: T.KnowledgeDeleteInput) => knowledgeService.deleteCollection(i.id));
  handle(IPC_CHANNELS.KNOWLEDGE_DETAIL, async (_e, i: T.KnowledgeDeleteInput) => knowledgeService.getDetail(i.id));
  handle(IPC_CHANNELS.KNOWLEDGE_DOC_DELETE, async (_e, i: T.KnowledgeDocDeleteInput) =>
    knowledgeService.deleteDoc(i.collectionId, i.docId));
  handle(IPC_CHANNELS.KNOWLEDGE_INGEST, async (_e, i: T.KnowledgeIngestInput) =>
    knowledgeService.ingest(i, userService.getSession().userId || "console"));
  handle(IPC_CHANNELS.KNOWLEDGE_SEARCH, async (_e, i: T.KnowledgeSearchInput) =>
    knowledgeService.search(i, userService.getSession().userId || "console"));

  // -- MCP（外部工具；调用过策略 + 审计） --
  handle(IPC_CHANNELS.MCP_LIST, async (): Promise<T.McpListResult> => ({ servers: mcpService.listServers() }));
  handle(IPC_CHANNELS.MCP_UPSERT, async (_e, i: T.McpUpsertInput) => mcpService.upsertServer(i));
  handle(IPC_CHANNELS.MCP_DELETE, async (_e, i: T.McpDeleteInput) => mcpService.deleteServer(i.id));
  handle(IPC_CHANNELS.MCP_STOP, async (_e, i: T.McpDeleteInput) => {
    mcpService.stopServer(i.id);
    return true;
  });
  handle(IPC_CHANNELS.MCP_TOOLS, async (_e, i: T.McpToolsInput) => mcpService.listTools(i.id));
  handle(IPC_CHANNELS.MCP_CALL, async (_e, i: T.McpCallInput) =>
    mcpService.callTool(i, userService.getSession().userId || "console"));

  // -- Agent adapters --
  handle(IPC_CHANNELS.ADAPTERS_LIST, async (): Promise<T.AdapterListResult> => {
    const { listAdapterStatus } = await import("./adapters/registry.ts");
    return { adapters: await listAdapterStatus() };
  });

  // -- User management --
  handle(IPC_CHANNELS.USER_LIST, async () => ({ users: userService.listUsers() }));
  handle(IPC_CHANNELS.USER_CREATE, async (_e, i: T.UserCreateInput) => userService.createUser(i));
  handle(IPC_CHANNELS.USER_UPDATE, async (_e, i: T.UserUpdateInput) => userService.updateUser(i));
  handle(IPC_CHANNELS.USER_DELETE, async (_e, i: T.UserDeleteInput) => {
    const ok = userService.deleteUser(i.id);
    if (ok) {
      // 清理悬挂引用：从用户组与所有 Worker 分配中移除
      groupService.removeMemberFromAllGroups(i.id);
      workerService.removeUserFromAssignments(i.id);
    }
    return ok;
  });
  // 吊销某用户的全部登录会话（强制重新登录；不改密码）
  handle(IPC_CHANNELS.USER_REVOKE_TOKENS, async (_e, i: T.UserRevokeTokensInput) =>
    userService.revokeUserTokens(i.id));

  // -- User groups --
  handle(IPC_CHANNELS.GROUP_LIST, async (): Promise<T.GroupListResult> => ({ groups: groupService.listGroups() }));
  handle(IPC_CHANNELS.GROUP_UPSERT, async (_e, i: T.GroupUpsertInput) => groupService.upsertGroup(i));
  handle(IPC_CHANNELS.GROUP_DELETE, async (_e, i: T.GroupDeleteInput) => {
    const ok = groupService.deleteGroup(i.id);
    // 清理悬挂引用：把该组从所有 Worker 的可见组里移除
    if (ok) workerService.removeGroupFromAssignments(i.id);
    return ok;
  });

  // -- Auth --
  handle(IPC_CHANNELS.AUTH_LOGIN, async (_e, i: T.AuthLoginInput) => userService.login(i));
  handle(IPC_CHANNELS.AUTH_LOGOUT, async () => {
    userService.logout();
    return true;
  });
  handle(IPC_CHANNELS.AUTH_CHANGE_PASSWORD, async (_e, i: T.ChangePasswordInput) =>
    userService.changePassword(userService.getSession().userId, i.oldPassword, i.newPassword));
  handle(IPC_CHANNELS.AUTH_SESSION, async () => userService.getSession());
  // 认证事件历史（登录/登出/吊销/改密，源自审计日志）—— 仅管理员（特权 channel）
  handle(IPC_CHANNELS.AUTH_LOGIN_HISTORY, async (_e, i?: T.LoginHistoryInput) =>
    auditApi.listLoginHistory(i));

  // -- Policy --
  handle(IPC_CHANNELS.POLICY_GET, async () => ({ policies: policyApi.getPolicy() }));
  handle(IPC_CHANNELS.POLICY_UPDATE, async (_e, i: T.PolicyUpdateInput) => {
    policyApi.updatePolicy(i.policies);
  });
  handle(IPC_CHANNELS.POLICY_CHECK, async (_e, i: T.PolicyCheckInput) => policyApi.checkPath(i.path));
  handle(IPC_CHANNELS.POLICY_EFFECTIVE, async (_e, i: T.PolicyEffectiveInput) => ({
    policies: policyApi.getEffectivePoliciesForWorker(i.workerId),
  }));

  // -- Audit --
  // 数据可见性按角色收口：管理员查全部；非管理员只返回"自己作为操作者"的条目
  // （工作区的治理概览仍可用，但看不到他人活动）。
  handle(IPC_CHANNELS.AUDIT_LIST, async (_e, i?: T.AuditListInput) => {
    const result = auditApi.listAuditEntries(i);
    const session = userService.getSession();
    if (session.role === "admin") return result;
    const entries = (result.entries as Array<{ userId?: string }>).filter(
      (e) => e.userId === session.userId,
    );
    return { ...result, entries };
  });

  // 审计完整性校验：证明审计日志未被篡改（哈希链）—— 仅管理员
  handle(IPC_CHANNELS.AUDIT_VERIFY, async (_e, i?: { date?: string }) =>
    auditApi.verifyAuditIntegrity(i?.date ?? new Date().toISOString().slice(0, 10)),
  );

  // -- 审批（决策为特权操作，见 PRIVILEGED_IPC_CHANNELS）--
  handle(IPC_CHANNELS.APPROVAL_LIST, async () => ({ approvals: approvalService.listApprovals() }));
  handle(IPC_CHANNELS.APPROVAL_DECIDE, async (_e, i: T.ApprovalDecideInput) =>
    approvalService.decideApproval(i.id, i.approved));

  // 会话内文件 diff：读取审计日志中的改前快照与磁盘当前内容
  handle(IPC_CHANNELS.FILE_DIFF, async (_e, i: T.FileDiffInput) => auditApi.getFileDiff(i));

  // 检查点：文件快照链与回滚
  handle(IPC_CHANNELS.FILE_SNAPSHOTS, async (_e, i: T.FileSnapshotsInput) => auditApi.listFileSnapshots(i));
  handle(IPC_CHANNELS.FILE_RESTORE, async (_e, i: T.FileRestoreInput) => auditApi.restoreFromSnapshot(i));

  // 受治理的文件工作区：读写均过策略引擎并落审计
  handle(IPC_CHANNELS.FILE_LIST, async (_e, i: T.FileListInput) => fileApi.listDir(i?.path));
  handle(IPC_CHANNELS.FILE_READ, async (_e, i: T.FileReadInput) => fileApi.readFile(i.path));
  handle(IPC_CHANNELS.FILE_WRITE, async (_e, i: T.FileWriteInput) => fileApi.writeFile(i.path, i.content));

  // 受治理的终端：命令过策略 + 全量审计
  handle(IPC_CHANNELS.TERMINAL_START, async (_e, i: T.TerminalStartInput) =>
    terminalApi.startTerminal(i.sessionId, i.cwd));
  handle(IPC_CHANNELS.TERMINAL_WRITE, async (_e, i: T.TerminalWriteInput) =>
    terminalApi.writeTerminal(i.sessionId, i.command));
  handle(IPC_CHANNELS.TERMINAL_STOP, async (_e, i: T.TerminalStopInput) =>
    terminalApi.stopTerminal(i.sessionId));
  handle(IPC_CHANNELS.TERMINAL_STATUS, async (_e, i: T.TerminalStartInput) =>
    terminalApi.statusOf(i.sessionId));
  handle(IPC_CHANNELS.TERMINAL_CLEAR, async (_e, i: T.TerminalStartInput) => {
    terminalApi.clearTerminal(i.sessionId);
  });

  // 统一执行历史：Agent 与用户终端的命令在同一列表中
  handle(IPC_CHANNELS.EXECUTION_LIST, async (_e, i?: T.ExecutionListInput) => executionBus.list(i));

  // -- 后台任务 --
  handle(IPC_CHANNELS.TASK_SUBMIT, async (_e, i: T.TaskSubmitInput) => taskManager.submitTask(i));
  handle(IPC_CHANNELS.TASK_LIST, async (_e, i?: T.TaskListInput) => ({ tasks: taskManager.listTasks(i) }));
  handle(IPC_CHANNELS.TASK_CANCEL, async (_e, i: T.TaskCancelInput) => taskManager.cancelTask(i.id));

  // -- Egress --
  handle(IPC_CHANNELS.EGRESS_WHITELIST, async () => ({ endpoints: WHITELISTED_ENDPOINTS }));

  // -- Config / Providers --
  // 渲染进程只拿掩码视图（凭证隔离）：apiKey 明文不出主进程
  handle(IPC_CHANNELS.CONFIG_GET, async () => configApi.getPublicConfig());
  handle(IPC_CHANNELS.CONFIG_UPDATE, async (_e, i: Partial<T.AppConfig>) => {
    configApi.updateConfig(i);
  });
  handle(IPC_CHANNELS.PROVIDER_TEST, async (_e, i: T.ModelProviderTestInput) => configApi.testProvider(i));

  // -- Pi process --
  // pi:exec 未暴露给渲染进程（见 BLOCKED_FROM_RENDERER）；此处仅保留 start/stop/status。
  handle(IPC_CHANNELS.PI_START, async (_e, i?: T.PiStartInput) => piApi.startPi(i?.args));
  handle(IPC_CHANNELS.PI_STOP, async () => piApi.stopPi());
  handle(IPC_CHANNELS.PI_STATUS, async () => piApi.getPiStatus());

  // -- Swarm --
  handle(IPC_CHANNELS.SWARM_EXECUTE, async (event, i: T.SwarmExecuteInput) => {
    // 执行进度实时推送给发起方（批次/任务粒度），避免 UI 只能盯着一个转圈
    const send = (data: unknown) => {
      if (!event.sender.isDestroyed()) event.sender.send(SWARM_EVENT, data);
    };
    const r = await swarmApi.swarmExecute(i.request, i.config, send as (e: T.SwarmProgressEvent) => void);
    swarmHistory.unshift({
      id: crypto.randomUUID(),
      prompt: i.request.prompt,
      result: r,
      createdAt: new Date().toISOString(),
    });
    if (swarmHistory.length > SWARM_HISTORY_LIMIT) swarmHistory.length = SWARM_HISTORY_LIMIT;
    return r;
  });
  handle(IPC_CHANNELS.SWARM_HISTORY, async () => swarmHistory.slice(0, SWARM_HISTORY_LIMIT));

  // -- Legacy status (deprecated, kept for TopBar) --
  handle(IPC_CHANNELS.STATUS_GET, async () => {
    const piStatus = piApi.getPiStatus();
    const policies = policyApi.getPolicy();
    const auditToday = auditApi.listAuditEntries({ limit: 0 });
    return {
      piRunning: piStatus.running, piPid: piStatus.pid,
      userId: userService.getSession().userId,
      policyEntryCount: policies.length,
      auditTodayCount: auditToday.entries.length,
      uptime: Math.floor((Date.now() - START_TIME) / 1000),
    };
  });

  // -- 治理总览：聚合沙箱/出网/护栏/预算/审计完整性（只读快照）--
  handle(IPC_CHANNELS.GOVERNANCE_SUMMARY, async () => governanceSummary.getGovernanceSummary());
}
