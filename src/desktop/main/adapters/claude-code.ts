// ---------------------------------------------------------------------------
// EAG — Claude Code adapter
//
// Drives `claude -p` (headless) as a governed worker subprocess:
//   - prompt arrives via stdin (no argv quoting hazards)
//   - `--output-format stream-json --verbose` yields NDJSON events
//   - `--settings` injects a generated permissions file (from Worker policy)
//   - CLAUDE_CONFIG_DIR isolates each worker's config/state
//   - credentials are injected via env (ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY)
//   - `--resume <sessionId>` keeps multi-turn conversations
// ---------------------------------------------------------------------------

import { spawn, execFile, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { PROJECT_ROOT, WORKERS_DIR, PRE_TOOL_USE_HOOK_PATH } from "../paths.ts";
import * as policyApi from "../services/policy-api.ts";
import type { AgentAdapter, AgentSession, AgentSessionOptions } from "./types.ts";
import { composePrompt } from "./prompt.ts";
import { claudeMcpConfig, shouldInject } from "./mcp-inject.ts";
import { killProcessTree } from "./proc.ts";
import type { AdapterCapabilities, AgentEvent, Worker } from "../../shared/types.ts";

const CAPABILITIES: AdapterCapabilities = {
  // 命令拦截依赖 PreToolUse hook，默认关闭（见 hooksEnabled）。
  // 此处不再谎报为 true —— 实际能力由 claudeCodeAdapter.capabilities 动态给出。
  toolLevelApproval: false,
  streamEvents: true,
  sandboxControl: true,      // permissions via --settings
  egressControl: false,      // not native; enforced process-level later
  costReporting: true,       // total_cost_usd in result event
  sessionResume: true,
};

/**
 * PreToolUse hook 开关。
 * 默认关闭：hook 配置一旦异常会导致 `claude -p` 启动失败，
 * 因此交由部署方显式开启（EAG_CLAUDE_HOOKS=1）。
 */
export function hooksEnabled(): boolean {
  return process.env.EAG_CLAUDE_HOOKS === "1";
}

const SEND_TIMEOUT_MS = 300_000;

/** Per-worker agent state dir: <root>/.eag/workers/<id>/agent */
function workerAgentDir(workerId: string): string {
  return path.join(WORKERS_DIR, workerId, "agent");
}

/** Normalize a policy path into a Claude permission-rule path (forward slashes). */
function rulePath(p: string): string {
  const norm = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const isAbsolute = /^([a-zA-Z]:\/|\/)/.test(norm);
  return isAbsolute ? `//${norm.replace(/^[a-zA-Z]:/, "").replace(/^\/+/, "")}` : norm;
}

/**
 * Translate Worker path policies into Claude Code permission rules.
 *   rw    → allow Edit/Write under the path
 *   r     → read-only (default: reads allowed, no write rules emitted)
 *   hidden→ deny Read under the path
 */
export function buildSettingsJson(worker: Worker, hookPath?: string): Record<string, unknown> {
  const allow: string[] = [];
  const deny: string[] = [];

  // 生效策略 = 全局默认（Policy 管理页）+ Worker 覆盖。
  // 此前只读 worker.config.policies，导致管理页配的规则对本引擎完全无效。
  const effective = policyApi.getEffectivePolicies(worker.config.policies);

  for (const policy of effective) {
    if (policy.access === "rw") {
      const rp = rulePath(policy.path);
      allow.push(`Edit(${rp}/**)`, `Write(${rp}/**)`);
    }
    if (policy.access === "hidden") {
      deny.push(`Read(${rulePath(policy.path)}/**)`);
    }
  }

  // EAG 治理代理的工具**预授权**。
  //
  // 治理（路径策略拦截 + 审计 + 预算）已经在代理侧执行，引擎侧不需要再拦一次；
  // 而 Claude 在非交互模式下对未授权的 MCP 工具会直接拒绝，表现为
  //   "Claude requested permissions to use mcp__eag-governed__xxx, but you haven't granted it yet."
  // —— Agent 因此完全调不动委派/知识库等内置能力（本机实测踩到）。
  if (shouldInject(worker)) {
    allow.push(
      "mcp__eag-governed", // 整台治理代理（含其聚合的外部 MCP server，工具名动态无法枚举）
      "mcp__eag-governed__agents__delegate",
      "mcp__eag-governed__agents__delegate_status",
      "mcp__eag-governed__knowledge__search",
    );
  }

  const settings: Record<string, unknown> = {
    permissions: { allow, deny },
  };

  // 命令拦截：Bash 工具调用前先过 EAG 命令策略
  if (hookPath) {
    settings.hooks = {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            { type: "command", command: `"${process.execPath}" "${hookPath}"` },
          ],
        },
      ],
    };
  }

  return settings;
}

