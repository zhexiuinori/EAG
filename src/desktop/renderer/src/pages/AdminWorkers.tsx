import { useCallback, useEffect, useState } from "react";
import * as ipc from "../lib/ipc.ts";
import PageShell from "../components/PageShell.tsx";
import Button from "../components/Button.tsx";
import StatCard from "../components/StatCard.tsx";
import { Modal, ConfirmModal } from "../components/Modal.tsx";
import { useToast } from "../components/Toast.tsx";
import { useConfigStore } from "../stores/configStore.ts";
import { useUserStore } from "../stores/userStore.ts";
import { useWorkerStore } from "../stores/workerStore.ts";
import { IconPlus, IconWorkspace, IconPlay, IconAlert, IconNetwork, IconUsers, IconEdit } from "../components/icons.tsx";
import type { AdapterStatus, AgentKind, UserGroup, Worker, KnowledgeCollection } from "@shared/types.ts";

interface CreateForm {
  name: string;
  description: string;
  type: "personal" | "project";
  agentKind: AgentKind;
  assignedTo: string;
  modelProviderId: string;
  modelName: string;
  policyPath: string;
  policyAccess: "rw" | "r" | "hidden";
  systemPrompt: string;
  /** 预算上限（USD）；0/空 = 不限制 */
  budgetLimitUsd: string;
  /** 挂载的知识库（RAG）：对话前检索这些集合 */
  knowledgeIds: string[];
}

const EMPTY_FORM: CreateForm = {
  name: "", description: "", type: "personal", agentKind: "claude-code",
  assignedTo: "", modelProviderId: "", modelName: "",
  policyPath: "", policyAccess: "rw", systemPrompt: "", budgetLimitUsd: "",
  knowledgeIds: [],
};

