import fs from 'node:fs';
import type { AtomicTask, WorkerTaskResult, AggregatedOutput } from './types.ts';

/**
 * 对 tasks 做拓扑排序，有依赖的先出。
 * 使用 Kahn 算法。
 */
function topologicalSort(tasks: AtomicTask[]): AtomicTask[] {
  const taskMap = new Map<string, AtomicTask>();
  for (const t of tasks) taskMap.set(t.id, t);

  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>(); // taskId → 依赖它的 taskId 列表

  for (const t of tasks) {
    inDegree.set(t.id, 0);
    adj.set(t.id, []);
  }

  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      // dep → t：t 依赖 dep，所以 dep 完成后 t 才能出
      const list = adj.get(dep);
      if (list) list.push(t.id);
      inDegree.set(t.id, (inDegree.get(t.id) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const sorted: AtomicTask[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const task = taskMap.get(id);
    if (task) sorted.push(task);
    for (const neighbor of adj.get(id) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  // 如果存在环，未排序的 task 追加到尾部（保证不丢）
  if (sorted.length < tasks.length) {
    const sortedIds = new Set(sorted.map(t => t.id));
    for (const t of tasks) {
      if (!sortedIds.has(t.id)) sorted.push(t);
    }
  }

  return sorted;
}

/**
 * 从 outputLocation 读取文件内容。
 * 文件不存在时返回标记字符串。
 */
function readOutputContent(location: string, taskId: string): string {
  try {
    if (!fs.existsSync(location)) {
      return `[Task ${taskId}: output not found]`;
    }
    return fs.readFileSync(location, 'utf-8');
  } catch {
    return `[Task ${taskId}: output not found]`;
  }
}

/**
 * 协议化聚合器。
 *
 * 接收 AtomicTask[] + WorkerTaskResult[]，从各 outputLocation 读取结果，
 * 按 DAG 顺序拼接（有依赖的先出），不做任何 AI/LLM 处理——纯机械拼接。
 *
 * @param tasks  - 原子任务列表
 * @param results - Worker 任务结果列表
 * @param format  - 输出格式，'markdown'（默认）或 'json'
 * @returns AggregatedOutput
 */
export function aggregateResults(
  tasks: AtomicTask[],
  results: WorkerTaskResult[],
  format: 'markdown' | 'json' = 'markdown',
): AggregatedOutput {
  // 1. 构建索引
  const resultMap = new Map<string, WorkerTaskResult>();
  for (const r of results) resultMap.set(r.taskId, r);

  const taskMap = new Map<string, AtomicTask>();
  for (const t of tasks) taskMap.set(t.id, t);

  // 2. 拓扑排序
  const sortedTasks = topologicalSort(tasks);

  // 3. 遍历产出内容
  const contentMap = new Map<string, string>(); // taskId → 内容

  for (const task of sortedTasks) {
    const result = resultMap.get(task.id);

    if (!result || !result.success) {
      const errorMsg = result?.error ?? 'unknown error';
      contentMap.set(task.id, `[Task ${task.id} 失败: ${errorMsg}]`);
      continue;
    }

    const content = readOutputContent(result.outputLocation, task.id);
    contentMap.set(task.id, content);
  }

  // 4. 格式化输出
  if (format === 'json') {
    const data: Record<string, unknown> = {};
    for (const task of sortedTasks) {
      data[task.id] = contentMap.get(task.id) ?? `[Task ${task.id}: output not found]`;
    }
    return { format: 'json', data };
  }

  // markdown 格式：标题 + 内容段落拼接
  const parts: string[] = [];
  for (const task of sortedTasks) {
    const content = contentMap.get(task.id) ?? `[Task ${task.id}: output not found]`;
    parts.push(`## ${task.title}`);
    parts.push('');
    parts.push(content);
    parts.push('');
  }

  return {
    format: 'markdown',
    content: parts.join('\n').trimEnd(),
  };
}
