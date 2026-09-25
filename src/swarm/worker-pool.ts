import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type {
  WorkerPoolConfig,
  AtomicTask,
  WorkerTaskSpec,
  WorkerTaskResult,
  SwarmProgressEvent,
} from './types.ts';

/**
 * 对 AtomicTask 数组做拓扑排序，返回多个批次。
 * 每个批次内的任务之间无依赖关系，可并行执行。
 * 批次按依赖顺序排列：第 i 批次的所有依赖都在前 i-1 批次中。
 *
 * 若检测到循环依赖，则抛出错误。
 */
function topoSortBatches(tasks: AtomicTask[]): AtomicTask[][] {
  const remaining = new Map<string, AtomicTask>();
  for (const t of tasks) {
    remaining.set(t.id, t);
  }

  const batches: AtomicTask[][] = [];
  const completed = new Set<string>();

  while (remaining.size > 0) {
    const batch: AtomicTask[] = [];

    for (const [id, task] of remaining) {
      const depsSatisfied = task.dependsOn.every((dep) => completed.has(dep));
      if (depsSatisfied) {
        batch.push(task);
      }
    }

    if (batch.length === 0) {
      // 没有任何任务可以推进，说明存在循环依赖
      const stuckIds = [...remaining.keys()].join(', ');
      throw new Error(
        `循环依赖检测：以下任务无法满足依赖（可能形成环）：${stuckIds}`,
      );
    }

    for (const task of batch) {
      remaining.delete(task.id);
      completed.add(task.id);
    }

    batches.push(batch);
  }

  return batches;
}

/**
 * 构建 WorkerTaskSpec，去掉 AtomicTask 中不需要传给 Worker 的字段（dependsOn）。
 */
function toTaskSpec(task: AtomicTask): WorkerTaskSpec {
  return {
    taskId: task.id,
    title: task.title,
    description: task.description,
    input: task.input,
    outputLocation: task.outputLocation,
  };
}

/**
 * 执行一批 Worker（无依赖，可并行）。
 * 返回每个 Worker 的执行结果。
 */
/** 批次内单个任务的生命周期回调（用于向上层推送执行进度）。 */
interface BatchHooks {
  onTaskStart?: (task: AtomicTask) => void;
  onTaskEnd?: (task: AtomicTask, result: WorkerTaskResult) => void;
}

async function executeBatch(
  config: WorkerPoolConfig,
  batch: AtomicTask[],
  hooks?: BatchHooks,
): Promise<WorkerTaskResult[]> {
  // 限制并发数
  const semaphore = Math.min(config.maxWorkers, batch.length);

  const results: WorkerTaskResult[] = [];
  let nextIndex = 0;

  async function workerRunner(): Promise<void> {
    while (nextIndex < batch.length) {
      const task = batch[nextIndex++];
      hooks?.onTaskStart?.(task);
      const result = await runSingleWorker(config, task);
      hooks?.onTaskEnd?.(task, result);
      results.push(result);
    }
  }

  const runners: Promise<void>[] = [];
  for (let i = 0; i < semaphore; i++) {
    runners.push(workerRunner());
  }
  await Promise.all(runners);

  return results;
}

/**
 * 启动单个 Worker 并等待完成。
 */
async function runSingleWorker(
  config: WorkerPoolConfig,
  task: AtomicTask,
): Promise<WorkerTaskResult> {
  const startedAt = new Date().toISOString();
  const taskSpec = toTaskSpec(task);
  const taskSpecJson = JSON.stringify(taskSpec);

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => {
    abortController.abort();
  }, config.timeoutMs);

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('node', [config.launcherPath, '--task', taskSpecJson], {
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: abortController.signal,
      });

      let stdout = '';
      let stderr = '';
      // 限制捕获量，避免长任务把整个输出堆进内存
      const MAX_CAPTURE = 512 * 1024;

      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdout.length < MAX_CAPTURE) stdout += chunk.toString();
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < MAX_CAPTURE) stderr += chunk.toString();
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          const msg = stderr.trim()
            ? `Worker 退出码 ${code}: ${stderr.trim()}`
            : `Worker 退出码 ${code}`;
          reject(new Error(msg));
        }
      });

      child.on('error', (err) => {
        if (err.name === 'AbortError') {
          reject(new Error(`Worker 超时（${config.timeoutMs}ms）`));
        } else {
          reject(err);
        }
      });
    });

    // 读取输出文件。
    // launcher 负责写入 outputLocation；缺失说明 Worker 未真正产出，
    // 此前被静默吞掉，导致 Swarm 显示"成功"却没有任何结果。
    try {
      fs.readFileSync(task.outputLocation, 'utf-8');
    } catch {
      return {
        taskId: task.id,
        success: false,
        outputLocation: task.outputLocation,
        error: `未找到任务输出文件：${task.outputLocation}（launcher 未写入或已崩溃）`,
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }

    const completedAt = new Date().toISOString();

    return {
      taskId: task.id,
      success: true,
      outputLocation: task.outputLocation,
      error: undefined,
      startedAt,
      completedAt,
    };
  } catch (err: unknown) {
    const completedAt = new Date().toISOString();
    const errorMessage = err instanceof Error ? err.message : String(err);

    return {
      taskId: task.id,
      success: false,
      outputLocation: task.outputLocation,
      error: errorMessage,
      startedAt,
      completedAt,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 执行一组任务，按 DAG 依赖分批并行执行 Worker。
 *
 * @param config   Worker 池配置（最大并发数、超时时间、启动器路径）
 * @param tasks    原子任务列表
 * @returns        每个任务的执行结果数组
 */
export async function executeTasks(
  config: WorkerPoolConfig,
  tasks: AtomicTask[],
  onProgress?: (e: SwarmProgressEvent) => void,
): Promise<WorkerTaskResult[]> {
  if (tasks.length === 0) {
    return [];
  }

  const batches = topoSortBatches(tasks);
  const allResults: WorkerTaskResult[] = [];
  const total = tasks.length;
  let completed = 0;

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const batchResults = await executeBatch(config, batch, {
      onTaskStart: (task) =>
        onProgress?.({
          phase: 'task_start',
          taskId: task.id,
          title: task.title,
          batchIndex: bi,
          batchTotal: batches.length,
          completed,
          total,
        }),
      onTaskEnd: (task, result) => {
        completed += 1;
        onProgress?.({
          phase: 'task_end',
          taskId: task.id,
          title: task.title,
          success: result.success,
          error: result.error,
          batchIndex: bi,
          batchTotal: batches.length,
          completed,
          total,
        });
      },
    });
    allResults.push(...batchResults);
  }

  return allResults;
}