export default function AdminWorkers() {
  // 数据统一走全局 stores：与工作区侧共享缓存，重命名/启停后台保持同步
  const workers = useWorkerStore((s) => s.all);
  const loadedAll = useWorkerStore((s) => s.loadedAll);
  const loadAll = useWorkerStore((s) => s.loadAll);

  const users = useUserStore((s) => s.users);
  const loadUsers = useUserStore((s) => s.load);

  const config = useConfigStore((s) => s.config);
  const loadConfig = useConfigStore((s) => s.load);

  const toast = useToast();
  const [adapters, setAdapters] = useState<AdapterStatus[]>([]);
  const [groups, setGroups] = useState<UserGroup[]>([]);
  // 知识库（RAG）：供表单挂载选择
  const [collections, setCollections] = useState<KnowledgeCollection[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<Worker | null>(null);
  const [form, setForm] = useState<CreateForm>(EMPTY_FORM);

  // 分配管理（多用户 + 用户组）
  const [assignTarget, setAssignTarget] = useState<Worker | null>(null);
  const [assignUsers, setAssignUsers] = useState<string[]>([]);
  const [assignGroups, setAssignGroups] = useState<string[]>([]);
  const [assignSaving, setAssignSaving] = useState(false);

  const loading = !loadedAll;

  const reload = useCallback(() => {
    void loadAll(true);
    void loadUsers(true);
    void loadConfig(true);
    ipc.groupList().then((r) => setGroups(r.groups ?? [])).catch(() => {});
  }, [loadAll, loadUsers, loadConfig]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { ipc.adaptersList().then((r) => setAdapters(r.adapters)).catch(() => {}); }, []);
  useEffect(() => {
    ipc.knowledgeList().then((r) => setCollections(r.collections ?? [])).catch(() => {});
  }, []);

  /** 一行摘要：谁可以用这个 Agent（人 / 组 / 全员）。 */
  const assigneeSummary = (w: Worker): string => {
    const ids = w.assignedUserIds?.length ? w.assignedUserIds : (w.assignedTo ? [w.assignedTo] : []);
    const names = ids.map((id) => users.find((u) => u.id === id)?.name ?? id);
    const gnames = (w.assignedGroupIds ?? []).map((gid) => groups.find((g) => g.id === gid)?.name ?? gid);
    const parts: string[] = [];
    if (names.length > 0) parts.push(names.length > 2 ? `${names[0]} 等 ${names.length} 人` : names.join("、"));
    if (gnames.length > 0) parts.push(gnames.length > 1 ? `${gnames[0]} 等 ${gnames.length} 组` : gnames[0]);
    if (w.type === "project") parts.push("全员可见");
    return parts.join(" · ") || "未分配";
  };

  const openAssign = (w: Worker) => {
    const ids = w.assignedUserIds?.length ? w.assignedUserIds : (w.assignedTo ? [w.assignedTo] : []);
    setAssignTarget(w);
    setAssignUsers(ids);
    setAssignGroups(w.assignedGroupIds ?? []);
  };

  const saveAssign = async () => {
    if (!assignTarget) return;
    setAssignSaving(true);
    try {
      const r = await ipc.workerAssign({
        id: assignTarget.id,
        userIds: assignUsers,
        groupIds: assignGroups,
      });
      if (r) {
        toast.success("分配已更新");
        setAssignTarget(null);
        reload();
        // 同窗口即时刷新用户侧可见 Agent（否则切到工作区仍是分配前的缓存）
        void useWorkerStore.getState().loadMine(true);
      } else {
        toast.error("分配失败：Agent 不存在");
      }
    } catch (e) {
      toast.error(`分配失败：${e}`);
    } finally {
      setAssignSaving(false);
    }
  };

  /** 打开编辑弹窗：回填当前 Worker 的模型/引擎/策略/System Prompt。 */
  const openEdit = (w: Worker) => {
    setEditing(w);
    setForm({
      name: w.name,
      description: w.description ?? "",
      type: w.type,
      modelProviderId: w.config?.modelProviderId ?? config?.providers[0]?.id ?? "",
      modelName: w.config?.modelName ?? config?.providers[0]?.activeModel ?? "",
      agentKind: w.config?.agentKind ?? "claude-code",
      policyPath: w.config?.policies?.[0]?.path ?? "",
      policyAccess: w.config?.policies?.[0]?.access ?? "rw",
      systemPrompt: w.config?.systemPrompt ?? "",
      budgetLimitUsd: w.config?.budgetLimitUsd != null ? String(w.config.budgetLimitUsd) : "",
      knowledgeIds: w.config?.knowledgeIds ?? [],
      assignedTo: w.assignedTo ?? "",
    });
  };

  const closeForm = () => {
    setEditing(null);
    setShowCreate(false);
    setForm(EMPTY_FORM);
  };

  useEffect(() => {
    if (config && config.providers.length > 0 && !form.modelProviderId) {
      const p = config.providers[0];
      setForm((f) => ({
        ...f,
        modelProviderId: p.id,
        modelName: p.activeModel || p.models[0] || "",
        assignedTo: users[0]?.id || "",
      }));
    }
  }, [config, users]);

  const activeProvider = config?.providers.find((p) => p.id === form.modelProviderId);

  /**
   * 提交：创建或更新。
   * 更新走 worker:update（主进程会剥离分配字段），模型/引擎/策略/systemPrompt
   * 都在此编辑 —— 这是"改 Agent 模型"的正规入口（用户侧只能做会话级临时覆盖）。
   */
  const handleSubmit = () => {
    if (!form.name.trim() || !form.modelProviderId || !form.modelName) return;
    const policies = form.policyPath.trim()
      ? [{ path: form.policyPath.trim(), access: form.policyAccess }]
      : [];
    // 预算上限：空/0 表示不限制
    const budgetLimitUsd = parseFloat(form.budgetLimitUsd) || undefined;

    if (editing) {
      ipc.workerUpdate({
        id: editing.id,
        patch: {
          name: form.name.trim(),
          description: form.description.trim(),
          type: form.type,
          config: {
            ...editing.config,
            modelProviderId: form.modelProviderId,
            modelName: form.modelName,
            agentKind: form.agentKind,
            policies,
            systemPrompt: form.systemPrompt.trim() || undefined,
            budgetLimitUsd,
          },
        },
      }).then(() => {
        toast.success("Worker 已更新");
        closeForm();
        reload();
      }).catch((e) => toast.error(`更新失败：${e}`));
      return;
    }

    ipc.workerCreate({
      name: form.name.trim(),
      description: form.description.trim(),
      type: form.type,
      // 不硬编码 u-admin（可能已被删除）；用户列表为空时留空并提示
      assignedTo: form.assignedTo || users[0]?.id || "",
      config: {
        modelProviderId: form.modelProviderId,
        modelName: form.modelName,
        agentKind: form.agentKind,
        policies,
        sessionIsolation: true,
        auditEnabled: true,
        systemPrompt: form.systemPrompt.trim() || undefined,
        budgetLimitUsd,
        knowledgeIds: form.knowledgeIds.length > 0 ? form.knowledgeIds : undefined,
      },
    }).then(() => {
      toast.success("Worker 已创建");
      closeForm();
      reload();
    }).catch((e) => toast.error(`创建失败：${e}`));
  };

  const handleDelete = (id: string) => {
    setDeleting(true);
    ipc.workerDelete({ id })
      .then(() => { toast.success("Worker 已删除"); setConfirmDelete(null); reload(); })
      .catch((e) => toast.error(`删除失败：${e}`))
      .finally(() => setDeleting(false));
  };

  const handleStart = (id: string) => {
    ipc.workerStart({ id })
      .then((ok) => {
        if (ok) toast.success("Worker 已启动");
        else toast.error("启动失败（引擎未安装或不可用）");
        reload();
      })
      .catch((e) => toast.error(`启动失败：${e}`));
  };

  const assignedUserName = (id: string) => users.find((u) => u.id === id)?.name || id;

  const runningCount = workers.filter((w) => w.status === "running").length;
  const errorCount = workers.filter((w) => w.status === "error").length;
  const engineKinds = Array.from(new Set(workers.map((w) => w.config.agentKind ?? "pi")));

  return (
    <PageShell
      title="Workers"
      description="管理与治理所有 Agent 实例"
      actions={
        <Button variant="primary" icon={<IconPlus size={13} />} onClick={() => setShowCreate(true)}>
          创建 Worker
        </Button>
      }
      scroll={false}
    >
      <div className="flex flex-col h-full gap-4">
        {/* 概览 */}
        <div className="shrink-0 grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard label="Worker 总数" value={loading ? "—" : workers.length} hint="已创建的实例" icon={<IconWorkspace size={13} />} />
          <StatCard label="运行中" value={runningCount} tone={runningCount > 0 ? "ok" : "default"} hint="正在提供服务" icon={<IconPlay size={13} />} />
          <StatCard label="异常" value={errorCount} tone={errorCount > 0 ? "danger" : "default"} hint="启动或运行失败" icon={<IconAlert size={13} />} />
          <StatCard label="引擎类型" value={engineKinds.length} hint={engineKinds.join(" / ") || "—"} icon={<IconNetwork size={13} />} />
        </div>

        {/* 列表 */}
        <div className="flex-1 min-h-0 card overflow-auto">
          {loading ? (
            <div className="px-4 py-10 text-center text-[11.5px] text-fg-faint">加载中…</div>
          ) : workers.length === 0 ? (
            <div className="px-4 py-14 text-center">
              <div className="mx-auto size-10 rounded-xl bg-n-850 border border-line flex items-center justify-center mb-3">
                <IconWorkspace size={18} className="text-fg-faint" />
              </div>
              <p className="text-[12.5px] text-fg-muted">还没有 Worker</p>
              <p className="text-[11px] text-fg-faint mt-1">创建后分配给用户，他们即可在工作区使用</p>
            </div>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>名称 / 描述</th>
                  <th className="w-20">类型</th>
                  <th className="w-28">引擎</th>
                  <th className="w-40">模型</th>
                  <th className="w-48">分配给</th>
                  <th className="w-24">状态</th>
                  <th className="w-52">操作</th>
                </tr>
              </thead>
              <tbody>
                {workers.map((w) => {
                  const running = w.status === "running";
                  const errored = w.status === "error";
                  return (
                    <tr key={w.id}>
                      <td>
                        <div className="text-[12.5px] text-fg font-medium truncate">{w.name}</div>
                        {w.description && (
                          <div className="text-[10.5px] text-fg-faint truncate mt-0.5">{w.description}</div>
                        )}
                      </td>
                      <td>
                        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                          w.type === "personal" ? "bg-blue-bg text-blue" : "bg-green-bg text-green"
                        }`}>
                          {w.type}
                        </span>
                      </td>
                      <td>
                        <span className="text-[10.5px] font-mono px-1.5 py-0.5 rounded bg-n-850 border border-line text-fg-subtle">
                          {w.config.agentKind ?? "pi"}
                        </span>
                      </td>
                      <td className="font-mono text-[11.5px] text-fg-subtle truncate">{w.config.modelName}</td>
                      <td className="text-[11.5px] truncate" title={assigneeSummary(w)}>
                        {assigneeSummary(w)}
                      </td>
                      <td>
                        <span className="flex items-center gap-1.5">
                          <span className={`w-1.5 h-1.5 rounded-full ${
                            running ? "bg-green" : errored ? "bg-red" : "bg-n-600"
                          }`} />
                          <span className="text-[11.5px] capitalize">
                            {running ? "运行中" : errored ? "异常" : "已停止"}
                          </span>
                        </span>
                      </td>
                      <td>
                        <div className="flex items-center gap-1">
                          <Button size="sm" variant="ghost" icon={<IconUsers size={12} />} onClick={() => openAssign(w)}>
                            分配
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => handleStart(w.id)}>
                            {running ? "重启" : "启动"}
                          </Button>
                          <Button size="sm" variant="danger" onClick={() => setConfirmDelete(w.id)}>
                            删除
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* 创建 / 编辑对话框 */}
      <Modal
        open={showCreate}
        title={editing ? `编辑 Worker · ${editing.name}` : "创建 Worker"}
        onClose={closeForm}
        footer={
          <>
            <Button onClick={closeForm}>取消</Button>
            <Button
              variant="primary"
              onClick={handleSubmit}
              disabled={!form.name.trim() || !form.modelName}
            >
              {editing ? "保存" : "创建"}
            </Button>
          </>
        }
      >
        <div className="space-y-3.5">
              <div>
                <label className="block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint mb-1.5">名称</label>
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="例如：后端助手"
                  className="field"
                />
              </div>

              <div>
                <label className="block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint mb-1.5">描述</label>
                <input
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder="这个 Worker 用来做什么"
                  className="field"
                />
              </div>

              <div>
                <label className="block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint mb-1.5">引擎</label>
                <select
                  value={form.agentKind}
                  onChange={(e) => setForm({ ...form, agentKind: e.target.value as AgentKind })}
                  className="field cursor-pointer"
                >
                  {adapters.length > 0 ? (
                    adapters.map((a) => (
                      <option key={a.kind} value={a.kind}>
                        {a.displayName}{a.installed ? "" : "（未安装）"}
                      </option>
                    ))
                  ) : (
                    <option value="claude-code">Claude Code</option>
                  )}
                </select>
                {(() => {
                  const sel = adapters.find((a) => a.kind === form.agentKind);
                  if (!sel) return null;
                  return (
                    <div className={`text-[10px] mt-1 ${sel.installed ? "text-fg-faint" : "text-yellow"}`}>
                      {sel.installed
                        ? `已检测到：${sel.version ?? "installed"}`
                        : "未检测到该 CLI，创建后需先安装才能使用"}
                    </div>
                  );
                })()}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint mb-1.5">类型</label>
                  <select
                    value={form.type}
                    onChange={(e) => setForm({ ...form, type: e.target.value as "personal" | "project" })}
                    className="field cursor-pointer"
                  >
                    <option value="personal">Personal</option>
                    <option value="project">Project</option>
                  </select>
                </div>
                {editing ? (
                  <div className="flex items-end pb-1">
                    <p className="text-[10px] text-fg-faint leading-relaxed">
                      分配（用户 / 用户组）由列表中的「分配」入口管理，不在此表单修改
                    </p>
                  </div>
                ) : (
                  <div>
                    <label className="block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint mb-1.5">主负责人</label>
                    <select
                      value={form.assignedTo}
                      onChange={(e) => setForm({ ...form, assignedTo: e.target.value })}
                      className="field cursor-pointer"
                    >
                      {users.map((u) => (
                        <option key={u.id} value={u.id}>{u.name}（{u.role}）</option>
                      ))}
                    </select>
                    <div className="text-[10px] text-fg-faint mt-1">
                      创建后可在列表点「分配」添加更多用户或用户组
                    </div>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint mb-1.5">模型 Provider</label>
                  <select
                    value={form.modelProviderId}
                    onChange={(e) => {
                      const p = config?.providers.find((x) => x.id === e.target.value);
                      setForm({ ...form, modelProviderId: e.target.value, modelName: p?.activeModel || p?.models[0] || "" });
                    }}
                    className="field cursor-pointer"
                  >
                    {config?.providers.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint mb-1.5">模型</label>
                  <select
                    value={form.modelName}
                    onChange={(e) => setForm({ ...form, modelName: e.target.value })}
                    className="field cursor-pointer"
                  >
                    {(activeProvider?.models || []).map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint mb-1.5">
                  System Prompt（可选）
                </label>
                <textarea
                  value={form.systemPrompt}
                  onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
                  rows={3}
                  placeholder="例如：你是本团队的代码助手，修改前先说明影响；禁止改动 migrations/ 目录…"
                  className="field resize-none"
                />
                <div className="text-[10px] text-fg-faint mt-1">
                  会前置到这个 Worker 的每次对话，用于固化团队规范
                </div>
              </div>

              {/* 知识库挂载（RAG）：对话前检索命中片段注入 prompt */}
              <div>
                <label className="block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint mb-1.5">
                  挂载知识库（可选）
                </label>
                {collections.length === 0 ? (
                  <p className="text-[10.5px] text-fg-faint">
                    还没有知识库 —— 到「知识库」页创建并添加文档后可在此挂载。
                  </p>
                ) : (
                  <div className="space-y-0.5 max-h-36 overflow-y-auto rounded-lg border border-line p-1.5">
                    {collections.map((c) => {
                      const checked = form.knowledgeIds.includes(c.id);
                      return (
                        <label
                          key={c.id}
                          className={`flex items-center gap-2.5 px-2.5 py-1.5 rounded-md cursor-pointer transition-colors ${
                            checked ? "bg-primary-bg" : "hover:bg-n-850/60"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() =>
                              setForm((f) => ({
                                ...f,
                                knowledgeIds: checked
                                  ? f.knowledgeIds.filter((x) => x !== c.id)
                                  : [...f.knowledgeIds, c.id],
                              }))
                            }
                          />
                          <span className="text-[11.5px] text-fg-muted truncate">{c.name}</span>
                          <span className="ml-auto text-[10px] text-fg-faint shrink-0">{c.chunkCount} 分块</span>
                        </label>
                      );
                    })}
                  </div>
                )}
                <div className="text-[10px] text-fg-faint mt-1">
                  对话前会用用户消息检索这些知识库，命中片段随 prompt 注入（需先在「设置 → 知识库向量化」配置 Embedding）
                </div>
              </div>

              <div>
                <label className="block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint mb-1.5">
                  预算上限 / USD（可选）
                </label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.budgetLimitUsd}
                  onChange={(e) => setForm({ ...form, budgetLimitUsd: e.target.value })}
                  placeholder="如 5.00；留空则不限制"
                  className="field max-w-[180px] font-mono"
                />
                <div className="text-[10px] text-fg-faint mt-1">
                  该 Agent 累计成本超过上限后拒绝发起新对话（需引擎上报 cost 事件）
                </div>
              </div>

              <div>
                <label className="block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint mb-1.5">
                  额外策略路径（可选）
                </label>
                <div className="flex gap-2">
                  <input
                    value={form.policyPath}
                    onChange={(e) => setForm({ ...form, policyPath: e.target.value })}
                    placeholder="${PROJECT_ROOT}/secrets"
                    className="field flex-1 font-mono"
                  />
                  <select
                    value={form.policyAccess}
                    onChange={(e) => setForm({ ...form, policyAccess: e.target.value as "rw" | "r" | "hidden" })}
                    className="field w-24 cursor-pointer"
                  >
                    <option value="rw">rw</option>
                    <option value="r">r</option>
                    <option value="hidden">hidden</option>
                  </select>
                </div>
                <div className="text-[10px] text-fg-faint mt-1">
                  会与 Policy 页的全局策略<strong className="text-fg-subtle">合并</strong>（同路径以此处为准），三个引擎统一生效
                </div>
              </div>
        </div>
      </Modal>

      {/* 分配管理：多用户 + 用户组（参考 QwenPaw 的 Agent 分配模型） */}
      <Modal
        open={assignTarget !== null}
        title={`分配 · ${assignTarget?.name ?? ""}`}
        onClose={() => setAssignTarget(null)}
        footer={
          <>
            <Button onClick={() => setAssignTarget(null)}>取消</Button>
            <Button
              variant="primary"
              onClick={saveAssign}
              disabled={assignSaving || (assignUsers.length === 0 && assignGroups.length === 0 && assignTarget?.type !== "project")}
            >
              {assignSaving ? "保存中…" : "保存分配"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {assignTarget?.type === "project" && (
            <div className="px-3 py-2 rounded-lg bg-blue-bg border border-blue/30 text-[11.5px] text-blue leading-relaxed">
              该 Agent 是 Project 类型：所有用户均可见，以下分配在类型改为 Personal 后才生效。
            </div>
          )}

          {/* 用户多选 */}
          <div>
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint mb-2">
              用户（已选 {assignUsers.length}）· 第一名为主负责人
            </div>
            <div className="space-y-0.5 max-h-52 overflow-y-auto rounded-lg border border-line p-1.5">
              {users.length === 0 ? (
                <p className="px-2 py-2 text-[11px] text-fg-faint">暂无用户，请先在 Settings 添加。</p>
              ) : (
                users.map((u) => {
                  const checked = assignUsers.includes(u.id);
                  const isOwner = assignUsers[0] === u.id;
                  return (
                    <label
                      key={u.id}
                      className={`flex items-center gap-2.5 px-2.5 py-1.5 rounded-md cursor-pointer transition-colors ${
                        checked ? "bg-primary-bg" : "hover:bg-n-850/60"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setAssignUsers((prev) =>
                            checked ? prev.filter((x) => x !== u.id) : [...prev, u.id],
                          )
                        }
                        className="accent-primary size-3.5 shrink-0"
                      />
                      <span className="text-[12px] text-fg-muted truncate">{u.name}</span>
                      <span className="text-[10px] text-fg-faint">{u.role}</span>
                      {isOwner && (
                        <span className="ml-auto shrink-0 text-[9px] px-1 py-px rounded bg-primary-bg text-primary border border-primary-border">
                          主负责人
                        </span>
                      )}
                    </label>
                  );
                })
              )}
            </div>
          </div>

          {/* 用户组多选 */}
          <div>
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint mb-2">
              用户组（已选 {assignGroups.length}）· 组成员均可使用
            </div>
            {groups.length === 0 ? (
              <p className="px-1 text-[11px] text-fg-faint">还没有用户组，可在 Settings 中创建后再来分配。</p>
            ) : (
              <div className="space-y-0.5 max-h-40 overflow-y-auto rounded-lg border border-line p-1.5">
                {groups.map((g) => {
                  const checked = assignGroups.includes(g.id);
                  return (
                    <label
                      key={g.id}
                      className={`flex items-center gap-2.5 px-2.5 py-1.5 rounded-md cursor-pointer transition-colors ${
                        checked ? "bg-primary-bg" : "hover:bg-n-850/60"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setAssignGroups((prev) =>
                            checked ? prev.filter((x) => x !== g.id) : [...prev, g.id],
                          )
                        }
                        className="accent-primary size-3.5 shrink-0"
                      />
                      <span className="text-[12px] text-fg-muted truncate">{g.name}</span>
                      <span className="ml-auto shrink-0 text-[10px] text-fg-faint">{g.memberIds.length} 名成员</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          <p className="text-[10.5px] text-fg-faint leading-relaxed">
            可见性 = 直接分配的用户 ∪ 所在组的成员（Personal 类型）；Project 类型对所有用户开放。
            分配变更会写入审计。
          </p>
        </div>
      </Modal>

      {/* 删除确认（替代手写弹窗） */}
      <ConfirmModal
        open={confirmDelete !== null}
        title="删除该 Worker？"
        description="此操作不可撤销，其会话与审计记录不会一并删除。"
        confirmText="删除"
        danger
        busy={deleting}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => { if (confirmDelete) handleDelete(confirmDelete); }}
      />
    </PageShell>
  );
}
