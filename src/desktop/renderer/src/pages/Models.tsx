import { useEffect, useState } from "react";
import PageShell from "../components/PageShell.tsx";
import Button from "../components/Button.tsx";
import { ConfirmModal } from "../components/Modal.tsx";
import { useToast } from "../components/Toast.tsx";
import { useConfigStore } from "../stores/configStore.ts";
import { IconPlus } from "../components/icons.tsx";
import * as ipc from "../lib/ipc.ts";
import type {
  AppConfig, ModelProvider, ProviderType,
  ProviderHealthResult, ProviderHealthStatus,
} from "@shared/types.ts";

/** 体检状态 → 圆点色 + 中文标签（每一类对应不同的修法） */
const HEALTH_DOT: Record<ProviderHealthStatus, string> = {
  ok: "bg-green",
  "no-key": "bg-yellow",
  unreachable: "bg-red",
  unauthorized: "bg-red",
  "bad-endpoint": "bg-yellow",
  error: "bg-n-600",
};
const HEALTH_LABEL: Record<ProviderHealthStatus, string> = {
  ok: "正常",
  "no-key": "缺密钥",
  unreachable: "不可达",
  unauthorized: "密钥被拒",
  "bad-endpoint": "端点错误",
  error: "异常",
};

const PROVIDER_LABELS: Record<ProviderType, string> = {
  ollama: "Ollama",
  openai: "OpenAI",
  anthropic: "Anthropic",
  deepseek: "DeepSeek",
  custom: "Custom",
};

const PROVIDER_COLORS: Record<ProviderType, string> = {
  ollama: "#66bb6a",
  openai: "#42a5f5",
  anthropic: "#ab47bc",
  deepseek: "#ffa726",
  custom: "#90a4ae",
};

const PROVIDER_TYPES: ProviderType[] = ["ollama", "openai", "anthropic", "deepseek", "custom"];

/* ------------------------------------------------------------------ */
/*  Add Model Tag                                                      */
/* ------------------------------------------------------------------ */

function AddModelTag({ onAdd }: { onAdd: (tag: string) => void }) {
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState(false);

  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        className="text-xs px-2 py-0.5 rounded border border-dashed border-n-600 text-n-500 hover:text-n-300 hover:border-n-500 transition-colors cursor-pointer bg-transparent"
      >
        + add
      </button>
    );
  }

  const commit = () => {
    const t = value.trim();
    if (t) onAdd(t);
    setValue("");
    setEditing(false);
  };

  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
      placeholder="model name"
      className="w-24 text-xs bg-n-800 border border-n-600 rounded px-1.5 py-0.5 text-n-200 outline-none"
    />
  );
}

/* ------------------------------------------------------------------ */
/*  Side Panel                                                         */
/* ------------------------------------------------------------------ */

interface SidePanelProps {
  provider: ModelProvider;
  onSave: (p: ModelProvider) => void;
  onDelete: (id: string) => void;
  onTestConnection: (p: ModelProvider) => void;
  testing: boolean;
  onClose: () => void;
}

