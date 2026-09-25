// ---------------------------------------------------------------------------
// EAG — 配置体检（Provider 连通性 + Agent 可运行性）
//
// 起因："Agent 跑不起来"十有八九不是 EAG 的问题，而是**模型端点不可达**或
// **没配密钥** —— 而界面上只能看到一个笼统的引擎报错，只能靠猜。
//
// 这里做一次**非计费**探测（只 GET 模型列表/健康端点，不发起对话），并把结论
// 按"修法不同"分类：网络层（DNS/拒连/超时/TLS 握手）、鉴权层（缺密钥/密钥被拒）、
// 端点层（路径 404）。再把 provider 状态与引擎安装情况合并，直接回答
// "这个 Agent 现在能不能跑、不能跑是卡在哪一步"。
// ---------------------------------------------------------------------------

import * as configApi from "./config-api.ts";
import * as workerService from "./worker-service.ts";
import { listAdapterStatus } from "../adapters/registry.ts";
import type {
  ModelProvider, ProviderHealth, ProviderHealthStatus, ProviderHealthResult,
  WorkerReadiness, AgentKind,
} from "../../shared/types.ts";

/** 单次探测超时：体检要快，慢端点直接判"超时"（那本身就是结论）。 */
const PROBE_TIMEOUT_MS = 4000;

// ---------------------------------------------------------------------------
// 错误归类
// ---------------------------------------------------------------------------

/** 从 fetch 抛出的错误里挖出最有用的一层（undici 把真实原因藏在 cause 链里）。 */
function rootCause(e: any): { code: string; message: string } {
  let cur = e;
  for (let i = 0; i < 5 && cur; i++) {
    if (cur.code) return { code: String(cur.code), message: String(cur.message ?? "") };
    cur = cur.cause;
  }
  const msg = String(e?.message ?? e);
  if (/timeout|abort/i.test(msg)) return { code: "TIMEOUT", message: msg };
  return { code: "UNKNOWN", message: msg };
}

/** 每一类网络故障指向不同的修法 —— 这是体检的核心价值。 */
function explainNetwork(code: string, message: string): string {
  const s = `${code} ${message}`;
  if (/ENOTFOUND|EAI_AGAIN/i.test(s)) {
    return "域名解析失败（DNS）：检查 baseUrl 是否拼错，或本机 DNS 设置";
  }
  if (/ECONNREFUSED/i.test(s)) {
    return "连接被拒绝：该端口没有服务在监听（本地服务未启动，或被防火墙拦截）";
  }
  if (/TIMEOUT|ETIMEDOUT|CONNECT_TIMEOUT/i.test(s)) {
    return "连接超时：网络不可达。访问境外端点通常需要代理（Settings → searchProxy / 环境变量 HTTPS_PROXY）";
  }
  if (/SSL|CERT|TLS|HANDSHAKE|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(s)) {
    return "TLS 握手失败：常见于中间设备/代理干扰，或域名被拦截";
  }
  return `网络错误：${message.slice(0, 160)}`;
}

// ---------------------------------------------------------------------------
// 探测
// ---------------------------------------------------------------------------

const normBase = (u: string) => (u || "").trim().replace(/\/+$/, "");

function authHeaders(p: ModelProvider): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (p.apiKey) {
    h.Authorization = `Bearer ${p.apiKey}`;
    if (p.type === "anthropic") {
      h["x-api-key"] = p.apiKey;
      h["anthropic-version"] = "2023-06-01";
    }
  }
  return h;
}

/** 从列表响应里数出模型条数（OpenAI 风格 data[] / 其他 models[]），失败返回 undefined。 */
async function countModels(res: Response): Promise<number | undefined> {
  try {
    const body: any = await res.json();
    if (Array.isArray(body?.data)) return body.data.length;
    if (Array.isArray(body?.models)) return body.models.length;
  } catch {
    // 非 JSON 或结构不同：不影响结论
  }
  return undefined;
}