/**
 * Env for the claude subprocess.
 *
 * Governed path (provider has an apiKey): EAG is the credential gateway —
 * config is isolated into the worker's own CLAUDE_CONFIG_DIR and credentials
 * are injected via env. The provider's baseUrl must be Anthropic-compatible.
 *
 * Fallback path (no apiKey): keep the ambient login untouched so the machine's
 * own `claude` auth works (dev / personal use).
 */
function buildClaudeEnv(agentDir: string, opts: AgentSessionOptions): Record<string, string> {
  const env: Record<string, string> = { ...process.env as Record<string, string> };

  const ref = opts.modelOverride;
  if (ref?.apiKey) {
    env.CLAUDE_CONFIG_DIR = agentDir;
    if (ref.baseUrl) env.ANTHROPIC_BASE_URL = ref.baseUrl;
    // AUTH_TOKEN (Bearer) — matches Anthropic-compatible gateways;
    // official Anthropic API also accepts it.
    env.ANTHROPIC_AUTH_TOKEN = ref.apiKey;
    env.ANTHROPIC_API_KEY = ref.apiKey;
  }
  return env;
}

// ---------------------------------------------------------------------------
// stream-json line parsing
// ---------------------------------------------------------------------------

interface ParsedEvent { sessionId?: string; events: AgentEvent[] }

/** Map one NDJSON line of `--output-format stream-json` to AgentEvents. */
export function parseStreamLine(line: string, pendingTools: Map<string, string>): ParsedEvent | null {
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return null; // tolerate partial/unknown lines
  }

  const out: ParsedEvent = { events: [] };

  switch (obj.type) {
    case "system": {
      if (obj.subtype === "init" && obj.session_id) out.sessionId = obj.session_id;
      return out;
    }

    case "assistant": {
      const content: any[] = obj.message?.content ?? [];
      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string") {
          out.events.push({ type: "text_delta", delta: block.text });
        } else if (block.type === "tool_use") {
          const id = typeof block.id === "string" ? block.id : "";
          if (id) pendingTools.set(id, block.name ?? "unknown");
          out.events.push({ type: "tool_start", toolName: block.name ?? "unknown", input: block.input });
        }
      }
      return out;
    }

    case "user": {
      const content: any[] = obj.message?.content ?? [];
      for (const block of content) {
        if (block.type === "tool_result") {
          const id = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
          const toolName = pendingTools.get(id) ?? "unknown";
          pendingTools.delete(id);
          const text = typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map((c: any) => c?.text ?? "").join("")
              : undefined;
          out.events.push({
            type: "tool_end",
            toolName,
            isError: block.is_error === true,
            content: text?.slice(0, 4000),
          });
        }
      }
      return out;
    }

    case "result": {
      if (typeof obj.total_cost_usd === "number" && obj.total_cost_usd > 0) {
        out.events.push({ type: "cost", totalCostUsd: obj.total_cost_usd, usage: obj.usage });
      }
      out.events.push({
        type: "agent_end",
        sessionId: typeof obj.session_id === "string" ? obj.session_id : undefined,
        success: obj.is_error !== true,
      });
      return out;
    }

    default:
      return out; // stream_event / api_retry / unknown → no events
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

class ClaudeCodeSession implements AgentSession {
  private sessionId: string | undefined;
  private child: ChildProcess | undefined;

