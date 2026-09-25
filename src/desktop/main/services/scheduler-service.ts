// ---------------------------------------------------------------------------
// EAG — 定时任务（无人值守 Agent）
//
// 让 Agent 在没人盯着的时候干活：按周期（每 N 分钟 / 每天 HH:MM）自动把
// 一段 prompt 交给某个 Worker 执行。
//
// 治理一致性（关键）：调度触发**不绕过**任何管控 ——
//   · 预算：执行前走 worker-service 的 isWorkerBudgeted
//   · 审计：operatorId = "scheduler"，记录 __scheduled_run（含 job/worker）
//   · 策略/护栏/MCP/知识库：与手动对话走完全相同的 sendToWorker 路径
//
// 持久化：<root>/schedules.json（管理员配置，便于版本化/备份）
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import { SCHEDULES_PATH } from "../paths.ts";
import * as workerService from "./worker-service.ts";
import * as auditApi from "./audit-api.ts";
import * as notificationService from "./notification-service.ts";
import type {
  ScheduledJob, ScheduledJobUpsertInput,
} from "../../shared/types.ts";

// ---------------------------------------------------------------------------
// 持久化
// ---------------------------------------------------------------------------

function load(): ScheduledJob[] {
  try {
    const list = JSON.parse(fs.readFileSync(SCHEDULES_PATH, "utf-8"));
    return Array.isArray(list) ? (list as ScheduledJob[]) : [];
  } catch {
    return [];
  }
}

function save(jobs: ScheduledJob[]): void {
  fs.writeFileSync(SCHEDULES_PATH, JSON.stringify(jobs, null, 2), "utf-8");
}

let jobs: ScheduledJob[] = load();

// ---------------------------------------------------------------------------
// 触发时间计算
// ---------------------------------------------------------------------------

/** 计算下一次触发时间（ISO）。无有效规则返回 null。 */
export function computeNextRun(job: ScheduledJob, from = new Date()): string | null {
  if (!job.enabled) return null;

  if (job.everyMinutes && job.everyMinutes > 0) {
    const base = job.lastRunAt ? new Date(job.lastRunAt) : from;
    const next = new Date(base.getTime() + job.everyMinutes * 60_000);
    return (next.getTime() <= from.getTime() ? new Date(from.getTime() + 1000) : next).toISOString();
  }

  if (job.dailyAt && /^\d{1,2}:\d{2}$/.test(job.dailyAt)) {
    const [h, m] = job.dailyAt.split(":").map((x) => Number(x));
    const next = new Date(from);
    next.setHours(h, m, 0, 0);
    if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
    return next.toISOString();
  }

  return null;
}

