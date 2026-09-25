// ---------------------------------------------------------------------------
// EAG — Codex adapter
//
// Drives `codex exec` (headless) as a governed worker subprocess:
//   - prompt arrives via stdin (`codex exec -`)
//   - `--json` yields NDJSON events on stdout (thread/turn/item/error)
//   - CODEX_HOME isolates each worker's state into .eag/workers/<id>/agent
//   - 受治理路径写 $CODEX_HOME/config.toml（网关 provider + MCP 治理代理 + 沙箱）；
//     不用 -c key=value，因为 cmd.exe 会吞掉值里的内层引号（会把数组变成字符串）
//   - `--sandbox read-only|workspace-write` maps Worker path policies
//   - credentials injected via env (OPENAI_API_KEY)
//   - `codex exec resume <thread_id>` keeps multi-turn conversations
// ---------------------------------------------------------------------------

import { spawn, execFile, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { PROJECT_ROOT, WORKERS_DIR } from "../paths.ts";
import * as policyApi from "../services/policy-api.ts";
import type { AgentAdapter, AgentSession, AgentSessionOptions } from "./types.ts";
import { composePrompt } from "./prompt.ts";
import { proxyCommand, shouldInject } from "./mcp-inject.ts";
import { killProcessTree } from "./proc.ts";
import type { AdapterCapabilities, AgentEvent, ResolvedModelRef, Worker } from "../../shared/types.ts";

const CAPABILITIES: AdapterCapabilities = {
  // Codex CLI 未暴露可用的命令级拦截钩子，暂不支持；
  // 它的命令执行只能被观测（verdict=observed），不能阻断。
  toolLevelApproval: false,
  streamEvents: true,       // --json NDJSON
  sandboxControl: true,     // --sandbox + config overrides
  egressControl: true,      // network_proxy domains whitelist
  costReporting: true,      // turn.completed carries token usage
  sessionResume: true,      // codex exec resume <thread_id>
};

const SEND_TIMEOUT_MS = 300_000;

/** Per-worker agent state dir: <root>/.eag/workers/<id>/agent */
function workerAgentDir(workerId: string): string {
  return path.join(WORKERS_DIR, workerId, "agent");
}

/**
 * Map Worker path policies to a codex sandbox mode.
 *   any rw policy → workspace-write (writes allowed in cwd)
 *   otherwise     → read-only
 */
function sandboxModeFor(worker: Worker): "read-only" | "workspace-write" {
  // 用合并后的生效策略（全局 + Worker），而不是仅 Worker 级
  const hasWrite = policyApi
    .getEffectivePolicies(worker.config.policies)
    .some((p) => p.access === "rw");
  return hasWrite ? "workspace-write" : "read-only";
}

/**
 * Env for the codex subprocess.
 *
 * Governed path (provider has an apiKey): EAG is the credential gateway —
 * state is isolated via CODEX_HOME and the provider key is injected via env.
 * An OpenAI-compatible gateway can be set through the provider's baseUrl.
 *
 * Fallback path (no apiKey): keep ambient login so the machine's own
 * `codex` auth works (dev / personal use).
 */
function buildCodexEnv(agentDir: string, opts: AgentSessionOptions): Record<string, string> {
  const env: Record<string, string> = { ...process.env as Record<string, string> };

  const ref = opts.modelOverride;
  if (ref?.apiKey) {
    env.CODEX_HOME = agentDir;
    env.OPENAI_API_KEY = ref.apiKey;
    // OpenAI-compatible gateway override (empty base URL = official API).
    if (ref.baseUrl) {
      env.OPENAI_BASE_URL = ref.baseUrl;
      env.CODEX_API_BASE_URL = ref.baseUrl;
    }
  }
  return env;
}

/** TOML 基本字符串转义（Windows 路径含反斜杠，必须转义）。 */
function tomlStr(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * 写入 $CODEX_HOME/config.toml：沙箱、模型网关 provider、MCP 治理代理。
 *
 * 为什么用配置文件而不是 `-c key=value`：
 *   1. **cmd.exe 会吃掉 -c 值里的内层引号** —— `mcp_servers.eag.args=["..."]`
 *      会变成字符串 `"[...]"`，codex 报 "expected a sequence" 后直接退出
 *      （本机实测踩到，表现为 Agent 秒退且没有任何输出）。
 *   2. codex 0.147+ 不再读 OPENAI_BASE_URL 环境变量，网关必须写成 provider 配置，
 *      否则请求会打到 api.openai.com（表现为 "Reconnecting... request timed out"，
 *      排查时极具误导性）。
 *
 * CODEX_HOME 已隔离到该 worker 的 agent 目录，所以这份 config.toml 就是它眼中的
 * "用户配置"，不需要 --ignore-user-config（该标志会把我们自己的配置也忽略掉）。
 */
function writeCodexConfig(
  agentDir: string,
  input: { reference: ResolvedModelRef; sandbox: string; worker: Worker; opts: AgentSessionOptions },
): void {
  const lines: string[] = [
    `sandbox_mode = ${tomlStr(input.sandbox)}`,
    `model_provider = "eag-gateway"`,
    ``,
    `[model_providers.eag-gateway]`,
    `name = "EAG Gateway"`,
    `base_url = ${tomlStr(input.reference.baseUrl)}`,
    `env_key = "OPENAI_API_KEY"`,
    // 该版本 codex 已移除 chat wire，只支持 responses
    `wire_api = "responses"`,
  ];

  // MCP：注入 EAG 治理代理（引擎侧每次工具调用都过策略与审计）
  if (shouldInject(input.worker)) {
    const proxy = proxyCommand(input.worker, input.opts);
    lines.push(``, `[mcp_servers.eag]`, `command = ${tomlStr(proxy.command)}`);
    lines.push(`args = [${proxy.args.map(tomlStr).join(", ")}]`);
    const envPairs = Object.entries(proxy.env).filter(([, v]) => v);
    if (envPairs.length > 0) {
      lines.push(``, `[mcp_servers.eag.env]`);
      for (const [k, v] of envPairs) lines.push(`${k} = ${tomlStr(v)}`);
    }
  }

  fs.writeFileSync(path.join(agentDir, "config.toml"), lines.join("\n") + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// JSONL line parsing
// ---------------------------------------------------------------------------

interface ParsedEvent { threadId?: string; events: AgentEvent[] }

/**
 * Map one NDJSON line of `codex exec --json` to AgentEvents.
 * Event kinds (verified against codex 0.147.0):
 *   thread.started / turn.started / item.completed / error /
 *   turn.completed / turn.failed
 */
export function parseJsonlLine(line: string): ParsedEvent | null {
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return null; // tolerate partial/unknown lines
  }

  const out: ParsedEvent = { events: [] };

  switch (obj.type) {
    case "thread.started": {
      if (typeof obj.thread_id === "string") out.threadId = obj.thread_id;
      return out;
    }

    case "turn.started": {
      return out; // no mapped event; agent_end carries turn outcome
    }

    case "item.completed": {
      const item = obj.item ?? {};
      switch (item.type) {
        case "agent_message": {
          if (typeof item.text === "string" && item.text) {
            out.events.push({ type: "text_delta", delta: item.text });
          }
          return out;
        }
        case "command_execution":
        case "file_change":
        case "mcp_tool_call":
        case "web_search": {
          // Tool-shaped items: surface start immediately, result inline.
          const toolName = item.type;
          out.events.push({ type: "tool_start", toolName, input: item });
          out.events.push({
            type: "tool_end",
            toolName,
            isError: item.status === "failed",
            content: typeof item.output === "string" ? item.output.slice(0, 4000) : undefined,
          });
          return out;
        }
        default:
          return out; // reasoning / unknown item types → no events
      }
    }

    case "error": {
      const message = typeof obj.message === "string" ? obj.message : JSON.stringify(obj);
      // Reconnect notices are transient; only surface terminal failures.
      if (!/^Reconnecting\.\.\./.test(message)) {
        // Surface as text too so the chat reply carries the failure reason
        // (matching how claude-code reports API errors in its stream).
        out.events.push({ type: "text_delta", delta: `Error: ${message}` });
        out.events.push({ type: "error", message });
      }
      return out;
    }

    case "turn.completed": {
      const usage = obj.usage ?? undefined;
      out.events.push({ type: "cost", usage });
      out.events.push({ type: "agent_end", sessionId: undefined, success: true });
      return out;
    }

    case "turn.failed": {
      const message = obj.error?.message ?? "turn failed";
      // The terminal error event already surfaced this message as text;
      // avoid duplicating it in the reply.
      out.events.push({ type: "error", message });
      out.events.push({ type: "agent_end", sessionId: undefined, success: false });
      return out;
    }

    default:
      return out;
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

class CodexSession implements AgentSession {
  private threadId: string | undefined;
  private child: ChildProcess | undefined;

  constructor(
    private readonly worker: Worker,
    private readonly opts: AgentSessionOptions,
  ) {}

  getSessionId(): string | undefined {
    return this.threadId;
  }

  async *send(text: string): AsyncIterableIterator<AgentEvent> {
    const agentDir = workerAgentDir(this.worker.id);
    fs.mkdirSync(agentDir, { recursive: true });

    // 计划模式：强制只读沙箱（与 Claude 的 --permission-mode plan 语义对齐）
    const sandbox = this.opts.planOnly ? "read-only" : sandboxModeFor(this.worker);
    const ref = this.opts.modelOverride;
    // 受治理路径（有密钥 + 网关地址）：沙箱/网关/MCP 全部走 config.toml
    const governed = !!ref?.apiKey && !!ref?.baseUrl;
    if (governed) {
      writeCodexConfig(agentDir, { reference: ref!, sandbox, worker: this.worker, opts: this.opts });
    }

    const args: string[] = [
      "exec",
      "--json",
      "--skip-git-repo-check",
      // 仅"用机器自身 codex 登录"的回退路径需要忽略用户配置；
      // 受治理路径必须读取我们写入的 $CODEX_HOME/config.toml
      ...(governed ? [] : ["--ignore-user-config"]),
      "-",
    ];
    if (this.opts.modelOverride?.modelName) {
      args.push("-m", this.opts.modelOverride.modelName);
    }

    if (this.threadId) {
      // Multi-turn: resume the previous thread.
      args.push("--resume", this.threadId);
    }

    const child = spawn("codex", args, {
      shell: true, // Windows: resolves the codex.cmd shim
      cwd: this.opts.cwd ?? PROJECT_ROOT,
      env: buildCodexEnv(agentDir, this.opts),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    // Prompt goes through stdin — no argv quoting issues.
    child.stdin?.write(composePrompt(this.worker.config.systemPrompt, text));
    child.stdin?.end();

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
        const parsed = parseJsonlLine(line);
        if (!parsed) continue;
        if (parsed.threadId) this.threadId = parsed.threadId;
        for (const ev of parsed.events) {
          yield ev;
        }
      }
      rl.close();

      const code = await new Promise<number | null>((resolve) => {
        child.once("exit", (c) => resolve(c));
        if (child.exitCode !== null) resolve(child.exitCode);
      });

      if (code !== 0) {
        yield { type: "error", message: stderrBuf.trim() || `codex exited with code ${code}` };
        yield { type: "agent_end", sessionId: this.threadId, success: false };
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

export const codexAdapter: AgentAdapter = {
  kind: "codex",
  displayName: "Codex",
  capabilities: CAPABILITIES,

  detect(): Promise<{ installed: boolean; version?: string }> {
    return new Promise((resolve) => {
      execFile("codex", ["--version"], { shell: true, timeout: 8000 }, (err, stdout) => {
        if (err) {
          resolve({ installed: false });
          return;
        }
        resolve({ installed: true, version: stdout.trim() });
      });
    });
  },

  async startSession(worker: Worker, opts: AgentSessionOptions): Promise<AgentSession> {
    return new CodexSession(worker, opts);
  },
};
