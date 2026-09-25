import { useParams, useNavigate } from "react-router-dom";
import { useState, useMemo, useRef, useEffect, useCallback, type ReactNode } from "react";
import * as ipc from "../lib/ipc.ts";
import FileBrowser from "../components/FileBrowser.tsx";
import AgentStatusBar from "../components/AgentStatusBar.tsx";
import Terminal from "../components/Terminal.tsx";
import Markdown from "../components/Markdown.tsx";
import { ConfirmModal } from "../components/Modal.tsx";
import Dropdown, { MenuItem, MenuDivider } from "../components/Dropdown.tsx";
import { useToast } from "../components/Toast.tsx";
import { useTaskStore } from "../stores/taskStore.ts";
import { useUserStore } from "../stores/userStore.ts";
import { markAgentsSeen } from "../lib/seen.ts";
import {
  IconChat, IconTerminal, IconFolder, IconDiff, IconGauge, IconInfo,
  IconArrowLeft, IconPlus, IconSparkle, IconCopy, IconCheck,
  IconSend, IconStop, IconTrash, IconEdit, IconMore, IconChevronDown, IconX,
  IconFile, IconChevronRight, IconRefresh, IconPaperclip, IconPlay,
  type IconProps,
} from "../components/icons.tsx";
import type { AgentEvent, FileDiffResult, FileListResult, FileSnapshot, ModelProvider, Worker, ChatAttachment } from "@shared/types.ts";
import { getModelChoice, saveModelChoice, type ModelChoice } from "../lib/modelChoice.ts";
import {
  ensureSession, loadMessages, saveMessages, deriveTitle, listSessions,
  renameSession, deleteSession, createSession,
  markSessionUnread, markSessionRead,
  type ChatMessage, type ChatSession, type ToolCard,
} from "../lib/sessions.ts";

/**
 * 用户侧工作区。
 *
 * 结构参照主流 Agent 平台（QwenPaw / OpenHands）：对话只是工作区中的一个
 * 面板，与文件、变更、用量、信息平级。
 *
 * 会话模型：一个 Worker 下可以有多个会话，路由为
 *   /app/chat/:workerId/:sessionId
 * 不带 sessionId 时自动解析到最近的会话（必要时新建）。
 */

/** 消息类型与存储层共用 */
type Msg = ChatMessage;

interface FileChange {
  path: string;
  action: "read" | "write";
  ok?: boolean;
}

interface DiffLine { type: "same" | "add" | "del"; text: string }

const WRITE_TOOLS = new Set([
  "write", "edit", "multi_edit", "notebook_edit", "create", "delete", "move",
]);

const MAX_DIFF_RENDER_LINES = 400;

