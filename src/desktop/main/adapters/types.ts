// ---------------------------------------------------------------------------
// EAG — Agent Adapter contract
//
// Every embedded agent engine (claude-code / codex / pi / qwenpaw / openclaw)
// implements this interface. The governance layer talks ONLY to this contract:
// adapters never make governance decisions, they are channels — they build
// governed spawn args, normalize native output into AgentEvent, and inject
// credentials via environment variables.
// ---------------------------------------------------------------------------

import type { AgentEvent, AgentKind, AdapterCapabilities, ResolvedModelRef, Worker } from "../../shared/types.ts";

export interface AgentSessionOptions {
  /** Resolved model reference (from Models page provider config). */
  modelOverride?: ResolvedModelRef;
  /** Working directory for the agent subprocess (defaults to PROJECT_ROOT). */
  cwd?: string;
  /** 计划模式：引擎以只读方式运行（claude: --permission-mode plan；codex: read-only 沙箱）。 */
  planOnly?: boolean;
  /**
   * 委派深度：0/缺省 = 用户直接会话；n = 作为第 n 层子 Agent 运行。
   * 传给 MCP 代理（env EAG_MCP_DELEGATION_DEPTH），代理在委派请求里带上它，
   * EAG 侧据此限制链路长度（防无限递归），执行时再 +1 传给下一层。
   */
  delegationDepth?: number;
  /**
   * 实际操作者（后台任务 / 委派 / 定时任务用）。
   * 注入层的 EAG_MCP_USER_ID 取它 —— 代理侧的审计、知识库范围、委派可见性
   * 都应以"发起这次运行的人"为准，而不是进程内的全局会话用户。
   */
  operatorId?: string;
}

export interface AgentSession {
  /**
   * Send one user message and yield the normalized event stream.
   * Implementations spawn (or resume) the CLI subprocess per send.
   */
  send(text: string): AsyncIterableIterator<AgentEvent>;
  /** Abort the in-flight send (kills the subprocess). */
  stop(): Promise<void>;
  /** Release resources; safe to call multiple times. */
  dispose(): Promise<void>;
  /** Native CLI session id for resume, once the first send completes. */
  getSessionId(): string | undefined;
}

export interface AgentAdapter {
  readonly kind: AgentKind;
  readonly displayName: string;
  readonly capabilities: AdapterCapabilities;
  /** Check whether the CLI is installed and usable on this machine. */
  detect(): Promise<{ installed: boolean; version?: string }>;
  /** Start a governed session for a worker. */
  startSession(worker: Worker, opts: AgentSessionOptions): Promise<AgentSession>;
}
