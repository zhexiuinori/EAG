// 原子任务
export interface AtomicTask {
  id: string
  title: string
  description: string
  input: unknown          // 任务的具体输入
  outputLocation: string  // 预定义输出位置路径（绝对路径）
  dependsOn: string[]     // 依赖的原子任务 id 列表
}

// 用户请求
export interface UserRequest {
  prompt: string          // 用户原始指令
  context?: string        // 附加上下文
  format?: 'markdown' | 'json'
}

// Worker 池配置
export interface WorkerPoolConfig {
  maxWorkers: number      // 默认 5
  timeoutMs: number       // 默认 600000（10 分钟）
  launcherPath: string    // eag-launch.ts 的绝对路径
}

// Worker 任务规格（传给 Worker 启动器的参数）
export interface WorkerTaskSpec {
  taskId: string
  title: string
  description: string
  input: unknown
  outputLocation: string
}

// Worker 任务结果
export interface WorkerTaskResult {
  taskId: string
  success: boolean
  outputLocation: string
  error?: string
  startedAt: string       // ISO
  completedAt: string     // ISO
}

// 聚合输出
export type AggregatedOutput = MarkdownOutput | JsonOutput

export interface MarkdownOutput {
  format: 'markdown'
  content: string
}

export interface JsonOutput {
  format: 'json'
  data: Record<string, unknown>
}

// 蜂群执行结果
export interface SwarmResult {
  success: boolean
  tasks: AtomicTask[]
  output: AggregatedOutput
  workerResults: WorkerTaskResult[]
  error?: string
  startedAt: string
  completedAt: string
}

// 蜂群执行进度事件（编排器 → 主进程 → 渲染进程推送）
export type SwarmProgressEvent =
  | { phase: 'decomposed'; total: number }
  | {
      phase: 'task_start'
      taskId: string
      title: string
      batchIndex: number
      batchTotal: number
      completed: number
      total: number
    }
  | {
      phase: 'task_end'
      taskId: string
      title: string
      success: boolean
      error?: string
      batchIndex: number
      batchTotal: number
      completed: number
      total: number
    }

// 蜂群编排器接口
export interface SwarmOrchestrator {
  execute(request: UserRequest, onProgress?: (e: SwarmProgressEvent) => void): Promise<SwarmResult>
}