function SidePanel({ provider, onSave, onDelete, onTestConnection, testing, onClose }: SidePanelProps) {
  const [draft, setDraft] = useState<ModelProvider>({ ...provider });
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => { setDraft({ ...provider }); setSaved(false); }, [provider]);

  const update = (patch: Partial<ModelProvider>) => setDraft((p) => ({ ...p, ...patch }));

  const addModel = (tag: string) => {
    if (draft.models.includes(tag)) return;
    const next = [...draft.models, tag];
    update({ models: next, activeModel: draft.activeModel || next[0] });
  };

  const removeModel = (tag: string) => {
    const next = draft.models.filter((m) => m !== tag);
    update({
      models: next,
      activeModel: draft.activeModel === tag ? (next[0] ?? "") : draft.activeModel,
    });
  };

  const handleSave = () => {
    onSave(draft);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      {/* Panel */}
      <div className="relative w-[420px] max-w-[90vw] h-full bg-n-950 border-l border-n-800 shadow-2xl overflow-y-auto z-50">
        {/* Header */}
        <div className="flex items-center justify-between px-5 h-12 border-b border-n-800">
          <div className="flex items-center gap-2.5">
            <span
              className="inline-block size-2.5 rounded-full shrink-0"
              style={{ background: PROVIDER_COLORS[draft.type] }}
            />
            <span className="text-sm font-semibold text-n-200">{draft.name || "Unnamed Provider"}</span>
          </div>
          <button onClick={onClose} className="text-n-500 hover:text-n-200 text-lg leading-none cursor-pointer bg-transparent border-none">&times;</button>
        </div>

        <div className="p-5 space-y-5">
          {/* Type */}
          <div>
            <label className="text-[11px] font-semibold text-n-500 uppercase tracking-wider block mb-1.5">Provider Type</label>
            <div className="flex gap-1.5 flex-wrap">
              {PROVIDER_TYPES.map((t) => (
                <button
                  key={t}
                  onClick={() => update({ type: t })}
                  className={`px-2.5 py-1 rounded text-xs font-semibold border transition-colors cursor-pointer ${
                    draft.type === t
                      ? "border-transparent text-white"
                      : "border-n-700 text-n-400 bg-transparent hover:text-n-200"
                  }`}
                  style={draft.type === t ? { background: PROVIDER_COLORS[t], borderColor: PROVIDER_COLORS[t] } : undefined}
                >
                  {PROVIDER_LABELS[t]}
                </button>
              ))}
            </div>
          </div>

          {/* Name */}
          <div>
            <label className="text-[11px] font-semibold text-n-500 uppercase tracking-wider block mb-1.5">Display Name</label>
            <input
              value={draft.name}
              onChange={(e) => update({ name: e.target.value })}
              placeholder="My Provider"
              className="field"
            />
          </div>

          {/* Base URL */}
          <div>
            <label className="text-[11px] font-semibold text-n-500 uppercase tracking-wider block mb-1.5">Base URL</label>
            <input
              value={draft.baseUrl}
              onChange={(e) => update({ baseUrl: e.target.value })}
              placeholder="http://localhost:11434"
              className="field font-mono"
            />
          </div>

          {/* API Key */}
          <div>
            <label className="text-[11px] font-semibold text-n-500 uppercase tracking-wider block mb-1.5">API Key</label>
            <div className="relative">
              <input
                type={showKey ? "text" : "password"}
                value={draft.apiKey ?? ""}
                onChange={(e) => update({ apiKey: e.target.value })}
                placeholder="sk-..."
                className="field pr-14 font-mono"
              />
              <button
                onClick={() => setShowKey((v) => !v)}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[11px] font-semibold text-n-500 hover:text-n-300 transition-colors bg-transparent border-none cursor-pointer px-1.5"
              >
                {showKey ? "HIDE" : "SHOW"}
              </button>
            </div>
          </div>

          {/* Models */}
          <div>
            <label className="text-[11px] font-semibold text-n-500 uppercase tracking-wider block mb-1.5">
              Models <span className="text-n-600 font-normal lowercase">({draft.models.length})</span>
            </label>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {draft.models.map((m) => (
                <span
                  key={m}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-n-800 text-n-300"
                >
                  {m}
                  <button
                    onClick={() => removeModel(m)}
                    className="text-n-500 hover:text-red-400 leading-none text-sm cursor-pointer bg-transparent border-none"
                  >
                    &times;
                  </button>
                </span>
              ))}
              <AddModelTag onAdd={addModel} />
            </div>
          </div>

          {/* Active model */}
          {draft.models.length > 0 && (
            <div>
              <label className="text-[11px] font-semibold text-n-500 uppercase tracking-wider block mb-1.5">Default Model</label>
              <select
                value={draft.activeModel}
                onChange={(e) => update({ activeModel: e.target.value })}
                className="w-full bg-n-800 border border-n-700 rounded px-3 py-1.5 text-sm text-n-200 outline-none focus:border-n-500"
              >
                {draft.models.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
          )}

          {/* Default toggle */}
          <label className="flex items-center gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={draft.isDefault ?? false}
              onChange={(e) => update({ isDefault: e.target.checked })}
              className="accent-n-400 size-3.5"
            />
            <span className="text-xs text-n-300">Set as default provider</span>
          </label>

          {/* Actions */}
          <div className="flex gap-2.5 pt-2 border-t border-n-800">
            <button
              onClick={handleSave}
              className="flex-1"
            >
              <span className="flex items-center justify-center h-8 rounded-lg bg-primary-strong hover:bg-primary text-white text-[12px] font-medium transition-colors">
                {saved ? "已保存" : "保存"}
              </span>
            </button>
            <button onClick={() => onTestConnection(draft)} disabled={testing} type="button">
              <span className="flex items-center justify-center h-8 px-3 rounded-lg border border-line text-fg-muted hover:text-fg text-[12px] font-medium transition-colors">
                {testing ? "测试中…" : "测试"}
              </span>
            </button>
            <button onClick={() => onDelete(draft.id)} type="button">
              <span className="flex items-center justify-center h-8 px-3 rounded-lg border border-line text-fg-subtle hover:text-red hover:border-red/40 text-[12px] font-medium transition-colors">
                删除
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Models Page                                                        */
/* ------------------------------------------------------------------ */

export default function Models() {
  const toast = useToast();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [selected, setSelected] = useState<ModelProvider | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ModelProvider | null>(null);

  // 配置体检：一键看清"哪个 Provider 不通、哪个 Agent 跑不起来"
  const [health, setHealth] = useState<ProviderHealthResult | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    ipc.configGet().then((cfg) => setConfig(cfg)).catch(() => toast.error("配置加载失败"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runHealthCheck = () => {
    setChecking(true);
    ipc.providerHealth()
      .then((r) => {
        setHealth(r);
        const bad = r.providers.filter((p) => p.status !== "ok").length;
        const broken = r.workers.filter((w) => !w.runnable).length;
        if (bad === 0 && broken === 0) toast.success("体检通过：所有 Provider 与 Agent 均可用");
        else toast.error(`体检发现 ${bad} 个 Provider 异常、${broken} 个 Agent 不可运行`);
      })
      .catch((e) => toast.error(`体检失败：${e}`))
      .finally(() => setChecking(false));
  };

  const saveProvider = (p: ModelProvider) => {
    if (!config) return;
    const next: AppConfig = {
      ...config,
      providers: config.providers.map((pr) => (pr.id === p.id ? p : pr)),
      activeProviderId: p.isDefault ? p.id : config.activeProviderId,
      // clear default from others
      ...(p.isDefault ? { providers: config.providers.map((pr) => ({ ...pr, isDefault: pr.id === p.id })) } : {}),
    };
    // re-apply the passed provider on top
    if (p.isDefault) {
      next.providers = next.providers.map((pr) => (pr.id === p.id ? p : pr));
    }
    setConfig(next);
    ipc
      .configUpdate(next)
      .then(() => {
        toast.success("Provider 已保存");
        // 同步全局缓存：顶栏的模型选择立即反映新配置
        void useConfigStore.getState().load(true);
      })
      .catch((e) => toast.error(`保存失败：${e}`));
  };

  const addProvider = () => {
    if (!config) return;
    const newProv: ModelProvider = {
      id: `prov_${Date.now()}`,
      name: "New Provider",
      type: "custom",
      baseUrl: "",
      apiKey: "",
      models: [],
      activeModel: "",
      isDefault: false,
    };
    const next = { ...config, providers: [...config.providers, newProv] };
    setConfig(next);
    setSelected(newProv);
  };

  const deleteProvider = (id: string) => {
    if (!config) return;
    const next: AppConfig = {
      ...config,
      providers: config.providers.filter((p) => p.id !== id),
      activeProviderId: config.activeProviderId === id ? "" : config.activeProviderId,
    };
    setConfig(next);
    if (selected?.id === id) setSelected(null);
    ipc
      .configUpdate(next)
      .then(() => {
        toast.success("Provider 已删除");
        setPendingDelete(null);
        void useConfigStore.getState().load(true);
      })
      .catch((e) => toast.error(`删除失败：${e}`));
  };

  const testConnection = (p: ModelProvider) => {
    const target = p.id;
    setTestingId(target);
    ipc
      .providerTest({ type: p.type, baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.activeModel || (p.models[0] ?? "") })
      .then((res) => {
        if (res.success) {
          toast.success(`连接成功 · ${res.latencyMs ?? "?"}ms`);
        } else {
          toast.error(`连接失败：${res.error ?? "未知错误"}`);
        }
      })
      .catch((e) => toast.error(`测试失败：${e}`))
      .finally(() => setTestingId(null));
  };

  if (!config) {
    return (
      <div className="p-10 text-sm text-n-500">
        Loading models...
      </div>
    );
  }

  return (
    <PageShell
      title="Models"
      description={`${config.providers.length} 个 Provider · 密钥建议使用 ${"${ENV_VAR}"} 占位符`}
      actions={
        <>
          <Button onClick={runHealthCheck} disabled={checking}>
            {checking ? "体检中…" : "配置体检"}
          </Button>
          <Button variant="primary" icon={<IconPlus size={13} />} onClick={addProvider}>
            添加 Provider
          </Button>
        </>
      }
    >
      {/* 体检结果：Provider 连通性 + Agent 可运行性（把"跑不起来"拆到具体一步） */}
      {health && (
        <div className="card p-4 mb-4 max-w-5xl">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[12.5px] font-semibold text-fg-muted">
              配置体检
              <span className="ml-2 text-[10.5px] font-normal text-fg-faint">
                {new Date(health.checkedAt).toLocaleTimeString()} · 直连探测、不计费
              </span>
            </h2>
            <button
              onClick={() => setHealth(null)}
              className="text-[11px] text-fg-faint hover:text-fg-muted transition-colors cursor-pointer bg-transparent"
            >
              收起
            </button>
          </div>

          <div className="space-y-1.5">
            {health.providers.map((h) => (
              <div key={h.providerId} className="flex items-start gap-2.5 text-[11.5px]">
                <span className={`mt-[5px] size-1.5 rounded-full shrink-0 ${HEALTH_DOT[h.status]}`} />
                <span className="w-36 shrink-0 text-fg-muted truncate" title={h.baseUrl}>{h.name}</span>
                <span className={`w-24 shrink-0 ${h.status === "ok" ? "text-green" : "text-yellow"}`}>
                  {HEALTH_LABEL[h.status]}
                  {h.status === "ok" && h.latencyMs != null ? ` ${h.latencyMs}ms` : ""}
                </span>
                <span className="flex-1 text-fg-faint break-words">{h.message}</span>
              </div>
            ))}
            {health.providers.length === 0 && (
              <div className="text-[11.5px] text-fg-faint">还没有配置 Provider。</div>
            )}
          </div>

          <h3 className="text-[11.5px] font-semibold text-fg-muted mt-4 mb-2">Agent 可运行性</h3>
          <div className="space-y-1.5">
            {health.workers.map((w) => (
              <div key={w.workerId} className="flex items-start gap-2.5 text-[11.5px]">
                <span className={`mt-[5px] size-1.5 rounded-full shrink-0 ${w.runnable ? "bg-green" : "bg-red"}`} />
                <span className="w-36 shrink-0 text-fg-muted truncate" title={w.workerId}>{w.name}</span>
                <span className={`w-24 shrink-0 ${w.runnable ? "text-green" : "text-red"}`}>
                  {w.runnable ? "可运行" : "不可运行"}
                </span>
                <span className="flex-1 text-fg-faint break-words">
                  {w.runnable
                    ? `${w.providerName ?? "—"} · ${w.agentKind}${w.engineInstalled ? "" : "（引擎未安装）"}`
                    : w.blockers.join("；")}
                </span>
              </div>
            ))}
            {health.workers.length === 0 && (
              <div className="text-[11.5px] text-fg-faint">还没有 Worker。</div>
            )}
          </div>
        </div>
      )}

      {/* Card Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 max-w-5xl">
        {config.providers.map((p) => {
          const isTesting = testingId === p.id;
          return (
            <button
              key={p.id}
              onClick={() => setSelected(p)}
              className={`card card-hover text-left p-4 ${
                selected?.id === p.id ? "!border-primary-border" : ""
              }`}
            >
              {/* Top row: dot + name + default badge */}
              <div className="flex items-center gap-2 mb-2.5">
                <span className="inline-block size-2.5 rounded-full shrink-0" style={{ background: PROVIDER_COLORS[p.type] }} />
                <span className="text-sm font-semibold text-n-200 truncate flex-1">{p.name}</span>
                {p.isDefault && (
                  <span className="text-[11px] font-bold text-n-500 bg-n-800 px-1.5 py-0.5 rounded uppercase tracking-wider">Default</span>
                )}
              </div>

              {/* Type + base URL */}
              <div className="text-[11px] text-n-500 mb-2 truncate font-mono">
                {PROVIDER_LABELS[p.type]}
                {p.baseUrl ? ` / ${p.baseUrl}` : ""}
              </div>

              {/* Models */}
              <div className="flex flex-wrap gap-1 mb-2.5 min-h-[20px]">
                {p.models.slice(0, 4).map((m) => (
                  <span key={m} className="text-[11px] bg-n-800 text-n-400 px-1.5 py-0.5 rounded">{m}</span>
                ))}
                {p.models.length > 4 && (
                  <span className="text-[11px] text-n-600">+{p.models.length - 4}</span>
                )}
                {p.models.length === 0 && (
                  <span className="text-[11px] text-n-600 italic">No models</span>
                )}
              </div>

              {/* Bottom: test button */}
              <div
                onClick={(e) => e.stopPropagation()}
                className="pt-2 mt-1 border-t border-line"
              >
                <Button size="sm" variant="ghost" onClick={() => testConnection(p)} disabled={isTesting}>
                  {isTesting ? "测试中…" : "测试连接"}
                </Button>
              </div>
            </button>
          );
        })}

        {/* Empty state */}
        {config.providers.length === 0 && (
          <div className="col-span-full card px-4 py-14 text-center">
            <p className="text-[12.5px] text-fg-muted">还没有配置任何 Provider</p>
            <p className="text-[11px] text-fg-faint mt-1">添加后即可在会话中选择模型</p>
            <div className="mt-4 flex justify-center">
              <Button variant="primary" onClick={addProvider}>添加第一个 Provider</Button>
            </div>
          </div>
        )}
      </div>

      {/* Side Panel */}
      {selected && (
        <SidePanel
          key={selected.id}
          provider={selected}
          onSave={saveProvider}
          onDelete={(id) => setPendingDelete(config.providers.find((p) => p.id === id) ?? null)}
          onTestConnection={testConnection}
          testing={testingId === selected.id}
          onClose={() => setSelected(null)}
        />
      )}

      {/* 删除 Provider 确认（替代 window.confirm） */}
      <ConfirmModal
        open={pendingDelete !== null}
        title="删除该 Provider？"
        description={pendingDelete ? `「${pendingDelete.name}」及其模型列表将被移除，使用它的 Worker 需要重新选择模型。` : undefined}
        confirmText="删除"
        danger
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => { if (pendingDelete) deleteProvider(pendingDelete.id); }}
      />
    </PageShell>
  );
}
