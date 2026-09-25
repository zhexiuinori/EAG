import * as fs from "node:fs";
import type { AppConfig, ModelProvider, ModelProviderTestInput, ModelProviderTestResult } from "../../shared/types.ts";
import { CONFIG_PATH, DEFAULT_AUDIT_DIR } from "../paths.ts";
import { loadDotEnv } from "./dotenv.ts";

// 必须在构造 DEFAULTS 之前载入，否则 ${EAG_API_KEY_*} 解析为空
loadDotEnv();

const DEFAULT_PROVIDERS: ModelProvider[] = [
  {
    id: "ollama-local",
    name: "Ollama (Local)",
    type: "ollama",
    baseUrl: "http://localhost:11434",
    models: ["llama3.2", "qwen2.5", "mistral", "codellama"],
    activeModel: "llama3.2",
    isDefault: true,
  },
  {
    id: "openai",
    name: "OpenAI",
    type: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"],
    activeModel: "gpt-4o-mini",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    type: "deepseek",
    baseUrl: "https://api.deepseek.com",
    apiKey: "",
    models: ["deepseek-chat", "deepseek-reasoner"],
    activeModel: "deepseek-chat",
  },
];

const DEFAULTS: AppConfig = {
  providers: DEFAULT_PROVIDERS,
  activeProviderId: "ollama-local",
  searchProxy: process.env.EAG_SEARCH_PROXY || "",
  auditDir: process.env.EAG_AUDIT_DIR || DEFAULT_AUDIT_DIR,
  maxWorkers: Number(process.env.EAG_SWARM_MAX_WORKERS) || 5,
  taskTimeoutMs: Number(process.env.EAG_SWARM_TASK_TIMEOUT_MS) || 600_000,
};

// ---------------------------------------------------------------------------
// Secret interpolation — 支持 "${ENV_VAR}" 占位符，密钥不进版本库
// ---------------------------------------------------------------------------

const ENV_PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function resolveSecretString(value: string): string {
  return value.replace(ENV_PLACEHOLDER, (_m, name: string) => process.env[name] ?? "");
}

function resolveSecrets<T>(value: T): T {
  if (typeof value === "string") return resolveSecretString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => resolveSecrets(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = resolveSecrets(v);
    return out as T;
  }
  return value;
}

function isPlaceholder(v: unknown): v is string {
  return typeof v === "string" && /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(v);
}

/** 读取磁盘原始配置（不插值），用于写回时保留 "${...}" 占位符。 */
function readRawConfig(): AppConfig {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) } as AppConfig;
  } catch {
    return DEFAULTS;
  }
}

/**
 * 若 UI 回传的 apiKey 与磁盘占位符解析后的值一致，则保留占位符，
 * 避免把明文密钥写回配置文件（Settings / Models 页会提交完整 config 对象）。
 */
function preservePlaceholders(raw: AppConfig, next: AppConfig): AppConfig {
  const rawById = new Map(raw.providers.map((p) => [p.id, p]));
  return {
    ...next,
    providers: next.providers.map((p) => {
      const prev = rawById.get(p.id);
      if (prev && isPlaceholder(prev.apiKey) && resolveSecretString(prev.apiKey) === p.apiKey) {
        return { ...p, apiKey: prev.apiKey };
      }
      return p;
    }),
  };
}

export function getConfig(): AppConfig {
  return resolveSecrets(readRawConfig());
}

export function updateConfig(partial: Partial<AppConfig>): void {
  const raw = readRawConfig();
  const merged = preservePlaceholders(raw, { ...raw, ...partial });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), "utf-8");
  if (merged.searchProxy) process.env.EAG_SEARCH_PROXY = merged.searchProxy;
  if (merged.auditDir) process.env.EAG_AUDIT_DIR = merged.auditDir;
}

export async function testProvider(input: ModelProviderTestInput): Promise<ModelProviderTestResult> {
  const start = Date.now();
  try {
    const base = input.baseUrl.replace(/\/+$/, "");

    // Anthropic 协议（/v1/messages）—— 与 claude-code adapter 注入的
    // ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN 保持一致。
    if (input.type === "anthropic") {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      };
      if (input.apiKey) {
        headers["x-api-key"] = input.apiKey;
        headers["Authorization"] = `Bearer ${input.apiKey}`;
      }
      const res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: input.model,
          max_tokens: 5,
          messages: [{ role: "user", content: "hi" }],
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { success: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
      }
      return { success: true, latencyMs: Date.now() - start };
    }

    // Ollama 与 OpenAI 兼容协议（/v1/chat/completions）
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (input.apiKey) headers["Authorization"] = `Bearer ${input.apiKey}`;

    const isOllama = input.type === "ollama";
    const url = isOllama ? `${base}/api/generate` : `${base}/chat/completions`;
    const body = isOllama
      ? JSON.stringify({ model: input.model, prompt: "hi", stream: false })
      : JSON.stringify({ model: input.model, messages: [{ role: "user", content: "hi" }], max_tokens: 5 });

    const res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { success: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    return { success: true, latencyMs: Date.now() - start };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}
