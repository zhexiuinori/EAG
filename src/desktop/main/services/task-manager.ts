// ---------------------------------------------------------------------------
// EAG Desktop — Background Task Manager
//
// 后台任务：提交后立即返回 taskId，Agent 在后台执行，状态通过 TASK_EVENT
// 推送到渲染进程（参考 QwenPaw 的 background task 模型）。
//
// 与同步聊天的关系：
//   · 同步聊天（workspace:chat:send）保持现状，适合短交互；
//   · 后台任务适合长任务（大量分析 / 生成），不占用对话流。
//   · 同一个 Worker 同时只允许一个任务（与 worker-service 的单会话模型一致）。
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import * as workerService from "./worker-service.ts";
import * as userService from "./user-service.ts";
import type {
  AgentEvent, BackgroundTask, BackgroundTaskStatus, TaskSubmitInput,
} from "../../shared/types.ts";

/** 保留的任务数量上限（运行中的任务不会被淘汰）。 */
const MAX_TASKS = 50;
/** 输出预览的滚动窗口大小。 */
const MAX_PREVIEW = 4000;

const tasks = new Map<string, BackgroundTask>();

/** 事件出口：由 ipc-handlers 注入（广播到所有窗口）。 */
let eventSink: ((task: BackgroundTask) => void) | null = null;

export function setTaskEventSink(fn: ((task: BackgroundTask) => void) | null): void {
  eventSink = fn;
}

function publish(task: BackgroundTask): void {
  eventSink?.({ ...task });
}

/**
 * 变更任务状态并推送。
 * 通过函数封装避免 TS 把 task.status 窄化成字面量（状态会被 cancelTask 跨栈帧修改）。
 */
function markStatus(task: BackgroundTask, status: BackgroundTaskStatus): void {
  task.status = status;
  publish(task);
}

/** 淘汰最旧的已完成任务，保留运行中的。 */
function trim(): void {
  if (tasks.size <= MAX_TASKS) return;
  const ids = [...tasks.values()]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let excess = tasks.size - MAX_TASKS;
  for (const t of ids) {
    if (excess <= 0) break;
    if (t.status === "running" || t.status === "queued") continue;
    tasks.delete(t.id);
    excess -= 1;
  }
}

export function hasActiveTaskForWorker(workerId: string): boolean {
  return [...tasks.values()].some(
    (t) => t.workerId === workerId && (t.status === "running" || t.status === "queued"),
  );
}

/** 提交一个后台任务；同 Worker 已有活动任务时抛错。 */
export function submitTask(input: TaskSubmitInput): BackgroundTask {
  const worker = workerService.getWorker(input.workerId);
  if (!worker) throw new Error("Worker 不存在");
  const text = input.text.trim();
  if (!text) throw new Error("任务内容为空");
  if (hasActiveTaskForWorker(input.workerId)) {
    throw new Error("该 Worker 已有后台任务在运行，请等待完成或取消");
  }

  const task: BackgroundTask = {
    id: randomUUID(),
    workerId: input.workerId,
    userId: userService.getSession().userId,
    workerName: worker.name,
    text,
    status: "queued",
    createdAt: new Date().toISOString(),
    outputPreview: "",
  };
  tasks.set(task.id, task);
  trim();
  publish(task);

  void runTask(task);
  return task;
}

async function runTask(task: BackgroundTask): Promise<void> {
  task.startedAt = new Date().toISOString();
  markStatus(task, "running");

  try {
    // operatorId 传提交者：任务可能在用户切换身份后仍在运行，
    // 审计归属必须锚定"谁提交的"，而不是"当前会话是谁"。
    const res = await workerService.sendToWorker(task.workerId, task.text, undefined, (ev: AgentEvent) => {
      // 只累积预览，不逐 token 推送事件（避免事件风暴）；面板轮询即可读到增量
      if (ev.type === "text_delta") {
        task.outputPreview = (task.outputPreview + ev.delta).slice(-MAX_PREVIEW);
      } else if (ev.type === "tool_start") {
        task.outputPreview = `${task.outputPreview}\n▸ ${ev.toolName}\n`.slice(-MAX_PREVIEW);
      }
    }, task.userId);

    // 用户主动取消时不覆盖状态
    if (task.status !== "cancelled") {
      task.error = res.error;
      markStatus(task, res.success ? "done" : "error");
    }
  } catch (e: any) {
    if (task.status !== "cancelled") {
      task.error = e?.message ?? String(e);
      markStatus(task, "error");
    }
  } finally {
    if (!task.endedAt) {
      task.endedAt = new Date().toISOString();
      publish(task);
    }
  }
}

/** 取消任务（复用 abortChat 终止子进程）；仅提交者或管理员可取消。 */
export async function cancelTask(id: string): Promise<boolean> {
  const task = tasks.get(id);
  if (!task || (task.status !== "running" && task.status !== "queued")) return false;

  const session = userService.getSession();
  if (task.userId !== session.userId && session.role !== "admin") return false;

  if (task.status === "running") {
    await workerService.abortChat(task.workerId).catch(() => {});
  }
  task.endedAt = new Date().toISOString();
  markStatus(task, "cancelled");
  return true;
}

/**
 * 任务列表按提交者隔离：普通用户只看自己的任务；
 * 管理员可见全部（便于排查他人提交的长任务）。
 */
export function listTasks(filter?: { workerId?: string }): BackgroundTask[] {
  const session = userService.getSession();
  const all = session.role === "admin";
  return [...tasks.values()]
    .filter((t) => all || t.userId === session.userId)
    .filter((t) => !filter?.workerId || t.workerId === filter.workerId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