function extractPath(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const rec = input as Record<string, unknown>;
  for (const key of ["path", "file_path", "notebook_path", "filePath", "target_file"]) {
    const value = rec[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

const MAX_TOOL_DETAIL = 4000;

/** 工具入参 → 可读 JSON（截断），供卡片展开查看。 */
function formatInput(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  try {
    const s = typeof input === "string" ? input : JSON.stringify(input, null, 2);
    return s.length > MAX_TOOL_DETAIL ? `${s.slice(0, MAX_TOOL_DETAIL)}\n…（已截断）` : s;
  } catch {
    return String(input);
  }
}

function summarizeInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const rec = input as Record<string, unknown>;
  const candidate =
    (typeof rec.pattern === "string" && rec.pattern) ||
    (typeof rec.command === "string" && rec.command) ||
    (typeof rec.query === "string" && rec.query) ||
    // 委派类工具：一行里显示"目标 Agent"最有信息量
    (typeof rec.target === "string" && rec.target) ||
    undefined;
  return candidate ? String(candidate).slice(0, 80) : undefined;
}

// ---------------------------------------------------------------------------
// 子 Agent 委派卡片
//
// agents__delegate 的工具调用如果按普通工具卡片渲染，语义是丢的：
// Agent 名和任务藏在 JSON 里，子 Agent 的结果也容易被当成一条普通工具输出略过。
// 这里识别出来单独渲染：谁把什么活交给了谁、现在到哪一步、返回了什么。
// ---------------------------------------------------------------------------

/**
 * 委派类工具识别。不同引擎给 MCP 工具加的前缀不同
 * （claude: `mcp__eag-governed__agents__delegate`；codex: 类似 `eag.agents__delegate`），
 * 因此按**后缀**判断。
 */
function delegationKind(name: string): "delegate" | "status" | null {
  const n = name.toLowerCase();
  if (n.endsWith("agents__delegate")) return "delegate";
  if (n.endsWith("agents__delegate_status")) return "status";
  return null;
}

/** 从入参 JSON（卡片 detail 存的就是它）里取委派字段；截断导致解析失败时返回空。 */
function parseDelegationInput(detail?: string): { target?: string; prompt?: string; id?: string } {
  if (!detail) return {};
  try {
    const o = JSON.parse(detail) as Record<string, unknown>;
    return {
      target: typeof o?.target === "string" ? o.target : undefined,
      prompt: typeof o?.prompt === "string" ? o.prompt : undefined,
      id: typeof o?.id === "string" ? o.id : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * 委派返回文本 → 状态。文本前缀由 EAG 代理稳定产出
 * （✅ 完成 / ⏳ 仍在执行 / ❌ 失败），比 isError 更准确 ——
 * 委派失败是"正常的工具返回"，引擎不会标成 error。
 */
function delegationOutcome(result?: string): "ok" | "pending" | "error" | null {
  if (!result) return null;
  if (result.startsWith("✅")) return "ok";
  if (result.startsWith("⏳")) return "pending";
  if (result.startsWith("❌")) return "error";
  return null;
}

const DELEG_UI = {
  running: { dot: "bg-primary animate-pulse", label: "子 Agent 执行中…", cls: "border-primary-border/60 bg-primary-bg/40" },
  pending: { dot: "bg-yellow", label: "仍在后台执行", cls: "border-yellow/30 bg-yellow-bg/50" },
  ok: { dot: "bg-green", label: "完成", cls: "border-n-800 bg-n-900/50" },
  error: { dot: "bg-red", label: "失败", cls: "border-red/30 bg-red-bg" },
} as const;

function DelegationCard({ tool }: { tool: ToolCard }) {
  const kind = delegationKind(tool.name)!;
  const [open, setOpen] = useState(false);
  const input = useMemo(() => parseDelegationInput(tool.detail), [tool.detail]);
  const outcome = delegationOutcome(tool.result);
  const state: keyof typeof DELEG_UI =
    outcome ?? (tool.status === "running" ? "running" : tool.status === "error" ? "error" : "ok");
  const ui = DELEG_UI[state];

  const label = kind === "status" ? "委派查询" : "子 Agent 委派";
  const target = input.target ?? (kind === "status" ? input.id : undefined) ?? tool.target;

  return (
    <div className={`rounded-lg border text-[11px] ${ui.cls}`}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left cursor-pointer bg-transparent"
      >
        <span className={`shrink-0 w-1.5 h-1.5 rounded-full ${ui.dot}`} />
        <span className="shrink-0 px-1.5 py-0.5 rounded font-medium bg-primary-bg text-primary border border-primary-border/60">
          {label}
        </span>
        <span className="text-fg-muted truncate shrink-0 max-w-[40%]">{target ?? "—"}</span>
        {kind === "delegate" && input.prompt && (
          <span className="text-fg-faint truncate hidden sm:inline">· {input.prompt.slice(0, 60)}</span>
        )}
        <span className="ml-auto shrink-0 text-fg-faint">{ui.label}</span>
        <IconChevronDown
          size={12}
          className={`shrink-0 text-fg-faint transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="border-t border-line/60 px-3 py-2 space-y-2">
          {kind === "delegate" && input.prompt && (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-fg-faint mb-1">委派任务</div>
              <pre className="max-h-40 overflow-auto rounded-md border border-line bg-n-950 p-2 font-mono text-[10.5px] text-fg-subtle whitespace-pre-wrap break-words">
                {input.prompt}
              </pre>
            </div>
          )}
          {tool.result && (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-fg-faint mb-1">
                子 Agent 返回
              </div>
              <pre className="max-h-52 overflow-auto rounded-md border border-line bg-n-950 p-2 font-mono text-[10.5px] text-fg-subtle whitespace-pre-wrap break-words">
                {tool.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;

  if (n * m > 250_000) {
    return [
      ...a.map((text) => ({ type: "del" as const, text })),
      ...b.map((text) => ({ type: "add" as const, text })),
    ];
  }

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "del", text: a[i] });
      i++;
    } else {
      out.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ type: "del", text: a[i++] });
  while (j < m) out.push({ type: "add", text: b[j++] });
  return out;
}

function DiffView({ data }: { data: FileDiffResult }) {
  const lines = useMemo<DiffLine[]>(() => {
    if (data.before === null) {
      return (data.after ?? "").split("\n").map((text) => ({ type: "add" as const, text }));
    }
    if (data.after === null) {
      return (data.before ?? "").split("\n").map((text) => ({ type: "del" as const, text }));
    }
    return diffLines(data.before, data.after);
  }, [data]);

  const added = lines.filter((l) => l.type === "add").length;
  const removed = lines.filter((l) => l.type === "del").length;
  const shown = lines.slice(0, MAX_DIFF_RENDER_LINES);

  return (
    <div className="mt-2 rounded-lg border border-n-800 bg-n-950 max-h-96 overflow-auto">
      <div className="sticky top-0 flex items-center gap-2 px-3 py-1.5 bg-n-900 border-b border-n-800 text-[10px] text-n-500">
        <span className="text-green">+{added}</span>
        <span className="text-red">-{removed}</span>
        {data.changedAt && <span>· {new Date(data.changedAt).toLocaleTimeString()}</span>}
        {data.note && <span className="text-yellow truncate">· {data.note}</span>}
      </div>
      <div className="font-mono text-[11px] leading-relaxed">
        {shown.map((l, k) => (
          <div
            key={k}
            className={`px-3 whitespace-pre-wrap break-all ${
              l.type === "add"
                ? "bg-green-bg text-green"
                : l.type === "del"
                  ? "bg-red-bg text-red"
                  : "text-n-600"
            }`}
          >
            <span className="select-none opacity-70">{l.type === "add" ? "+" : l.type === "del" ? "-" : " "}</span>
            {l.text || " "}
          </div>
        ))}
        {lines.length > shown.length && (
          <div className="px-3 py-1 text-[10px] text-n-600">… 其余 {lines.length - shown.length} 行未显示</div>
        )}
      </div>
    </div>
  );
}

/**
 * 工具调用卡片（参考 QwenPaw 的 ToolCardShell）。
 * 折叠时一行摘要；点击展开查看入参与结果 —— 详情仅在展开时挂载，长会话不付渲染成本。
 */
function ToolCallRow({ tool }: { tool: ToolCard }) {
  const isWrite = WRITE_TOOLS.has(tool.name);
  const [open, setOpen] = useState(false);
  const hasDetail = Boolean(tool.detail || tool.result);

  return (
    <div className={`rounded-lg border text-[11px] ${
      tool.status === "error"
        ? "border-red/30 bg-red-bg"
        : tool.status === "ok"
          ? "border-n-800 bg-n-900/50"
          : "border-n-800 bg-n-900/30"
    }`}>
      <button
        onClick={() => hasDetail && setOpen((v) => !v)}
        className={`w-full flex items-center gap-2 px-3 py-1.5 text-left ${hasDetail ? "cursor-pointer" : "cursor-default"}`}
      >
        <span className={`shrink-0 w-1.5 h-1.5 rounded-full ${
          tool.status === "running" ? "bg-yellow animate-pulse"
            : tool.status === "error" ? "bg-red" : "bg-green"
        }`} />
        <span className={`shrink-0 px-1.5 py-0.5 rounded font-medium ${
          isWrite ? "bg-yellow-bg text-yellow" : "bg-blue-bg text-blue"
        }`}>
          {isWrite ? "写" : "读"}
        </span>
        <span className="font-mono text-n-300 shrink-0">{tool.name}</span>
        {tool.target && <span className="font-mono text-n-500 truncate">{tool.target}</span>}
        <span className="ml-auto shrink-0 text-n-600">
          {tool.status === "running" ? "进行中" : tool.status === "ok" ? "完成" : "失败"}
        </span>
        {hasDetail && (
          <IconChevronDown
            size={12}
            className={`shrink-0 text-fg-faint transition-transform ${open ? "rotate-180" : ""}`}
          />
        )}
      </button>

      {open && (
        <div className="border-t border-line/60 px-3 py-2 space-y-2">
          {tool.detail && (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-fg-faint mb-1">入参</div>
              <pre className="max-h-44 overflow-auto rounded-md border border-line bg-n-950 p-2 font-mono text-[10.5px] text-fg-subtle whitespace-pre-wrap break-all">
                {tool.detail}
              </pre>
            </div>
          )}
          {tool.result && (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-fg-faint mb-1">结果</div>
              <pre className="max-h-44 overflow-auto rounded-md border border-line bg-n-950 p-2 font-mono text-[10.5px] text-fg-subtle whitespace-pre-wrap break-all">
                {tool.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}



type TabKey = "chat" | "terminal" | "files" | "changes" | "usage" | "info";

const TABS: Array<{ key: TabKey; label: string; icon: (p: IconProps) => ReactNode }> = [
  { key: "chat", label: "对话", icon: IconChat },
  { key: "terminal", label: "执行", icon: IconTerminal },
  { key: "files", label: "文件", icon: IconFolder },
  { key: "changes", label: "变更", icon: IconDiff },
  { key: "usage", label: "用量", icon: IconGauge },
  { key: "info", label: "信息", icon: IconInfo },
];

export default function WorkChat() {
  const { workerId, sessionId: routeSessionId } = useParams<{ workerId: string; sessionId?: string }>();
  const nav = useNavigate();

  const [tab, setTab] = useState<TabKey>("chat");
  const [session, setSession] = useState<ChatSession | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  /** 待发送的附件（图片/文本）：发送时随消息提交，服务端落盘并把路径注入 prompt */
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const attachInputRef = useRef<HTMLInputElement>(null);
  /** 计划模式：Agent 只出计划（引擎只读），确认后再执行 */
  const [planMode, setPlanMode] = useState(false);
  // 模型：Provider 池（全局）+ 当前 Agent 实际使用的模型
  // 解析优先级：会话级本地覆盖 → worker.config → 全局默认 Provider
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [activeModel, setActiveModel] = useState<ModelChoice | null>(null);

  const [fileChanges, setFileChanges] = useState<FileChange[]>([]);
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [diffData, setDiffData] = useState<FileDiffResult | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  // 历史版本（检查点）与回滚
  const [snapshots, setSnapshots] = useState<FileSnapshot[]>([]);
  const [restoreTarget, setRestoreTarget] = useState<FileSnapshot | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [worker, setWorker] = useState<Worker | null>(null);
  // 生效策略：让用户看得见自己受什么约束（此前治理对用户是黑盒）
  const [effectivePolicies, setEffectivePolicies] = useState<Array<{ path: string; access: string }>>([]);
  // Worker 运行态：预算消耗 + 记忆摘要（治理透明化）
  const [wsStatus, setWsStatus] = useState<{ spentUsd?: number; budgetLimitUsd?: number; memorySummary?: string } | null>(null);

  // 会话操作（内联重命名 / 删除确认 / 消息复制反馈）
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  const toast = useToast();

  // 消息队列：Agent 运行中仍可继续输入，回车入队，当前回复结束后自动发送（参考 QwenPaw）
  const [queue, setQueue] = useState<Array<{ id: number; text: string }>>([]);
  const queueSeq = useRef(0);
  const dequeuingRef = useRef(false);
  /** ↑/↓ 调历史消息 */
  const historyIdx = useRef(-1);

  // @ 文件引用（参考 QwenPaw 的 @ 路径引用）：输入 @ 弹出工作区文件选择
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [mentionDir, setMentionDir] = useState("");
  const [mentionListing, setMentionListing] = useState<FileListResult | null>(null);

  // 后台任务（参考 QwenPaw 的 background task）：提交后不占用当前对话流
  const tasks = useTaskStore((s) => s.tasks);
  const loadTasks = useTaskStore((s) => s.load);
  const submitTask = useTaskStore((s) => s.submit);
  const cancelTask = useTaskStore((s) => s.cancel);
  const [taskPanelOpen, setTaskPanelOpen] = useState(false);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);

  const workerTasks = useMemo(
    () => tasks.filter((t) => t.workerId === workerId),
    [tasks, workerId],
  );
  const activeTaskCount = workerTasks.filter(
    (t) => t.status === "running" || t.status === "queued",
  ).length;

  const endRef = useRef<HTMLDivElement>(null);
  const pendingToolIdx = useRef<Map<string, number>>(new Map());
  /** 当前活跃会话（供流式回调判断是否该更新界面） */
  const sessionRef = useRef<ChatSession | null>(null);
  /** 用户点击"停止"后置真：忽略引擎被终止时抛出的错误事件 */
  const stoppedRef = useRef(false);
  /** 智能滚动：仅当用户停留在底部时才自动跟随流式输出 */
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  /** 多行输入框自适应高度 */
  const taRef = useRef<HTMLTextAreaElement>(null);

  // 解析会话：未指定 sessionId 时落到最近的会话，并补全 URL。
  // 会话按用户隔离：必须等身份就绪后再解析，否则会落到匿名作用域。
  const sessionUserId = useUserStore((s) => s.session?.userId);
  useEffect(() => {
    if (!workerId || !sessionUserId) return;
    const s = ensureSession(workerId, routeSessionId);
    setSession(s);
    sessionRef.current = s;
    setMessages(loadMessages(s.id));
    setQueue([]); // 消息队列不跨会话
    // 变更面板同样不跨会话残留（此前会显示上一个会话的文件操作）
    setFileChanges([]);
    setExpandedPath(null);
    setDiffData(null);
    setSnapshots([]);
    if (s.id !== routeSessionId) {
      nav(`/app/chat/${workerId}/${s.id}`, { replace: true });
    }
  }, [workerId, routeSessionId, nav, sessionUserId]);

  // 首条用户消息后自动生成会话标题
  useEffect(() => {
    if (!session || session.title !== "新对话") return;
    if (!messages.some((m) => m.role === "user")) return;
    const title = deriveTitle(messages);
    if (title === "新对话") return;
    renameSession(session.id, title);
    setSession((prev) => (prev ? { ...prev, title } : prev));
  }, [messages, session]);

  /** 解析某 Agent 当前应使用的模型：本地覆盖 → Agent 配置 → 全局默认。 */
  const resolveModelChoice = useCallback(async (w: Worker | null): Promise<ModelChoice | null> => {
    if (!w) return null;
    const local = getModelChoice(w.id);
    if (local) return local;
    if (w.config.modelProviderId && w.config.modelName) {
      return { providerId: w.config.modelProviderId, modelName: w.config.modelName };
    }
    const cfg = await ipc.configGet().catch(() => null);
    const p = cfg?.providers.find((pr) => pr.id === cfg.activeProviderId);
    return p ? { providerId: p.id, modelName: p.activeModel } : null;
  }, []);

  useEffect(() => {
    ipc.configGet().then((cfg) => setProviders(cfg.providers ?? [])).catch(() => {});
  }, []);

  // Worker 元信息；找不到时区分"已删除"（会话可能是删除 Agent 前留下的）。
  // 用 workspace:list（按用户过滤）而非 worker:list（全量、仅管理员）——
  // 既符合权限模型，也顺带验证当前用户确实有权访问该 Agent。
  const [workerMissing, setWorkerMissing] = useState(false);
  useEffect(() => {
    if (!workerId) return;
    let alive = true;
    ipc.workspaceList()
      .then(async (r) => {
        if (!alive) return;
        const found = r.workers.find((w) => w.id === workerId) ?? null;
        setWorker(found);
        setWorkerMissing(found === null);
        if (found) markAgentsSeen([found.id]);
        const choice = await resolveModelChoice(found);
        if (alive) setActiveModel(choice);
      })
      .catch(() => { if (alive) setWorker(null); });
    return () => { alive = false; };
  }, [workerId, resolveModelChoice]);

  // 拉取预算消耗 + 记忆摘要（治理透明化）
  useEffect(() => {
    if (!workerId) return;
    let alive = true;
    ipc.workerStatus({ id: workerId })
      .then((s) => { if (alive) setWsStatus(s); })
      .catch(() => { if (alive) setWsStatus(null); });
    return () => { alive = false; };
  }, [workerId]);

  /** 切换当前 Agent 使用的模型（仅本地生效，不写全局配置）。 */
  const chooseModel = (choice: ModelChoice | null) => {
    if (!workerId) return;
    saveModelChoice(workerId, choice);
    if (choice) {
      setActiveModel(choice);
      toast.success(`模型已切换为 ${choice.modelName}`);
    } else {
      void resolveModelChoice(worker).then(setActiveModel);
      toast.info("已恢复 Agent 默认模型");
    }
  };

  useEffect(() => {
    if (!workerId) return;
    ipc
      .policyEffective({ workerId })
      .then((r) => setEffectivePolicies((r.policies ?? []) as Array<{ path: string; access: string }>))
      .catch(() => setEffectivePolicies([]));
  }, [workerId]);

  useEffect(() => {
    if (tab !== "chat" || !stickToBottom.current) return;
    endRef.current?.scrollIntoView({ behavior: "auto" });
  }, [messages, tab]);

  // 输入框随内容增长（上限 180px，超出后内部滚动）
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [input]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const commit = (updater: (prev: Msg[]) => Msg[]) => {
    setMessages((prev) => {
      const next = updater(prev);
      if (session) saveMessages(session.id, next);
      return next;
    });
  };

  const noteFileChange = (path: string, action: "read" | "write") => {
    setFileChanges((prev) => {
      if (prev.some((f) => f.path === path && f.action === action && f.ok === undefined)) return prev;
      return [...prev, { path, action }];
    });
  };

  const settleFileChange = (path: string, ok: boolean) => {
    setFileChanges((prev) => {
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i].path === path && prev[i].ok === undefined) {
          const next = [...prev];
          next[i] = { ...next[i], ok };
          return next;
        }
      }
      return prev;
    });
  };

  const settleLatestPending = (ok: boolean) => {
    setFileChanges((prev) => {
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i].ok === undefined) {
          const next = [...prev];
          next[i] = { ...next[i], ok };
          return next;
        }
      }
      return prev;
    });
  };

  /** 拉取某文件的 diff 与历史版本（检查点）。 */
  const loadFileDetail = useCallback(async (path: string) => {
    if (!workerId) return;
    setDiffLoading(true);
    try {
      const [d, s] = await Promise.all([
        ipc.fileDiff({ workerId, path }),
        ipc.fileSnapshots({ workerId, path }).catch(() => null),
      ]);
      setDiffData(d);
      setSnapshots(s?.snapshots ?? []);
    } catch {
      setDiffData(null);
      setSnapshots([]);
    } finally {
      setDiffLoading(false);
    }
  }, [workerId]);

  const toggleDiff = async (path: string) => {
    if (expandedPath === path) {
      setExpandedPath(null);
      setDiffData(null);
      setSnapshots([]);
      return;
    }
    setExpandedPath(path);
    setDiffData(null);
    setSnapshots([]);
    await loadFileDetail(path);
  };

  /** 恢复到某个历史版本（服务端会在恢复前为当前内容补快照）。 */
  const restoreSnapshot = async () => {
    if (!restoreTarget || !expandedPath || !workerId) return;
    setRestoring(true);
    try {
      const r = await ipc.fileRestore({ workerId, path: expandedPath, timestamp: restoreTarget.timestamp });
      if (r.ok) {
        toast.success("已恢复到该版本");
        setRestoreTarget(null);
        await loadFileDetail(expandedPath);
      } else {
        toast.error(`恢复失败：${r.error ?? "未知错误"}`);
      }
    } catch (e) {
      toast.error(`恢复失败：${e}`);
    } finally {
      setRestoring(false);
    }
  };

  /** 读取用户选择的附件为 base64（服务端落盘后再把路径注入 prompt）。 */
  const pickAttachments = async (files: FileList | null) => {
    const list = Array.from(files ?? []);
    if (list.length === 0) return;
    const next: ChatAttachment[] = [];
    for (const f of list.slice(0, 4)) {
      if (f.size > 8 * 1024 * 1024) {
        toast.error(`${f.name} 超过 8MB，已跳过`);
        continue;
      }
      try {
        const dataBase64 = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => {
            const s = String(r.result ?? "");
            resolve(s.includes(",") ? s.slice(s.indexOf(",") + 1) : s);
          };
          r.onerror = () => reject(r.error);
          r.readAsDataURL(f);
        });
        next.push({ name: f.name, mime: f.type || "application/octet-stream", dataBase64 });
      } catch {
        toast.error(`${f.name} 读取失败`);
      }
    }
    if (next.length > 0) {
      setAttachments((prev) => [...prev, ...next].slice(0, 6));
    }
  };

  /** 真正发送一条消息（手动发送与队列出队共用）。 */
  const sendText = useCallback(async (text: string, atts?: ChatAttachment[], planOnly?: boolean) => {
    if (!workerId) return;
    setSending(true);
    stoppedRef.current = false;
    stickToBottom.current = true;
    pendingToolIdx.current.clear();

    const turnSessionId = session?.id;

    // 用户可能中途切走会话：活跃会话照常渲染；后台会话把增量攒在内存里，
    // 完成时一次性落盘 —— 避免"A 会话的回复串进 B 会话界面"。
    const turnBuf: { messages: Msg[] | null } = { messages: null };
    const commitForTurn = (updater: (prev: Msg[]) => Msg[]) => {
      if (!turnSessionId) return;
      if (sessionRef.current?.id === turnSessionId) {
        commit(updater);
      } else {
        turnBuf.messages = updater(turnBuf.messages ?? loadMessages(turnSessionId));
      }
    };

    commitForTurn((prev) => [...prev, { role: "user", content: text }]);

    let streamed = false;
    /**
     * 事件处理：两种模式共用 ——
     *   · Electron：事件经 IPC（onWorkspaceChatEvent）推送
     *   · Web：事件经 workspaceChatSend 的 NDJSON 流式回调
     * 形态完全一致，因此渲染逻辑只有这一份。
     */
    const handleAgentEvent = (ev: AgentEvent) => {
      streamed = true;

      if (ev.type === "text_delta") {
        commitForTurn((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === "assistant") {
            // 用展开保留 plan 等标记字段（否则流式追加会丢标记）
            return [...prev.slice(0, -1), { ...last, content: last.content + ev.delta }];
          }
          return [...prev, { role: "assistant", content: ev.delta, ...(planOnly ? { plan: true } : {}) }];
        });
        return;
      }

      if (ev.type === "tool_start") {
        const path = extractPath(ev.input);
        const key = `${ev.toolName}::${path ?? summarizeInput(ev.input) ?? ""}`;
        commitForTurn((prev) => {
          const next = [...prev, {
            role: "tool" as const,
            content: `▸ ${ev.toolName}`,
            tool: {
              name: ev.toolName,
              target: path ?? summarizeInput(ev.input),
              status: "running" as const,
              detail: formatInput(ev.input),
            },
          }];
          pendingToolIdx.current.set(key, next.length - 1);
          return next;
        });
        if (path) noteFileChange(path, WRITE_TOOLS.has(ev.toolName) ? "write" : "read");
        return;
      }

      if (ev.type === "tool_end") {
        const path = extractPath(ev.input);
        const key = `${ev.toolName}::${path ?? summarizeInput(ev.input) ?? ""}`;
        const idx = pendingToolIdx.current.get(key);
        if (idx !== undefined) {
          commitForTurn((prev) => {
            const next = [...prev];
            const cur = next[idx];
            if (cur?.tool) {
              next[idx] = {
                ...cur,
                tool: {
                  ...cur.tool,
                  status: ev.isError ? "error" : "ok",
                  result: ev.content
                    ? (ev.content.length > MAX_TOOL_DETAIL
                        ? `${ev.content.slice(0, MAX_TOOL_DETAIL)}\n…（已截断）`
                        : ev.content)
                    : cur.tool.result,
                },
              };
            }
            return next;
          });
          pendingToolIdx.current.delete(key);
        }
        if (path) settleFileChange(path, !ev.isError);
        else settleLatestPending(!ev.isError);
        return;
      }

      if (ev.type === "cost" && ev.totalCostUsd != null) {
        commitForTurn((prev) => [...prev, { role: "tool", content: `$ ${ev.totalCostUsd!.toFixed(4)}`, costUsd: ev.totalCostUsd! }]);
      } else if (ev.type === "error") {
        // 用户主动停止时引擎退出属于预期行为，不作为错误展示
        if (!stoppedRef.current) {
          commitForTurn((prev) => [...prev, { role: "assistant", content: `Error: ${ev.message}` }]);
        }
      }
    };
    const off = ipc.onWorkspaceChatEvent(handleAgentEvent);

    try {
      const res = await ipc.workspaceChatSend({
        workerId, text,
        modelProviderId: activeModel?.providerId,
        modelName: activeModel?.modelName,
        attachments: atts,
        planOnly: planOnly === true,
      }, handleAgentEvent);
      if (!streamed && res.reply) {
        commitForTurn((prev) => [...prev, { role: "assistant", content: res.reply! }]);
      } else if (!streamed && res.error && !stoppedRef.current) {
        commitForTurn((prev) => [...prev, { role: "assistant", content: `Error: ${res.error}` }]);
      }
    } catch (e: any) {
      if (!stoppedRef.current) {
        commitForTurn((prev) => [...prev, { role: "assistant", content: `Error: ${e?.message ?? e}` }]);
      }
    }
    off();
    // 后台会话：把累计内容一次性落盘
    if (turnBuf.messages && turnSessionId) saveMessages(turnSessionId, turnBuf.messages);
    setSending(false);
    // 用户已离开该会话（或窗口不可见）时标记未读；仍在会话内会被 read effect 立即清除
    if (turnSessionId && (!window.location.hash.includes(`/app/chat/${workerId}/${turnSessionId}`) || document.hidden)) {
      markSessionUnread(turnSessionId);
    }
  }, [workerId, activeModel, session]);

  /** 手动发送：Agent 运行中则入队（带附件时必须等当前回复结束）。 */
  const send = useCallback(() => {
    const text = input.trim();
    const atts = attachments;
    if ((!text && atts.length === 0) || !workerId) return;

    if (sending) {
      if (atts.length > 0) {
        toast.info("附件请等当前回复结束后再发送");
        return;
      }
      setInput("");
      setQueue((q) => [...q, { id: ++queueSeq.current, text }]);
      toast.info("已加入队列，当前回复结束后自动发送");
      return;
    }

    setInput("");
    setAttachments([]);
    void sendText(text, atts.length > 0 ? atts : undefined, planMode);
  }, [input, attachments, planMode, sending, workerId, sendText, toast]);

  // 队列自动出队：当前回复结束后发送下一条
  useEffect(() => {
    if (sending || dequeuingRef.current) return;
    const head = queue[0];
    if (!head || !workerId) return;
    dequeuingRef.current = true;
    setQueue((q) => q.slice(1));
    void sendText(head.text).finally(() => { dequeuingRef.current = false; });
  }, [sending, queue, workerId, sendText]);

  // 后台任务：初次加载 + 面板展开且有运行中任务时轮询输出预览
  useEffect(() => {
    if (!workerId) return;
    void loadTasks();
  }, [workerId, loadTasks]);

  useEffect(() => {
    if (!taskPanelOpen || activeTaskCount === 0) return;
    const iv = setInterval(() => { void loadTasks(); }, 3000);
    return () => clearInterval(iv);
  }, [taskPanelOpen, activeTaskCount, loadTasks]);

  /** 后台运行：提交任务后立即返回，不占用当前对话流（Alt+Enter）。 */
  const runInBackground = useCallback(async () => {
    const text = input.trim();
    if (!text || !workerId) return;
    if (sending) {
      toast.info("当前回复进行中，完成后再提交后台任务");
      return;
    }
    try {
      await submitTask(workerId, text);
      setInput("");
      setTaskPanelOpen(true);
      toast.success("已提交后台任务，可继续其他操作");
    } catch (e: any) {
      toast.error(`提交失败：${e?.message ?? e}`);
    }
  }, [input, workerId, sending, submitTask, toast]);

  // 在会话内浏览时清除未读标记（用消息条数而非整个数组，避免流式高频触发）
  const activeSessionId = session?.id;
  useEffect(() => {
    if (activeSessionId) markSessionRead(activeSessionId);
  }, [activeSessionId, messages.length]);

  /** 停止生成：终止当前这一轮的 Agent 子进程（此前只能干等） */
  const stop = useCallback(async () => {
    if (!workerId || !sending) return;
    stoppedRef.current = true;
    try {
      await ipc.workspaceChatAbort({ workerId });
      toast.info("已停止生成");
    } catch (e: any) {
      toast.error(`停止失败：${e?.message ?? e}`);
    } finally {
      setSending(false);
    }
  }, [workerId, sending, toast]);

  /** 清空当前会话的消息（保留会话本身） */
  const handleClear = () => {
    if (!session) return;
    setMessages([]);
    setFileChanges([]);
    setExpandedPath(null);
    setDiffData(null);
    saveMessages(session.id, []);
    toast.info("已清空当前会话消息");
  };

  /** 新建会话并跳转 —— 此前"新建对话"只是跳回首页，点进去还是同一条对话 */
  const newSession = () => {
    if (!workerId) return;
    const s = createSession(workerId);
    nav(`/app/chat/${workerId}/${s.id}`);
  };

  /** 内联重命名（Electron 不支持 window.prompt，此前该功能在桌面端直接报错） */
  const startRename = () => {
    if (!session) return;
    setRenameDraft(session.title);
    setRenaming(true);
  };

  const commitRename = () => {
    if (!session) return;
    const next = renameDraft.trim();
    setRenaming(false);
    if (!next || next === session.title) return;
    renameSession(session.id, next);
    setSession((prev) => (prev ? { ...prev, title: next } : prev));
    toast.success("会话已重命名");
  };

  const removeCurrent = () => {
    if (!session || !workerId) return;
    deleteSession(session.id);
    setConfirmDelete(false);
    const rest = listSessions(workerId);
    const target = rest[0] ?? createSession(workerId);
    nav(`/app/chat/${workerId}/${target.id}`, { replace: true });
    toast.success("会话已删除");
  };

  // ── @ 文件引用 ────────────────────────────────────────────────────────────

  const openMentionDir = useCallback(async (dir: string) => {
    try {
      const r = await ipc.fileList({ path: dir });
      setMentionListing(r);
      setMentionDir(r.root);
    } catch {
      setMentionListing(null);
    }
  }, []);

  /** 检测光标前是否处于 "@查询词" 状态。 */
  const detectMention = useCallback((value: string, caret: number) => {
    const before = value.slice(0, caret);
    const m = /(^|[\s(])@([^\s@]*)$/.exec(before);
    if (m) {
      setMention({ query: m[2], start: before.length - m[2].length });
      void openMentionDir(mentionDir);
    } else {
      setMention(null);
    }
  }, [mentionDir, openMentionDir]);

  /** 选中文件：把 @ 查询词替换为文件路径。 */
  const insertMention = (path: string) => {
    if (!mention) return;
    const el = taRef.current;
    const caret = el?.selectionStart ?? input.length;
    const next = `${input.slice(0, mention.start)}${path} ${input.slice(caret)}`;
    setInput(next);
    setMention(null);
    requestAnimationFrame(() => {
      el?.focus();
      const pos = mention.start + path.length + 1;
      el?.setSelectionRange(pos, pos);
    });
  };

  const mentionEntries = useMemo(() => {
    const entries = mentionListing?.entries ?? [];
    const q = mention?.query?.toLowerCase() ?? "";
    return entries.filter((e) => !q || e.name.toLowerCase().includes(q)).slice(0, 12);
  }, [mentionListing, mention?.query]);

  const copyMessage = (idx: number, text: string) => {
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopiedIdx(idx);
        window.setTimeout(() => setCopiedIdx((v) => (v === idx ? null : v)), 1500);
      })
      .catch(() => toast.error("复制失败"));
  };

    // 用量统计：来自真实的 cost 事件，不做假数据
    const usage = useMemo(() => {
      const total = messages.reduce((sum, m) => sum + (m.costUsd ?? 0), 0);
      const toolCalls = messages.filter((m) => m.role === "tool" && m.tool).length;
      const userTurns = messages.filter((m) => m.role === "user").length;
      const writeCount = fileChanges.filter((f) => f.action === "write").length;
      return { total, toolCalls, userTurns, writeCount, fileCount: fileChanges.length };
    }, [messages, fileChanges]);

    const writeCount = fileChanges.filter((f) => f.action === "write").length;

    // 当前正在做什么：取消息里最近一个仍在运行的工具调用
    const currentAction = useMemo(() => {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === "tool" && m.tool) {
          if (m.tool.status === "running") {
            return m.tool.target
              ? `${m.tool.name} · ${m.tool.target}`
              : m.tool.name;
          }
          break;
        }
      }
      return undefined;
    }, [messages]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 标题栏 */}
      <div className="shrink-0 h-14 px-5 border-b border-line flex items-center gap-3 bg-surface/40">
        <button
          onClick={() => nav("/app")}
          className="flex items-center gap-1.5 text-[11.5px] text-fg-subtle hover:text-fg-muted transition-colors"
        >
          <IconArrowLeft size={14} />
          返回
        </button>
        <div className="h-4 w-px bg-line" />

        {/* 会话标题 + 所属 Agent（标题可点击内联重命名） */}
        <div className="min-w-0 flex flex-col justify-center">
          {renaming ? (
            <input
              autoFocus
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                if (e.key === "Escape") setRenaming(false);
              }}
              className="w-52 h-6 px-1.5 -ml-1.5 rounded-md bg-n-900 border border-primary-border text-[12.5px] text-fg outline-none"
            />
          ) : (
            <button
              onClick={startRename}
              title="点击重命名"
              className="text-[13px] font-medium text-fg truncate leading-tight text-left hover:text-primary transition-colors"
            >
              {session?.title ?? "…"}
            </button>
          )}
          <button
            onClick={() => nav(`/app/agent/${workerId}`)}
            title="查看助手主页（进度 / 文件 / 变更 / 用量）"
            className="text-[10.5px] text-fg-faint truncate leading-tight text-left hover:text-primary transition-colors"
          >
            {worker?.name ?? workerId}
          </button>
        </div>

        {/* 模型：只影响"本 Agent + 我"，不写全局默认（管理员在 Models 页维护 Provider 池，
            在 Worker 表单配置 Agent 默认模型） */}
        {activeModel && (
          <Dropdown
            widthClass="w-72"
            trigger={() => (
              <button
                title="切换本 Agent 使用的模型（仅对你生效，不影响他人与全局默认）"
                className="shrink-0 flex items-center gap-1 text-[10.5px] text-fg-faint font-mono px-1.5 py-0.5 rounded bg-n-900 border border-line hover:border-line-strong hover:text-fg-muted transition-colors"
              >
                {activeModel.modelName}
                <IconChevronDown size={10} />
              </button>
            )}
          >
            {(close) => (
              <>
                <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-faint">
                  本 Agent 使用的模型
                </div>
                <div className="max-h-64 overflow-y-auto">
                  {providers.length === 0 ? (
                    <div className="px-3 py-2 text-[11px] text-fg-faint">
                      暂无可用 Provider（请联系管理员在 Models 页配置）
                    </div>
                  ) : (
                    providers.map((p) =>
                      p.models.map((m) => {
                        const isActive = activeModel.providerId === p.id && activeModel.modelName === m;
                        return (
                          <MenuItem
                            key={`${p.id}/${m}`}
                            active={isActive}
                            label={`${p.name} · ${m}`}
                            hint={isActive ? <IconCheck size={12} className="text-primary" /> : undefined}
                            onClick={() => { chooseModel({ providerId: p.id, modelName: m }); close(); }}
                          />
                        );
                      }),
                    )
                  )}
                </div>
                <MenuDivider />
                <MenuItem
                  icon={<IconRefresh size={13} />}
                  label="恢复 Agent 默认模型"
                  onClick={() => { chooseModel(null); close(); }}
                />
              </>
            )}
          </Dropdown>
        )}

        <div className="flex-1" />

        {/* 会话操作 */}
        <button
          onClick={newSession}
          title="新建对话"
          className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-fg-subtle hover:text-fg-muted hover:bg-n-850/60 transition-colors"
        >
          <IconPlus size={13} />
          新对话
        </button>
        <Dropdown
          widthClass="w-44"
          trigger={() => (
            <button
              title="更多操作"
              className="p-1.5 rounded-md text-fg-subtle hover:text-fg-muted hover:bg-n-850/60 transition-colors"
            >
              <IconMore size={14} />
            </button>
          )}
        >
          {(close) => (
            <>
              <MenuItem
                icon={<IconEdit size={13} />}
                label="重命名"
                onClick={() => { close(); startRename(); }}
              />
              <MenuItem
                icon={<IconSparkle size={13} />}
                label="清空消息"
                onClick={() => { close(); handleClear(); }}
              />
              <MenuDivider />
              <MenuItem
                danger
                icon={<IconTrash size={13} />}
                label="删除会话"
                onClick={() => { close(); setConfirmDelete(true); }}
              />
            </>
          )}
        </Dropdown>
      </div>

      {/* 工作区标签：对话只是其中一个 */}
      <div className="shrink-0 flex items-center gap-0.5 px-4 border-b border-line bg-surface/30">
        {TABS.map((t) => {
          const active = tab === t.key;
          const Icon = t.icon;
          const badge = t.key === "changes" && fileChanges.length ? fileChanges.length : null;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`relative flex items-center gap-1.5 px-3 py-2.5 text-[12px] font-medium transition-colors ${
                active ? "text-fg" : "text-fg-subtle hover:text-fg-muted"
              }`}
            >
              <Icon size={14} className={active ? "text-primary" : "text-fg-faint"} />
              {t.label}
              {badge !== null && (
                <span className="text-[10px] text-fg-faint bg-n-850 border border-line rounded px-1 leading-4">
                  {badge}
                </span>
              )}
              {active && (
                <span className="absolute bottom-0 left-2 right-2 h-[2px] rounded-t-full bg-primary" />
              )}
            </button>
          );
        })}
      </div>

        {/* Agent 状态条：任何 tab 都可见 */}
        <AgentStatusBar
          name={worker?.name ?? workerId ?? "助手"}
          model={activeModel?.modelName ?? worker?.config.modelName}
          running={sending}
          currentAction={currentAction}
          onStop={stop}
          spentUsd={wsStatus?.spentUsd}
          budgetLimitUsd={wsStatus?.budgetLimitUsd}
        />

      {/* 工作区内容 */}
      <div className="flex-1 min-h-0 flex flex-col">
        {tab === "chat" && (
          <>
            <div
              ref={scrollRef}
              onScroll={handleScroll}
              className="flex-1 overflow-y-auto px-5 py-3 space-y-2"
            >
              {messages.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center">
                  <div className="size-11 rounded-2xl bg-n-900 border border-line flex items-center justify-center mb-3">
                    <IconSparkle size={20} className="text-primary" />
                  </div>
                  <p className="text-[13px] font-medium text-fg-muted mb-1">开始对话</p>
                  <p className="text-[11.5px] text-fg-faint">工具调用会显示为卡片，文件改动见「变更」标签</p>
                </div>
              ) : (
                messages.map((m, i) => {
                  if (m.role === "tool") {
                    if (m.tool) {
                      // 委派类工具单独渲染：普通卡片会丢掉"谁把活交给了谁"的语义
                      return delegationKind(m.tool.name)
                        ? <DelegationCard key={i} tool={m.tool} />
                        : <ToolCallRow key={i} tool={m.tool} />;
                    }
                    return (
                      <div key={i} className="text-[11px] font-mono text-n-500 pl-2 border-l border-n-800/60">
                        {m.content}
                      </div>
                    );
                  }
                  if (m.role === "user") {
                    return (
                      <div key={i} className="flex justify-end animate-in">
                        <div className="bg-primary-strong text-white rounded-2xl rounded-br-sm px-3.5 py-2.5 text-[12.5px] leading-relaxed max-w-[75%] whitespace-pre-wrap shadow-[0_1px_3px_rgba(0,0,0,0.35)]">
                          {m.content}
                        </div>
                      </div>
                    );
                  }
                  const streaming = sending && i === messages.length - 1;
                  return (
                    <div key={i} className="group flex gap-2.5 animate-in">
                      <div className="size-6 rounded-lg bg-n-850 border border-line flex items-center justify-center shrink-0 mt-0.5">
                        <IconSparkle size={12} className="text-primary" />
                      </div>
                      <div className="min-w-0 max-w-[85%]">
                        <div className="bg-n-900/70 border border-line rounded-2xl rounded-bl-sm px-3.5 py-2.5">
                          {/* Markdown 渲染：代码块 / 列表 / 表格不再糊成一坨纯文本 */}
                          <Markdown text={m.content} />
                          {streaming && (
                            <span className="inline-block w-1.5 h-3.5 ml-0.5 align-text-bottom bg-primary/80 animate-breathe-soft" />
                          )}
                        </div>
                        {/* 计划模式下产出的计划：确认后一键以正常模式执行 */}
                        {m.plan && !sending && i === messages.length - 1 && (
                          <button
                            onClick={() =>
                              void sendText(`已确认，请按以下计划开始执行：\n\n${m.content}`, undefined, false)
                            }
                            title="以正常模式执行这份计划（可写文件）"
                            className="mt-1 ml-1 flex items-center gap-1 px-2 py-1 rounded-md text-[10.5px] text-primary bg-primary-bg border border-primary-border hover:bg-primary-bg/70 transition-colors"
                          >
                            <IconPlay size={10} />
                            执行该计划
                          </button>
                        )}
                        <button
                          onClick={() => copyMessage(i, m.content)}
                          title="复制这条回复"
                          className="mt-1 ml-1 flex items-center gap-1 text-[10px] text-fg-faint hover:text-fg-muted opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          {copiedIdx === i ? <IconCheck size={11} className="text-green" /> : <IconCopy size={11} />}
                          {copiedIdx === i ? "已复制" : "复制"}
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
              {sending && (
                <div className="flex items-center gap-2 text-n-500 text-xs px-2 py-1">
                  <span className="w-2.5 h-2.5 border-2 border-n-500 border-t-transparent rounded-full animate-spin" />
                  正在处理…
                </div>
              )}
              <div ref={endRef} />
            </div>

            {/* 消息队列：运行中继续输入的内容排队，当前回复结束后自动发送 */}
            {queue.length > 0 && (
              <div className="shrink-0 mx-5 mt-2 rounded-lg border border-line bg-n-900/60 overflow-hidden">
                <div className="max-h-28 overflow-y-auto divide-y divide-line/60">
                  {queue.map((q, i) => (
                    <div key={q.id} className="flex items-center gap-2 px-3 py-1.5 text-[11px]">
                      <span className="shrink-0 text-[9px] font-medium text-fg-faint bg-n-850 border border-line rounded px-1 py-px tabular-nums">
                        {i + 1}
                      </span>
                      <span className="flex-1 truncate text-fg-muted">{q.text}</span>
                      <button
                        onClick={() => setQueue((list) => list.filter((x) => x.id !== q.id))}
                        title="移除"
                        className="shrink-0 p-0.5 rounded text-fg-faint hover:text-red hover:bg-red-bg transition-colors"
                      >
                        <IconX size={11} />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="flex items-center justify-between px-3 py-1 border-t border-line/60">
                  <span className="text-[10px] text-fg-faint">
                    {queue.length} 条待发送 · 当前回复结束后自动发送
                  </span>
                  <button
                    onClick={() => setQueue([])}
                    className="text-[10px] text-fg-faint hover:text-fg-muted transition-colors"
                  >
                    清空
                  </button>
                </div>
              </div>
            )}

            {/* 后台任务面板（参考 QwenPaw 的 background task） */}
            {workerTasks.length > 0 && (
              <div className="shrink-0 mx-5 mt-2 rounded-lg border border-line bg-n-900/60 overflow-hidden">
                <button
                  onClick={() => setTaskPanelOpen((v) => !v)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px]"
                >
                  <span className={`shrink-0 w-1.5 h-1.5 rounded-full ${
                    activeTaskCount > 0 ? "bg-yellow animate-pulse" : "bg-n-600"
                  }`} />
                  <span className="text-fg-muted font-medium">后台任务</span>
                  <span className="text-fg-faint">
                    {activeTaskCount > 0 ? `${activeTaskCount} 个运行中` : `${workerTasks.length} 条记录`}
                  </span>
                  <IconChevronDown
                    size={12}
                    className={`ml-auto text-fg-faint transition-transform ${taskPanelOpen ? "rotate-180" : ""}`}
                  />
                </button>

                {taskPanelOpen && (
                  <div className="border-t border-line/60 max-h-48 overflow-y-auto divide-y divide-line/60">
                    {workerTasks.map((t) => (
                      <div key={t.id}>
                        <div className="flex items-center gap-2 px-3 py-1.5 text-[11px]">
                          <span className={`shrink-0 w-1.5 h-1.5 rounded-full ${
                            t.status === "running" || t.status === "queued"
                              ? "bg-yellow animate-pulse"
                              : t.status === "done"
                                ? "bg-green"
                                : t.status === "cancelled"
                                  ? "bg-n-600"
                                  : "bg-red"
                          }`} />
                          <span className="truncate flex-1 text-fg-muted" title={t.text}>{t.text}</span>
                          <span className="shrink-0 text-fg-faint">
                            {t.status === "running" || t.status === "queued"
                              ? "运行中"
                              : t.status === "done"
                                ? "完成"
                                : t.status === "cancelled"
                                  ? "已取消"
                                  : "失败"}
                          </span>
                          {t.status === "running" || t.status === "queued" ? (
                            <button
                              onClick={() => void cancelTask(t.id)}
                              className="shrink-0 px-1.5 py-0.5 rounded border border-line text-fg-faint hover:text-red hover:border-red/40 transition-colors"
                            >
                              取消
                            </button>
                          ) : (
                            <button
                              onClick={() => setExpandedTaskId(expandedTaskId === t.id ? null : t.id)}
                              className="shrink-0 px-1 rounded text-fg-faint hover:text-fg-muted transition-colors"
                            >
                              {expandedTaskId === t.id ? "收起" : "输出"}
                            </button>
                          )}
                        </div>
                        {expandedTaskId === t.id && (
                          <div className="px-3 pb-2">
                            {t.error && (
                              <div className="mb-1 text-[10.5px] text-red">{t.error}</div>
                            )}
                            <pre className="max-h-36 overflow-auto rounded-md border border-line bg-n-950 p-2 font-mono text-[10.5px] text-fg-subtle whitespace-pre-wrap break-all">
                              {t.outputPreview || "（暂无输出）"}
                            </pre>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="shrink-0 px-5 py-2.5 bg-n-950/80 border-t border-line">
              {/* 待发送的附件预览 */}
              {attachments.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {attachments.map((a, i) => (
                    <span
                      key={`${a.name}-${i}`}
                      className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-n-900 border border-line text-[10.5px] text-fg-muted"
                    >
                      <IconPaperclip size={10} className="text-fg-faint shrink-0" />
                      <span className="max-w-[160px] truncate">{a.name}</span>
                      <button
                        onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                        title="移除"
                        className="text-fg-faint hover:text-red transition-colors"
                      >
                        <IconX size={10} />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <div className="flex gap-2 items-end relative">
                {/* 附件：图片/文本/PDF，落盘到受治理的工作区后把路径给引擎 */}
                <input
                  ref={attachInputRef}
                  type="file"
                  accept="image/*,.txt,.md,.json,.csv,.pdf"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    void pickAttachments(e.target.files);
                    e.target.value = "";
                  }}
                />
                <button
                  onClick={() => attachInputRef.current?.click()}
                  title="添加附件（图片 / 文本 / PDF，单个 ≤ 8MB）"
                  className="shrink-0 p-2 rounded-xl text-fg-subtle hover:text-fg-muted hover:bg-n-850/60 border border-line transition-colors"
                >
                  <IconPaperclip size={14} />
                </button>
                <button
                  onClick={() => setPlanMode((v) => !v)}
                  title="计划模式：Agent 只分析并给出计划、不修改文件（引擎级只读）；确认后可一键执行"
                  className={`shrink-0 px-2.5 py-2 rounded-xl border text-[11px] font-medium transition-colors ${
                    planMode
                      ? "bg-primary-bg border-primary-border text-primary"
                      : "border-line text-fg-subtle hover:text-fg-muted hover:bg-n-850/60"
                  }`}
                >
                  计划
                </button>
                {/* @ 文件引用下拉（参考 QwenPaw 的 @ 路径引用） */}
                {mention && (
                  <div className="absolute bottom-full left-0 mb-2 z-30 w-[340px] rounded-xl border border-line-strong bg-elevated shadow-2xl overflow-hidden animate-in">
                    <div className="flex items-center gap-2 px-3 h-8 border-b border-line text-[10.5px] text-fg-faint">
                      <IconFolder size={11} className="shrink-0" />
                      <span className="truncate font-mono">{mentionListing?.root || "工作区"}</span>
                      {mentionListing?.parent && (
                        <button
                          onClick={() => void openMentionDir(mentionListing.parent as string)}
                          className="ml-auto shrink-0 hover:text-fg-muted transition-colors"
                        >
                          上级
                        </button>
                      )}
                    </div>
                    <div className="max-h-52 overflow-y-auto">
                      {mentionEntries.length === 0 ? (
                        <p className="px-3 py-3 text-[11px] text-fg-faint">没有匹配的文件</p>
                      ) : (
                        mentionEntries.map((entry) => (
                          <button
                            key={entry.path}
                            onClick={() => (entry.type === "dir" ? void openMentionDir(entry.path) : insertMention(entry.path))}
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[11.5px] text-fg-muted hover:bg-n-800/70 transition-colors"
                          >
                            {entry.type === "dir" ? (
                              <IconFolder size={12} className="shrink-0 text-blue" />
                            ) : (
                              <IconFile size={12} className="shrink-0 text-fg-faint" />
                            )}
                            <span className="truncate flex-1 font-mono">{entry.name}</span>
                            {entry.type === "dir" && <IconChevronRight size={11} className="shrink-0 text-fg-faint" />}
                          </button>
                        ))
                      )}
                    </div>
                    <div className="px-3 py-1 border-t border-line/60 text-[10px] text-fg-faint">
                      点击目录进入 · 点击文件插入路径 · Esc 关闭
                    </div>
                  </div>
                )}

                <textarea
                  ref={taRef}
                  value={input}
                  onChange={(e) => {
                    setInput(e.target.value);
                    historyIdx.current = -1;
                    const caret = e.target.selectionStart ?? e.target.value.length;
                    detectMention(e.target.value, caret);
                  }}
                  onKeyDown={(e) => {
                    // Esc：关闭 @ 引用浮层
                    if (e.key === "Escape" && mention) {
                      e.preventDefault();
                      setMention(null);
                      return;
                    }
                    // Alt+Enter：后台运行（不占用对话流）
                    if (e.key === "Enter" && e.altKey) {
                      e.preventDefault();
                      void runInBackground();
                      return;
                    }
                    // Ctrl+Enter：强制入队（Agent 运行中也不打断当前回复）
                    if (e.key === "Enter" && e.ctrlKey) {
                      e.preventDefault();
                      const t = input.trim();
                      if (t) {
                        setQueue((q) => [...q, { id: ++queueSeq.current, text: t }]);
                        setInput("");
                        toast.info("已加入队列");
                      }
                      return;
                    }
                    // isComposing：避免中文输入法选词回车被当成发送
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      send();
                      return;
                    }
                    // ↑/↓ 调历史消息（参考 QwenPaw）
                    const userMsgs = messages.filter((m) => m.role === "user").map((m) => m.content);
                    if (e.key === "ArrowUp" && !input.includes("\n") && userMsgs.length > 0) {
                      e.preventDefault();
                      const next = historyIdx.current < 0 ? userMsgs.length - 1 : Math.max(0, historyIdx.current - 1);
                      historyIdx.current = next;
                      setInput(userMsgs[next]);
                      return;
                    }
                    if (e.key === "ArrowDown" && historyIdx.current >= 0) {
                      e.preventDefault();
                      const next = historyIdx.current + 1;
                      if (next >= userMsgs.length) {
                        historyIdx.current = -1;
                        setInput("");
                      } else {
                        historyIdx.current = next;
                        setInput(userMsgs[next]);
                      }
                    }
                  }}
                  rows={1}
                  placeholder="输入消息…（Enter 发送，Shift+Enter 换行）"
                  className="flex-1 max-h-[180px] px-3.5 py-2 bg-n-900 border border-line rounded-xl text-[12.5px] leading-relaxed text-fg placeholder-fg-faint outline-none focus:border-primary-border transition-all resize-none"
                />
                {sending ? (
                  <button
                    onClick={stop}
                    title="停止生成"
                    className="shrink-0 flex items-center gap-1.5 px-4 py-2 bg-n-850 hover:bg-red-bg border border-line hover:border-red/40 text-fg-muted hover:text-red text-[12px] font-medium rounded-xl transition-colors"
                  >
                    <IconStop size={12} />
                    停止
                  </button>
                ) : (
                  <button
                    onClick={send}
                    disabled={!input.trim()}
                    className="shrink-0 flex items-center gap-1.5 px-4 py-2 bg-primary-strong hover:bg-primary disabled:opacity-40 disabled:cursor-not-allowed text-white text-[12px] font-medium rounded-xl transition-colors"
                  >
                    <IconSend size={12} />
                    发送
                  </button>
                )}
              </div>
              <div className="mt-1.5 flex items-center gap-2 text-[10px] text-fg-faint">
                <span className="truncate">
                  {sending
                    ? "Agent 运行中 · Enter 排队 · Ctrl+Enter 强制入队 · 可随时停止"
                    : "Enter 发送 · Shift+Enter 换行 · Ctrl+Enter 入队 · @ 引用文件 · ↑ 调历史"}
                </span>
                <button
                  onClick={() => void runInBackground()}
                  disabled={!input.trim() || sending}
                  title="后台运行（Alt+Enter）：提交后不占用对话流"
                  className="ml-auto shrink-0 px-1.5 py-0.5 rounded border border-line text-fg-faint hover:text-primary hover:border-primary-border transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  后台运行 Alt+Enter
                </button>
              </div>
            </div>
          </>
        )}

        {tab === "terminal" && workerId && (
          <div className="flex-1 min-h-0 p-4">
            <div className="mb-3">
              <h2 className="text-sm font-semibold text-n-200">执行</h2>
              <p className="text-[11px] text-n-500 mt-0.5">
                Agent 与你执行的所有命令汇聚于此；终端命令过策略、全部记录审计
              </p>
            </div>
            <div className="h-[calc(100%-3.5rem)]">
              <Terminal sessionId={workerId} />
            </div>
          </div>
        )}

        {tab === "files" && (
          <div className="flex-1 overflow-y-auto p-4">
            <div className="mb-3">
              <h2 className="text-sm font-semibold text-n-200">文件</h2>
              <p className="text-[11px] text-n-500 mt-0.5">
                受治理的文件工作区：策略判定为不可见的条目不会出现，读写均记录审计
              </p>
            </div>
            <div className="max-w-2xl">
              <FileBrowser />
            </div>
          </div>
        )}

        {tab === "changes" && (
          <div className="flex-1 overflow-y-auto p-4">
            <div className="flex items-center gap-3 mb-3">
              <h2 className="text-sm font-semibold text-n-200">变更</h2>
              <span className="text-[11px] text-n-500">{fileChanges.length} 个文件 · {writeCount} 处写入</span>
            </div>
            {fileChanges.length === 0 ? (
              <p className="text-[11px] text-n-600">本次会话还没有文件操作</p>
            ) : (
              <div className="space-y-1 max-w-3xl">
                {fileChanges.map((f, i) => {
                  const active = expandedPath === f.path;
                  return (
                    <div key={`${f.path}-${i}`}>
                      <button
                        onClick={() => f.action === "write" && toggleDiff(f.path)}
                        className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-[11px] transition-colors ${
                          f.action === "write" ? "hover:bg-n-800/60 cursor-pointer" : "cursor-default"
                        } ${active ? "bg-n-800/60" : ""}`}
                      >
                        <span className={`shrink-0 px-1.5 py-0.5 rounded font-medium ${
                          f.action === "write" ? "bg-yellow-bg text-yellow" : "bg-blue-bg text-blue"
                        }`}>
                          {f.action === "write" ? "写" : "读"}
                        </span>
                        <span className={`shrink-0 ${f.ok === false ? "text-red" : f.ok === true ? "text-green" : "text-n-600"}`}>
                          {f.ok === false ? "✕" : f.ok === true ? "✓" : "…"}
                        </span>
                        <span className="font-mono text-n-300 truncate flex-1 text-left">{f.path}</span>
                        {f.action === "write" && (
                          <span className="shrink-0 text-[10px] text-n-600">{active ? "收起" : "查看改动"}</span>
                        )}
                      </button>
                      {active && (
                        <div className="px-3">
                          {diffLoading ? (
                            <div className="py-2 text-[11px] text-n-500">读取改动…</div>
                          ) : !diffData || !diffData.found ? (
                            <div className="py-2 text-[11px] text-n-600">暂无改动快照</div>
                          ) : (
                            <DiffView data={diffData} />
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {tab === "usage" && (
          <div className="flex-1 overflow-y-auto p-4">
            <h2 className="text-sm font-semibold text-n-200 mb-1">用量</h2>
            <p className="text-[11px] text-n-500 mb-4">数据来自本次会话的 cost 事件</p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 max-w-3xl">
              {[
                { label: "累计成本", value: `$${usage.total.toFixed(4)}`, tone: "text-green" },
                { label: "对话轮次", value: usage.userTurns, tone: "text-n-100" },
                { label: "工具调用", value: usage.toolCalls, tone: "text-n-100" },
                { label: "写入文件", value: usage.writeCount, tone: usage.writeCount > 0 ? "text-yellow" : "text-n-100" },
              ].map((s) => (
                <div key={s.label} className="card px-4 py-3">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-n-500">{s.label}</div>
                  <div className={`mt-1.5 text-2xl font-semibold tabular-nums ${s.tone}`}>{s.value}</div>
                </div>
              ))}
            </div>
            {usage.total === 0 && usage.toolCalls === 0 && (
              <p className="mt-4 text-[11px] text-n-600">还没有产生用量数据（部分引擎不返回 cost 事件）</p>
            )}
          </div>
        )}

        {tab === "info" && (
          <div className="flex-1 overflow-y-auto p-4">
            <h2 className="text-sm font-semibold text-n-200 mb-3">会话信息</h2>
            <div className="space-y-3 text-[11px] max-w-2xl">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-n-500 font-semibold mb-1">Worker</div>
                <div className="text-n-200">{worker?.name ?? "—"}</div>
                {worker?.description && <div className="text-n-500 mt-0.5">{worker.description}</div>}
              </div>
              <div className="grid grid-cols-2 gap-3">
                {[
                  ["引擎", worker?.config.agentKind ?? "pi"],
                  ["模型", worker?.config.modelName ?? "—"],
                  ["审计", worker?.config.auditEnabled ? "开启" : "关闭"],
                  ["生效策略", String(effectivePolicies.length)],
                ].map(([label, value]) => (
                  <div key={label}>
                    <div className="text-[10px] text-n-500">{label}</div>
                    <div className="text-n-300 font-mono">{value}</div>
                  </div>
                ))}
              </div>
              {worker?.config.systemPrompt && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-fg-faint font-semibold mb-1">System Prompt</div>
                  <pre className="whitespace-pre-wrap text-fg-subtle font-sans bg-n-900/60 border border-line rounded-lg p-3 max-h-60 overflow-auto">
                    {worker.config.systemPrompt}
                  </pre>
                </div>
              )}

              {/* 记忆摘要 + 预算状态：治理透明化 */}
              <div>
                <div className="text-[10px] uppercase tracking-wider text-fg-faint font-semibold mb-1.5">
                  记忆与预算
                </div>
                <div className="space-y-2 rounded-lg border border-line bg-n-900/50 p-2.5 text-[11px]">
                  {wsStatus?.memorySummary ? (
                    <div>
                      <div className="text-[10px] text-fg-faint mb-0.5">平台沉淀的记忆（下轮对话自动参考）</div>
                      <div className="text-fg-subtle leading-relaxed">{wsStatus.memorySummary}</div>
                    </div>
                  ) : (
                    <p className="text-fg-faint">暂无沉淀记忆（对话后自动积累）</p>
                  )}
                  {(wsStatus?.budgetLimitUsd != null || wsStatus?.spentUsd) && (
                    <div className="flex items-center gap-2 pt-1 border-t border-line/60">
                      <span className="text-fg-faint">预算</span>
                      <span className={`font-mono ${wsStatus.budgetLimitUsd != null && (wsStatus.spentUsd ?? 0) >= wsStatus.budgetLimitUsd ? "text-red" : "text-green"}`}>
                        ${(wsStatus.spentUsd ?? 0).toFixed(4)}
                      </span>
                      {wsStatus.budgetLimitUsd != null && (
                        <span className="text-fg-faint">/ 上限 ${wsStatus.budgetLimitUsd}</span>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* 生效策略：治理对用户不再是黑盒 */}
              <div>
                <div className="text-[10px] uppercase tracking-wider text-fg-faint font-semibold mb-1.5">
                  生效策略（{effectivePolicies.length} 条）
                </div>
                {effectivePolicies.length === 0 ? (
                  <p className="text-[11px] text-fg-faint">未配置策略（默认拒绝一切访问）</p>
                ) : (
                  <div className="space-y-1 rounded-lg border border-line bg-n-900/50 p-2.5">
                    {effectivePolicies.map((p, i) => (
                      <div key={i} className="flex items-center gap-2 text-[10.5px]">
                        <span className={`shrink-0 px-1.5 py-0.5 rounded font-medium ${
                          p.access === "rw"
                            ? "bg-green-bg text-green"
                            : p.access === "r"
                              ? "bg-blue-bg text-blue"
                              : "bg-red-bg text-red"
                        }`}>
                          {p.access}
                        </span>
                        <span className="font-mono text-fg-subtle truncate" title={p.path}>{p.path}</span>
                      </div>
                    ))}
                  </div>
                )}
                <p className="text-[10px] text-fg-faint mt-1.5">
                  全局默认 + 本 Worker 覆盖的合并结果，三个引擎统一生效
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 删除会话确认（替代 window.confirm） */}
      <ConfirmModal
        open={confirmDelete}
        title="删除该会话？"
        description={`「${session?.title ?? ""}」及其消息将被永久删除，此操作不可恢复。`}
        confirmText="删除"
        danger
        onCancel={() => setConfirmDelete(false)}
        onConfirm={removeCurrent}
      />

      {/* 回滚确认 */}
      <ConfirmModal
        open={restoreTarget !== null}
        title="恢复到该版本？"
        description={restoreTarget
          ? `文件将回滚到 ${new Date(restoreTarget.timestamp).toLocaleString()} 改动前的内容。恢复前会为当前内容补一次快照，因此仍可再次回滚。`
          : undefined}
        confirmText="恢复"
        busy={restoring}
        onCancel={() => setRestoreTarget(null)}
        onConfirm={restoreSnapshot}
      />
    </div>
  );
}
  





