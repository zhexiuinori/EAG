/**
 * orchestrator — 蜂群编排器主入口
 *
 * 协调完整蜂群工作流：
 *   1. 接收用户请求
 *   2. 调 task-decomposer 拆解为原子任务
 *   3. 调 worker-pool 分配并执行
 *   4. 调 aggregator 协议化聚合结果
 *   5. 返回最终交付物
 */

import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { decompose, decomposeWithLLM } from "./task-decomposer.ts";
import { executeTasks } from "./worker-pool.ts";
import { aggregateResults } from "./aggregator.ts";
import type {
  AtomicTask,
  UserRequest,
  WorkerPoolConfig,
  WorkerTaskResult,
  SwarmResult,
  SwarmOrchestrator,
  SwarmProgressEvent,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

function defaultConfig(): WorkerPoolConfig {
  return {
    maxWorkers: Number(process.env.EAG_SWARM_MAX_WORKERS) || 5,
    timeoutMs: Number(process.env.EAG_SWARM_TASK_TIMEOUT_MS) || 600_000,
    launcherPath:
      process.env.EAG_SWARM_LAUNCHER ||
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../launcher/eag-launch.ts"),
  };
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

function nowISO(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Orchestrator implementation
// ---------------------------------------------------------------------------

class SwarmOrchestratorImpl implements SwarmOrchestrator {
  private config: WorkerPoolConfig;

  constructor(config?: Partial<WorkerPoolConfig>) {
    this.config = { ...defaultConfig(), ...config };
  }

  async execute(request: UserRequest, onProgress?: (e: SwarmProgressEvent) => void): Promise<SwarmResult> {
    const startedAt = nowISO();

    // Phase 1: Decompose — 优先 LLM，拆不动则回退规则式（不因模型不可用而整体失败）
    console.log("[Swarm] Decomposing request...");
    let tasks: AtomicTask[];
    try {
      const llmTasks = await decomposeWithLLM(request);
      tasks = llmTasks ?? decompose(request);
      console.log(`[Swarm] Decomposition via ${llmTasks ? "LLM" : "rules"}`);
    } catch (err) {
      return {
        success: false,
        tasks: [],
        output: { format: "markdown", content: `Task decomposition failed: ${err}` },
        workerResults: [],
        error: String(err),
        startedAt,
        completedAt: nowISO(),
      };
    }

    if (tasks.length === 0) {
      return {
        success: true,
        tasks: [],
        output: { format: "markdown", content: "No tasks to execute." },
        workerResults: [],
        startedAt,
        completedAt: nowISO(),
      };
    }

    console.log(`[Swarm] Decomposed into ${tasks.length} tasks: ${tasks.map((t) => t.id).join(", ")}`);
    onProgress?.({ phase: "decomposed", total: tasks.length });

    // Phase 2: Execute
    console.log("[Swarm] Dispatching tasks to worker pool...");
    let workerResults: WorkerTaskResult[];
    try {
      workerResults = await executeTasks(this.config, tasks, onProgress);
    } catch (err) {
      return {
        success: false,
        tasks,
        output: { format: "markdown", content: `Worker execution failed: ${err}` },
        workerResults: [],
        error: String(err),
        startedAt,
        completedAt: nowISO(),
      };
    }

    const allSucceeded = workerResults.every((r) => r.success);
    console.log(`[Swarm] Workers completed: ${workerResults.filter((r) => r.success).length}/${workerResults.length} succeeded`);

    // Phase 3: Aggregate
    console.log("[Swarm] Aggregating results...");
    const output = aggregateResults(tasks, workerResults, request.format);

    const completedAt = nowISO();
    const result: SwarmResult = {
      success: allSucceeded,
      tasks,
      output,
      workerResults,
      error: allSucceeded ? undefined : "Some tasks failed",
      startedAt,
      completedAt,
    };

    return result;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new Swarm Orchestrator with optional configuration overrides.
 */
export function createOrchestrator(config?: Partial<WorkerPoolConfig>): SwarmOrchestrator {
  return new SwarmOrchestratorImpl(config);
}

/**
 * Convenience: create and execute in one call.
 */
export async function executeSwarm(
  request: UserRequest,
  config?: Partial<WorkerPoolConfig>,
  onProgress?: (e: SwarmProgressEvent) => void,
): Promise<SwarmResult> {
  const orchestrator = createOrchestrator(config);
  return orchestrator.execute(request, onProgress);
}