  constructor(
    private readonly worker: Worker,
    private readonly opts: AgentSessionOptions,
  ) {}

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  async *send(text: string): AsyncIterableIterator<AgentEvent> {
    const agentDir = workerAgentDir(this.worker.id);
    fs.mkdirSync(agentDir, { recursive: true });

    // Generate the governed settings file for this worker.
    const settingsPath = path.join(agentDir, "claude-settings.json");
    const settings = buildSettingsJson(
      this.worker,
      hooksEnabled() ? PRE_TOOL_USE_HOOK_PATH : undefined,
    );
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");

    const args: string[] = [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--settings", JSON.stringify(settingsPath),
      "--max-turns", "40",
    ];
    if (this.opts.modelOverride?.modelName) {
      args.push("--model", this.opts.modelOverride.modelName);
    }
    if (this.sessionId) {
      args.push("--resume", this.sessionId);
    }

    // 计划模式：引擎级只读（Claude 只允许读与规划，不写文件）——
    // 不依赖模型自觉，治理约束落在引擎权限上。
    if (this.opts.planOnly) {
      args.push("--permission-mode", "plan");
    }

    // MCP：注入 EAG 治理代理（存在启用中的 server 且代理产物已构建时）。
    // 注入的是代理而非原始 server —— 引擎侧调用同样过策略与审计。
    const mcpConfig = claudeMcpConfig(this.worker, this.opts);
    if (mcpConfig) {
      const mcpConfigPath = path.join(agentDir, "mcp-config.json");
      fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), "utf-8");
      args.push("--mcp-config", mcpConfigPath);
    }

    const child = spawn("claude", args, {
      shell: true, // Windows: resolves the claude.cmd shim
      cwd: this.opts.cwd ?? PROJECT_ROOT,
      env: buildClaudeEnv(agentDir, this.opts),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    // Prompt goes through stdin — no argv quoting issues.
    child.stdin?.write(composePrompt(this.worker.config.systemPrompt, text));
    child.stdin?.end();

    const pendingTools = new Map<string, string>();
    let stderrBuf = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      if (stderrBuf.length > 8000) stderrBuf = stderrBuf.slice(-8000);
    });

    const timeout = setTimeout(() => {
      // 进程树终止：shell 包装下 kill(cmd) 会留下孤儿引擎并吊住 stdout
      killProcessTree(child);
    }, SEND_TIMEOUT_MS);

    try {
      const rl = readline.createInterface({ input: child.stdout! });
      for await (const line of rl) {
        if (!line.trim()) continue;
        const parsed = parseStreamLine(line, pendingTools);
        if (!parsed) continue;
        if (parsed.sessionId) this.sessionId = parsed.sessionId;
        for (const ev of parsed.events) {
          if (ev.type === "agent_end" && ev.sessionId) this.sessionId = ev.sessionId;
          yield ev;
        }
      }
      rl.close();

      const code = await new Promise<number | null>((resolve) => {
        child.once("exit", (c) => resolve(c));
        if (child.exitCode !== null) resolve(child.exitCode);
      });

      if (code !== 0) {
        yield { type: "error", message: stderrBuf.trim() || `claude exited with code ${code}` };
        yield { type: "agent_end", sessionId: this.sessionId, success: false };
      }
    } finally {
      clearTimeout(timeout);
      this.child = undefined;
    }
  }

  async stop(): Promise<void> {
    killProcessTree(this.child);
    this.child = undefined;
  }

  async dispose(): Promise<void> {
    await this.stop();
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const claudeCodeAdapter: AgentAdapter = {
  kind: "claude-code",
  displayName: "Claude Code",
  // 动态反映真实能力：开启 hook 后才具备命令级拦截
  get capabilities(): AdapterCapabilities {
    return { ...CAPABILITIES, toolLevelApproval: hooksEnabled() };
  },

  detect(): Promise<{ installed: boolean; version?: string }> {
    return new Promise((resolve) => {
      execFile("claude", ["--version"], { shell: true, timeout: 8000 }, (err, stdout) => {
        if (err) {
          resolve({ installed: false });
          return;
        }
        resolve({ installed: true, version: stdout.trim() });
      });
    });
  },

  async startSession(worker: Worker, opts: AgentSessionOptions): Promise<AgentSession> {
    return new ClaudeCodeSession(worker, opts);
  },
};
