// ---------------------------------------------------------------------------
// EAG — Pi adapter (legacy)
//
// Migrated verbatim from worker-service.ts: spawns the Pi CLI with the EAG
// governance extension injected. Kept as the reference implementation of
// full governance injection; new workers should prefer claude-code / codex.
// ---------------------------------------------------------------------------

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PROJECT_ROOT, WORKERS_DIR } from "../paths.ts";
import * as configApi from "../services/config-api.ts";
import { getSession } from "../services/user-service.ts";
import type { AgentAdapter, AgentSession, AgentSessionOptions } from "./types.ts";
import { composePrompt } from "./prompt.ts";
import type { AdapterCapabilities, AgentEvent, ResolvedModelRef, Worker } from "../../shared/types.ts";

const PI_BIN = process.execPath;
const PI_MODULE = path.join(PROJECT_ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
const PI_ENTRY = path.join(PI_MODULE, "dist", "bundle", "cli.js");
const EXTENSION_PATH = path.join(PROJECT_ROOT, "src", "extension", "index.ts");

// Pi stores its model registry at ~/.pi/agent/models.json (user-level).
const PI_AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const PI_MODELS_PATH = path.join(PI_AGENT_DIR, "models.json");

const CAPABILITIES: AdapterCapabilities = {
  toolLevelApproval: true,   // EAG governance extension intercepts tool calls
  streamEvents: false,       // --print mode: full output at end
  sandboxControl: true,      // extension fs-gate
  egressControl: true,       // extension egress whitelist
  costReporting: false,
  sessionResume: false,
};

const SEND_TIMEOUT_MS = 120_000;

/** Map an EAG provider type to the API dialect Pi expects in models.json. */
function piApiForType(type: string): string {
  switch (type) {
    case "anthropic": return "anthropic-messages";
    case "openai": return "openai-completions";
    case "deepseek": return "openai-completions";
    case "ollama": return "ollama";
    case "custom":
    default:
      return "openai-chat";
  }
}

/**
 * Mirror an EAG-configured provider into Pi's model registry so
 * `--model <provider>/<model>` resolves at Pi boot.
 */
export function syncProviderToPi(providerId: string): void {
  const config = configApi.getConfig();
  const provider = config.providers.find((p) => p.id === providerId);
  if (!provider) return;

  try {
    let registry: { providers: Record<string, unknown> } = { providers: {} };
    try {
      registry = JSON.parse(fs.readFileSync(PI_MODELS_PATH, "utf-8")) as { providers: Record<string, unknown> };
    } catch {
      // File may not exist yet — start fresh.
    }

    const models = (provider.models ?? []).map((m) => ({
      id: m,
      name: m,
      input: ["text"],
      contextWindow: 128000,
      maxTokens: 8192,
    }));

    registry.providers[provider.id] = {
      name: provider.name || provider.id,
      baseUrl: provider.baseUrl,
      api: piApiForType(provider.type),
      apiKey: provider.apiKey ?? "",
      models,
    };

    fs.mkdirSync(PI_AGENT_DIR, { recursive: true });
    fs.writeFileSync(PI_MODELS_PATH, JSON.stringify(registry, null, 2), "utf-8");
  } catch (err: any) {
    console.error(`[pi-adapter] Failed to sync provider into Pi registry:`, err?.message ?? err);
  }
}

/** Build Pi CLI flags from a Worker's config + EAG governance. */
export function buildPiArgs(worker: Worker, ref: ResolvedModelRef): string[] {
  return [
    "--print",
    "--no-extensions",
    "-e", EXTENSION_PATH,
    "--exclude-tools", "bash,powershell",
    "--model", `${ref.providerId}/${ref.modelName}`,
  ];
}

export function buildPiEnv(worker: Worker, ref: ResolvedModelRef): Record<string, string> {
  return {
    ...process.env as Record<string, string>,
    // 审计身份 = 实际操作者（当前会话用户），而非 worker.assignedTo —
    // project / 组共享的 Agent 被他人使用时，追责必须指向真实操作人。
    EAG_USER_ID: getSession().userId || worker.assignedTo,
    EAG_WORKER_ID: worker.id,
    EAG_ROOT: PROJECT_ROOT,
    PI_OFFLINE: "1",
    EAG_MODEL_BASE_URL: ref.baseUrl,
    EAG_MODEL_API_KEY: ref.apiKey ?? "",
    EAG_MODEL_PROVIDER: ref.providerName,
    EAG_MODEL_NAME: ref.modelName,
    PI_CODING_AGENT_DIR: path.join(WORKERS_DIR, worker.id, "agent"),
    // Worker 级策略覆盖：治理扩展读取后与全局策略合并，
    // 使 Pi 引擎也能应用 Worker 表单里配置的规则。
    EAG_POLICY_OVERRIDE: worker.config.policies?.length
      ? JSON.stringify(worker.config.policies)
      : "",
  };
}

class PiSession implements AgentSession {
  private child: ChildProcess | undefined;

  getSessionId(): string | undefined {
    return undefined;
  }

  async *send(text: string): AsyncIterableIterator<AgentEvent> {
    const worker = this.opts.worker;
    const ref = this.opts.modelOverride;
    if (!worker || !ref) {
      yield { type: "error", message: "Pi session requires worker and model reference" };
      return;
    }

    syncProviderToPi(ref.providerId);

    const agentDir = path.join(WORKERS_DIR, worker.id, "agent");
    fs.mkdirSync(agentDir, { recursive: true });

    const child = spawn(PI_BIN, [PI_ENTRY, ...buildPiArgs(worker, ref)], {
      stdio: ["pipe", "pipe", "pipe"],
      env: buildPiEnv(worker, ref),
      cwd: this.opts.cwd ?? PROJECT_ROOT,
    });
    this.child = child;

    let stdoutBuf = "";
    let stderrBuf = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdoutBuf += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderrBuf += chunk.toString(); });

    child.stdin?.write(composePrompt(worker.config.systemPrompt, text));
    child.stdin?.end();

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, SEND_TIMEOUT_MS);

    const code = await new Promise<number | null>((resolve) => {
      child.once("exit", resolve);
      if (child.exitCode !== null) resolve(child.exitCode);
    });
    clearTimeout(timer);
    this.child = undefined;

    if (code === 0 && stdoutBuf.trim()) {
      yield { type: "text_delta", delta: stdoutBuf.trim() };
      yield { type: "agent_end", success: true };
    } else {
      yield { type: "error", message: stderrBuf.trim() || `Pi exited with code ${code}` };
      yield { type: "agent_end", success: false };
    }
  }

  async stop(): Promise<void> {
    this.child?.kill("SIGTERM");
    this.child = undefined;
  }

  async dispose(): Promise<void> {
    await this.stop();
  }

  constructor(
    private readonly opts: { worker: Worker } & AgentSessionOptions,
  ) {}
}

export const piAdapter: AgentAdapter = {
  kind: "pi",
  displayName: "Pi (legacy)",
  capabilities: CAPABILITIES,

  async detect(): Promise<{ installed: boolean; version?: string }> {
    return { installed: fs.existsSync(PI_ENTRY), version: "bundled" };
  },

  async startSession(worker: Worker, opts: AgentSessionOptions): Promise<AgentSession> {
    return new PiSession({ ...opts, worker });
  },
};