/** 探测一个 Provider（不产生费用）。 */
async function probeProvider(p: ModelProvider): Promise<ProviderHealth> {
  const base = normBase(p.baseUrl);
  const hasKey = !!p.apiKey;
  const mk = (patch: Partial<ProviderHealth> & { status: ProviderHealthStatus; message: string }): ProviderHealth => ({
    providerId: p.id,
    name: p.name,
    type: p.type,
    baseUrl: base,
    hasKey,
    ...patch,
  });

  if (!base) return mk({ status: "error", message: "baseUrl 为空：请补全端点地址" });

  // ---- 1) 网络层：GET 根地址（不带鉴权，任何 HTTP 状态码都说明网络可达）----
  const t0 = Date.now();
  try {
    await fetch(base, { method: "GET", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch (e: any) {
    const rc = rootCause(e);
    // 两个问题同时存在时一并说清：修完网络还需要补密钥
    const extra = hasKey ? "" : "；另外该 Provider 未配置 API 密钥";
    return mk({ status: "unreachable", message: explainNetwork(rc.code, rc.message) + extra, probe: base, latencyMs: Date.now() - t0 });
  }
  const latencyMs = Date.now() - t0;

  // ---- 2) Ollama：原生 /api/tags（不需要密钥）----
  if (p.type === "ollama") {
    const url = `${base}/api/tags`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      if (res.ok) {
        const count = await countModels(res);
        return mk({ status: "ok", httpStatus: res.status, latencyMs, modelCount: count, probe: url, message: count != null ? `正常，检测到 ${count} 个本地模型` : "正常" });
      }
      return mk({ status: "bad-endpoint", httpStatus: res.status, latencyMs, probe: url, message: `Ollama 接口异常（HTTP ${res.status}）：确认 baseUrl 指向 Ollama 根地址（如 http://localhost:11434）` });
    } catch (e: any) {
      const rc = rootCause(e);
      return mk({ status: "unreachable", message: explainNetwork(rc.code, rc.message), probe: url, latencyMs });
    }
  }

  // ---- 3) 云端 Provider：缺密钥是**最常见的坑**，单独成一类 ----
  if (!hasKey) {
    return mk({
      status: "no-key",
      latencyMs,
      probe: base,
      message: "端点可达，但未配置 API 密钥：引擎不会注入鉴权头，会回落到厂商默认端点（通常不可达）—— 请补密钥",
    });
  }

  // ---- 4) 鉴权 + 端点路径：GET 模型列表（非计费）----
  const candidates = base.includes("/v1")
    ? [`${base}/models`]
    : [`${base}/v1/models`, `${base}/models`]; // 有的服务把 /models 挂在根上
  let lastStatus = 0;
  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers: authHeaders(p), signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      lastStatus = res.status;
      if (res.ok) {
        const count = await countModels(res);
        return mk({ status: "ok", httpStatus: res.status, latencyMs, modelCount: count, probe: url, message: count != null ? `正常，可用模型 ${count} 个` : "正常" });
      }
      if (res.status === 401 || res.status === 403) {
        return mk({ status: "unauthorized", httpStatus: res.status, latencyMs, probe: url, message: `密钥被拒绝（HTTP ${res.status}）：检查密钥是否有效/过期/写错` });
      }
      if (res.status === 404) continue; // 换个候选路径再试
      const text = await res.text().catch(() => "");
      return mk({ status: "error", httpStatus: res.status, latencyMs, probe: url, message: `HTTP ${res.status}：${text.slice(0, 160)}` });
    } catch (e: any) {
      const rc = rootCause(e);
      return mk({ status: "unreachable", message: explainNetwork(rc.code, rc.message), probe: url, latencyMs });
    }
  }

  return mk({
    status: "bad-endpoint",
    httpStatus: lastStatus,
    latencyMs,
    probe: candidates[candidates.length - 1],
    message: `端点路径不对（HTTP ${lastStatus}）：baseUrl 应指向 API 根，如 https://api.openai.com/v1`,
  });
}

// ---------------------------------------------------------------------------
// 对外：体检
// ---------------------------------------------------------------------------

export async function healthCheck(): Promise<ProviderHealthResult> {
  const cfg = configApi.getConfig();

  // 并发探测：单个慢端点不会拖累整体
  const providers = await Promise.all((cfg.providers ?? []).map((p) => probeProvider(p)));
  const byId = new Map(providers.map((h) => [h.providerId, h]));

  const adapters = await listAdapterStatus();
  const adapterByKind = new Map(adapters.map((a) => [a.kind, a]));

  // 默认 Provider 兜底链：Worker 指定 → 全局 active → 标记 default 的
  const fallbackId =
    cfg.activeProviderId ||
    (cfg.providers ?? []).find((p) => p.isDefault)?.id;

  const workers: WorkerReadiness[] = workerService.listWorkers().map((w) => {
    const kind: AgentKind = w.config.agentKind ?? "pi";
    const adapter = adapterByKind.get(kind);
    const engineInstalled = !!adapter?.installed;

    const providerId = w.config.modelProviderId || fallbackId;
    const ph = providerId ? byId.get(providerId) : undefined;
    const providerName = providerId
      ? ((cfg.providers ?? []).find((p) => p.id === providerId)?.name ?? providerId)
      : undefined;

    const blockers: string[] = [];
    if (!adapter) blockers.push(`引擎「${kind}」无适配器（尚未支持）`);
    else if (!engineInstalled) blockers.push(`${adapter.displayName} CLI 未安装（PATH 中未检测到）`);

    if (!providerId) blockers.push("未指定 Provider，且没有全局默认可回退");
    else if (!ph) blockers.push(`Provider「${providerId}」配置不存在（可能已被删除）`);
    else {
      // 注：Worker 未显式指定 Provider 时用默认兜底，这不算阻塞
      //（可运行行会显示实际使用的 Provider 名，避免"我没配为什么在跑"的困惑）
      switch (ph.status) {
        case "ok":
          break;
        case "no-key":
          blockers.push(`Provider「${providerName}」缺 API 密钥`);
          break;
        case "unauthorized":
          blockers.push(`Provider「${providerName}」密钥被拒（401）`);
          break;
        case "unreachable":
          blockers.push(`Provider「${providerName}」端点不可达：${ph.message}`);
          break;
        case "bad-endpoint":
          blockers.push(`Provider「${providerName}」端点路径不对（404）`);
          break;
        default:
          blockers.push(`Provider「${providerName}」异常：${ph.message}`);
      }
    }

    return {
      workerId: w.id,
      name: w.name,
      agentKind: kind,
      engineInstalled,
      providerId,
      providerName,
      providerStatus: ph?.status,
      runnable: blockers.length === 0,
      blockers,
    };
  });

  return { providers, workers, checkedAt: new Date().toISOString() };
}