function withNextRun(job: ScheduledJob, from = new Date()): ScheduledJob {
  return { ...job, nextRunAt: computeNextRun(job, from) ?? undefined };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function listJobs(): ScheduledJob[] {
  const now = new Date();
  return jobs.map((j) => withNextRun(j, now));
}

export function getJob(id: string): ScheduledJob | undefined {
  return jobs.find((j) => j.id === id);
}

export function upsertJob(input: ScheduledJobUpsertInput): ScheduledJob {
  const idx = input.id ? jobs.findIndex((j) => j.id === input.id) : -1;

  if (!input.everyMinutes && !input.dailyAt) {
    throw new Error("必须指定触发规则（每 N 分钟 或 每天 HH:MM）");
  }
  if (!input.workerId) throw new Error("必须选择执行该任务的 Worker");

  if (idx >= 0) {
    jobs[idx] = {
      ...jobs[idx],
      name: input.name,
      workerId: input.workerId,
      prompt: input.prompt,
      everyMinutes: input.everyMinutes,
      dailyAt: input.dailyAt,
      enabled: input.enabled ?? jobs[idx].enabled,
    };
    // 规则变更后重算下次运行（避免沿用旧节奏）
    jobs[idx].nextRunAt = computeNextRun(jobs[idx]) ?? undefined;
    save(jobs);
    return jobs[idx];
  }

  const job: ScheduledJob = {
    id: `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: input.name,
    workerId: input.workerId,
    prompt: input.prompt,
    everyMinutes: input.everyMinutes,
    dailyAt: input.dailyAt,
    enabled: input.enabled ?? true,
    createdAt: new Date().toISOString(),
  };
  job.nextRunAt = computeNextRun(job) ?? undefined;
  jobs.push(job);
  save(jobs);
  return job;
}

export function deleteJob(id: string): boolean {
  const next = jobs.filter((j) => j.id !== id);
  if (next.length === jobs.length) return false;
  jobs = next;
  save(jobs);
  return true;
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

/** 正在执行的 job（防止同一 job 并发重入）。 */
const running = new Set<string>();

/**
 * 执行一个 job。返回是否成功启动（执行结果写入 job.lastStatus）。
 * 手动"立即运行"与定时触发共用此函数。
 */
export async function runJob(id: string, trigger: "schedule" | "manual"): Promise<{ ok: boolean; error?: string }> {
  const job = getJob(id);
  if (!job) return { ok: false, error: "任务不存在" };
  if (running.has(id)) return { ok: false, error: "该任务正在执行中" };

  const worker = workerService.getWorker(job.workerId);
  if (!worker) {
    job.lastStatus = "error";
    job.lastError = "Worker 不存在";
    save(jobs);
    return { ok: false, error: job.lastError };
  }

  // 预算检查：与手动对话同一道闸（无人值守更不能超预算）
  const budget = workerService.isWorkerBudgeted(worker);
  if (!budget.ok) {
    job.lastStatus = "error";
    job.lastError = budget.reason ?? "预算已耗尽";
    job.lastRunAt = new Date().toISOString();
    job.nextRunAt = computeNextRun(job) ?? undefined;
    save(jobs);
    auditApi.appendAuditEntry({
      userId: "scheduler", workerId: job.workerId, toolName: "__scheduled_run",
      toolCallId: undefined, phase: "call",
      input: { jobId: job.id, name: job.name, trigger }, isError: true, reason: job.lastError,
    });
    // 预算耗尽说明该 Agent 已经被"熔断"，值得喊人处理
    notificationService.notify({
      title: `定时任务「${job.name}」未执行：预算已耗尽`,
      body: job.lastError,
      level: "warn",
      source: `scheduler:${job.id}`,
    });
    return { ok: false, error: job.lastError };
  }

  running.add(id);
  auditApi.appendAuditEntry({
    userId: "scheduler", workerId: job.workerId, toolName: "__scheduled_run",
    toolCallId: undefined, phase: "call",
    input: { jobId: job.id, name: job.name, trigger, prompt: job.prompt.slice(0, 300) },
  });

  job.lastRunAt = new Date().toISOString();

  try {
    // 走完全相同的受治理通道；operatorId 固定 scheduler（审计归属可追溯）
    const res = await workerService.sendToWorker(job.workerId, job.prompt, undefined, undefined, "scheduler");
    job.lastStatus = res.success ? "ok" : "error";
    job.lastError = res.success ? undefined : (res.error ?? "执行失败");

    // 通知：无人值守的结果得能"喊到人"（站内 + 可选 Webhook 外推）
    const preview = (res.output ?? "").trim().slice(0, 300);
    notificationService.notify({
      title: `定时任务「${job.name}」${res.success ? "执行完成" : "执行失败"}`,
      body: [res.success ? preview : job.lastError, `触发方式：${trigger === "manual" ? "手动" : "定时"}`]
        .filter(Boolean)
        .join("\n"),
      level: res.success ? "success" : "error",
      source: `scheduler:${job.id}`,
    });

    return { ok: res.success, error: job.lastError };
  } catch (e: any) {
    job.lastStatus = "error";
    job.lastError = e?.message ?? String(e);
    notificationService.notify({
      title: `定时任务「${job.name}」异常`,
      body: job.lastError,
      level: "error",
      source: `scheduler:${job.id}`,
    });
    return { ok: false, error: job.lastError };
  } finally {
    running.delete(id);
    job.nextRunAt = computeNextRun(job) ?? undefined;
    save(jobs);
  }
}

// ---------------------------------------------------------------------------
// 调度循环
// ---------------------------------------------------------------------------

let timer: NodeJS.Timeout | undefined;

/** 检查一轮到期任务（导出便于测试）。 */
export async function tick(now = new Date()): Promise<string[]> {
  const due = jobs.filter((j) => {
    if (!j.enabled) return false;
    const next = computeNextRun(j, now);
    return !!next && new Date(next).getTime() <= now.getTime();
  });

  const started: string[] = [];
  for (const j of due) {
    started.push(j.id);
    // 不 await：多个任务并行执行；runJob 内部有重入保护
    void runJob(j.id, "schedule");
  }
  return started;
}

/** 启动调度循环（幂等，Electron 与 Web 两个入口都会调用）。 */
export function start(intervalMs = 30_000): void {
  if (timer) return;
  timer = setInterval(() => {
    void tick().catch(() => {
      // 调度循环自身异常不应中断服务
    });
  }, intervalMs);
  // 不阻塞进程退出
  timer.unref?.();
}

export function stop(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}
