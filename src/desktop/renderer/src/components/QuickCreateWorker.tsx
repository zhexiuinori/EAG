import { useEffect, useState } from "react";
import { Modal } from "./Modal.tsx";
import Button from "./Button.tsx";
import { useToast } from "./Toast.tsx";
import * as ipc from "../lib/ipc.ts";
import { useConfigStore } from "../stores/configStore.ts";
import { useUserStore } from "../stores/userStore.ts";
import type { AdapterStatus, AgentKind } from "@shared/types.ts";

interface Props {
  open: boolean;
  onClose: () => void;
  /** 创建成功回调：回传新 Worker id */
  onCreated: (workerId: string) => void;
}

/** 引擎静态兜底（adaptersList 失败时也可选，安装状态未知则不置灰） */
const FALLBACK_ENGINES: { kind: AgentKind; label: string }[] = [
  { kind: "claude-code", label: "Claude Code" },
  { kind: "codex", label: "Codex" },
  { kind: "pi", label: "Pi" },
];

/**
 * 快速创建助手（一期）：名称 / 引擎 / 一句话用途 3 个字段，
 * 其余治理属性（模型供应商与模型、策略、预算、审计、会话隔离）全部继承团队默认值。
 * 完整表单仍在管理端 Workers 页（「高级创建」）。
 */
export default function QuickCreateWorker({ open, onClose, onCreated }: Props) {
  const toast = useToast();
  const config = useConfigStore((s) => s.config);
  const loadConfig = useConfigStore((s) => s.load);
  const userId = useUserStore((s) => s.session?.userId);

  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [agentKind, setAgentKind] = useState<AgentKind>("claude-code");
  const [adapters, setAdapters] = useState<AdapterStatus[]>([]);
  const [saving, setSaving] = useState(false);

  // 打开时重置并拉取引擎安装状态 + 模型供应商配置
  useEffect(() => {
    if (!open) return;
    setName("");
    setPurpose("");
    setAgentKind("claude-code");
    setSaving(false);
    ipc.adaptersList().then((r) => setAdapters(r.adapters)).catch(() => setAdapters([]));
    if (!config) loadConfig();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const engines = adapters.length > 0
    ? adapters.map((a) => ({ kind: a.kind, label: a.displayName, installed: a.installed }))
    : FALLBACK_ENGINES.map((e) => ({ ...e, installed: true }));

  const provider = config?.providers[0];
  const canSubmit = !!name.trim() && !!provider && !saving;

  const submit = () => {
    if (!canSubmit || !provider) return;
    setSaving(true);
    ipc.workerCreate({
      name: name.trim(),
      description: purpose.trim(),
      type: "personal",
      // 快速创建：自动分配给创建者本人，创建完立即可用
      assignedTo: userId ?? "",
      config: {
        // 治理属性继承团队默认：首个模型供应商 + 其激活模型
        modelProviderId: provider.id,
        modelName: provider.activeModel || provider.models[0] || "",
        agentKind,
        policies: [],
        sessionIsolation: true,
        auditEnabled: true,
      },
    }).then((w) => {
      toast.success(`助手「${name.trim()}」已创建`);
      const id = (w as { id?: string } | null)?.id;
      if (id) onCreated(id);
      else onClose();
    }).catch((e) => {
      toast.error(`创建失败：${e}`);
      setSaving(false);
    });
  };

  return (
    <Modal
      open={open}
      title="新建助手"
      onClose={onClose}
      footer={
        <div className="flex items-center justify-between w-full">
          <span className="text-[11px] text-fg-faint">策略 / 预算 / 模型继承团队默认，高级配置在管理端</span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>取消</Button>
            <Button variant="primary" onClick={submit} disabled={!canSubmit}>
              {saving ? "创建中…" : "创建"}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="block text-[12px] font-medium text-fg-muted mb-1.5">名称</label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && canSubmit) submit(); }}
            placeholder="例如：发票整理助手"
            maxLength={40}
            className="field"
          />
        </div>

        <div>
          <label className="block text-[12px] font-medium text-fg-muted mb-1.5">引擎</label>
          <div className="flex flex-wrap gap-1.5">
            {engines.map((e) => {
              const active = agentKind === e.kind;
              return (
                <button
                  key={e.kind}
                  onClick={() => e.installed && setAgentKind(e.kind)}
                  disabled={!e.installed}
                  title={e.installed ? e.label : `${e.label}（未检测到 CLI，需先安装）`}
                  className={`px-3 py-1.5 rounded-full text-[12px] font-medium transition-colors ${
                    active
                      ? "bg-primary-bg text-primary border border-primary-border"
                      : e.installed
                        ? "text-fg-subtle border border-line hover:border-line-strong hover:text-fg-muted"
                        : "text-fg-faint border border-line/50 cursor-not-allowed"
                  }`}
                >
                  {e.label}
                  {!e.installed && <span className="ml-1 text-[10px]">未安装</span>}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <label className="block text-[12px] font-medium text-fg-muted mb-1.5">
            用途 <span className="text-fg-faint font-normal">（可选，一句话）</span>
          </label>
          <input
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && canSubmit) submit(); }}
            placeholder="例如：帮我把每周的发票整理成表格"
            maxLength={80}
            className="field"
          />
        </div>

        {!provider && config && (
          <p className="text-[11.5px] text-yellow">尚未配置模型供应商 —— 请到管理端「资源 → Models」添加后再创建。</p>
        )}
      </div>
    </Modal>
  );
}
