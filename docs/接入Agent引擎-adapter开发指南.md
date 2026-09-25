# 接入一个 Agent 引擎（Adapter 开发指南）

> EAG 的核心目标之一是"**嵌入任何 agent**"。任何引擎——无论是 CLI（`claude -p` /
> `codex exec`）、本机进程，还是远程 HTTP 平台——只要实现一个 `AgentAdapter`
> 接口，并把实例注册进 `registry.ts`，就能被 EAG 治理（策略执行 + 审计 +
> 审批 + 可观测 + 预算）。

## 前提：治理是 EAG 的，引擎只是通道

EAG 的治理逻辑全部在 `src/extension/` 与 `src/desktop/main/services/` 中，
**adapter 不做任何治理决策**。adapter 只有三件事：

1. 把 EAG 的治理配置翻译成引擎的启动参数 / 环境变量 / 注入凭证；
2. 引擎的原始输出（stdout JSON / 文本 / HTTP 响应）归一化成 `AgentEvent`；
3. 把 Worker 的 systemPrompt 前置到 prompt（可复用 `composePrompt`）。

## 你只需要实现这个接口

```ts
// src/desktop/main/adapters/types.ts
export interface AgentAdapter {
  readonly kind: AgentKind;                 // 唯一标识，对应 WorkerConfig.agentKind
  readonly displayName: string;             // UI 展示名
  readonly capabilities: AdapterCapabilities; // 诚实声明治理能力（见下）
  detect(): Promise<{ installed: boolean; version?: string }>; // 引擎是否可用
  startSession(worker: Worker, opts: AgentSessionOptions): Promise<AgentSession>;
}
```

`AgentSession` 提供一条异步迭代器（每次 `send(text)` 产出归一化事件流）：
- `send(text): AsyncIterableIterator<AgentEvent>`
- `stop()` / `dispose()`：中止/释放子进程
- `getSessionId()`：多轮续接的会话 id（无则返回 `undefined`）

## 已经把能力声明"诚实化"（你调研 QwenPaw 点破的坑）

`AdapterCapabilities` 的每个字段都**必须如实**，否则 AI 会误判治理强度：

| 字段 | 含义 | 对应 EAG 治理 |
|---|---|---|
| `toolLevelApproval` | 工具调用前能否拦截（hook/execpolicy） | **false 时命令只能"被观测"不能阻断** |
| `streamEvents` | 是否流式输出归一化事件 | 决定 UI 实时性 |
| `sandboxControl` | 平台侧能否控制文件权限 | 策略执行的强度 |
| `egressControl` | 原生出网白名单支持 | 无则只观测不阻断 |
| `costReporting` | 是否上报成本 | 决定预算封顶是否有效 |
| `sessionResume` | 多轮续接 | 会话连续性 |

> ⚠️ **绝不要谎报**：`claude-code` / `codex` 早期都标了 `toolLevelApproval: true`
> 但注释却写 `wired in Phase 3`——那是能力谎报，会破坏可信度。做不到就标 `false`。

## 把 AgentEvent 归一化的最小规则

```ts
export type AgentEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_start"; toolName: string; input?: unknown }   // 提取 path/command 供审计/拦截
  | { type: "tool_end"; toolName: string; input?: unknown; isError?: boolean; content?: string }
  | { type: "cost"; totalCostUsd?: number; usage?: unknown }     // 供预算封顶
  | { type: "agent_end"; sessionId?: string; success?: boolean }
  | { type: "error"; message: string };
```

参考现成实现：
- `claude-code.ts`：`--output-format stream-json` + `parseStreamLine`
- `codex.ts`：`--json` + `parseJsonlLine`
- `pi.ts`：`--print` 一次性输出（无流，`streamEvents: false`）

## 注册你的引擎

```ts
// src/desktop/main/adapters/registry.ts
import { myEngineAdapter } from "./my-engine.ts";
const ADAPTERS: Partial<Record<AgentKind, AgentAdapter>> = {
  "claude-code": claudeCodeAdapter,
  codex: codexAdapter,
  pi: piAdapter,
  "my-engine": myEngineAdapter, // ← 加这一行
};
```

`AgentKind` 已预留 `qwenpaw` / `openclaw` 两个槽位（`shared/types.ts`）。

## 然后回写这份文档

在 `docs/` 里以本文件为模板，追加你接入的引擎的具体参数与踩坑记录，方便
后续维护者与团队复用。

## 已接入引擎一览

| kind | 引擎 | 形态 | toolLevelApproval | cost | 备注 |
|---|---|---|---|---|---|
| `claude-code` | Claude Code CLI | spawn 子进程 | 视 `EAG_CLAUDE_HOOKS` | ✅ | `stream-json` |
| `codex` | Codex CLI | spawn 子进程 | ❌ | ✅ | `--json` |
| `pi` | pi-coding-agent | spawn 子进程 | ✅ | ❌ | `--print`，治理扩展全链路 |

## 相关

- `src/desktop/main/adapters/` 全部现成实现
- `src/desktop/shared/types.ts` 的 `AgentKind` / `AdapterCapabilities`
