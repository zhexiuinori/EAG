import { useCallback, useEffect, useState, type ReactNode } from "react";
import * as ipc from "../lib/ipc.ts";
import { passwordPolicyOk, PASSWORD_POLICY_LABEL } from "../lib/password.ts";
import PageShell from "../components/PageShell.tsx";
import Button from "../components/Button.tsx";
import EmptyState from "../components/EmptyState.tsx";
import { Modal, ConfirmModal } from "../components/Modal.tsx";
import { useToast } from "../components/Toast.tsx";
import { IconPlus, IconUsers, IconPlay, IconStop, IconNetwork } from "../components/icons.tsx";
import type { AppConfig, User, UserGroup, McpServerView, McpTool, LoginHistoryEntry } from "@shared/types.ts";

/* ------------------------------------------------------------------ */
/*  添加用户对话框（共享 Modal）                                         */
/* ------------------------------------------------------------------ */

interface AddUserDialogProps {
  open: boolean;
  onClose: () => void;
  onAdd: (input: { name: string; username: string; password: string; role: "user" | "admin"; canManageConsole: boolean }) => void;
}

function AddUserDialog({ open, onClose, onAdd }: AddUserDialogProps) {
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");
  const [canManageConsole, setCanManageConsole] = useState(false);

  const handleAdd = () => {
    if (!name.trim() || !username.trim() || !passwordPolicyOk(password)) return;
    onAdd({ name: name.trim(), username: username.trim(), password, role, canManageConsole });
    setName(""); setUsername(""); setPassword(""); setRole("user"); setCanManageConsole(false);
  };

  const handleCancel = () => {
    setName(""); setUsername(""); setPassword(""); setRole("user"); setCanManageConsole(false);
    onClose();
  };

  return (
    <Modal
      open={open}
      title="添加用户"
      onClose={handleCancel}
      widthClass="max-w-md"
      footer={
        <>
          <Button onClick={handleCancel}>取消</Button>
          <Button variant="primary" onClick={handleAdd} disabled={!name.trim() || !username.trim() || !passwordPolicyOk(password)}>添加</Button>
        </>
      }
    >
      <div className="space-y-3.5">
        <div>
          <label className="block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint mb-1.5">
            名称
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="显示名称，如 张三"
            autoFocus
            className="field"
          />
        </div>

        <div>
          <label className="block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint mb-1.5">
            登录用户名
          </label>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            placeholder="如 zhangsan（唯一）"
            className="field"
          />
        </div>

        <div>
          <label className="block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint mb-1.5">
            初始密码（{PASSWORD_POLICY_LABEL}）
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            placeholder="••••••••"
            className="field"
          />
        </div>

        <div>
          <label className="block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint mb-1.5">
            角色
          </label>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as "user" | "admin")}
            className="field cursor-pointer"
          >
            <option value="user">User（普通用户）</option>
            <option value="admin">Admin（管理员）</option>
          </select>
        </div>

        {role === "user" && (
          <label className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg border border-line cursor-pointer select-none">
            <input
              type="checkbox"
              checked={canManageConsole}
              onChange={(e) => setCanManageConsole(e.target.checked)}
              className="mt-0.5"
            />
            <span className="text-[11.5px] leading-relaxed text-fg-muted">
              授予后台权限（非管理员亦可访问管理控制台）
            </span>
          </label>
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/*  编辑用户对话框（角色 / 后台授权 / 名称 / 重置密码）                   */
/* ------------------------------------------------------------------ */

interface EditUserDialogProps {
  user: User | null;
  onClose: () => void;
  onSaved: () => void;
}

function EditUserDialog({ user, onClose, onSaved }: EditUserDialogProps) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");
  const [canManageConsole, setCanManageConsole] = useState(false);
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);

  // 每次打开时用当前用户回填
  useEffect(() => {
    if (user) {
      setName(user.name);
      setRole(user.role);
      setCanManageConsole(user.canManageConsole);
      setPassword("");
    }
  }, [user]);

  const save = () => {
    if (!user || !name.trim() || saving) return;
    setSaving(true);
    ipc
      .userUpdate({
        id: user.id,
        name: name.trim(),
        role,
        canManageConsole: canManageConsole || role === "admin",
        ...(password ? { password } : {}),
      })
      .then(() => {
        toast.success(`已更新「${user.name}」`);
        onSaved();
        onClose();
      })
      .catch((e) => toast.error(`更新失败：${e}`))
      .finally(() => setSaving(false));
  };

  return (
    <Modal
      open={user !== null}
      title={`编辑用户 · @${user?.username ?? ""}`}
      onClose={onClose}
      widthClass="max-w-md"
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={save} disabled={saving || !name.trim()}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </>
      }
    >
      <div className="space-y-3.5">
        <div>
          <label className="block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint mb-1.5">
            名称
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="field"
          />
        </div>

        <div>
          <label className="block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint mb-1.5">
            角色
          </label>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as "user" | "admin")}
            className="field cursor-pointer"
          >
            <option value="user">User（普通用户）</option>
            <option value="admin">Admin（管理员）</option>
          </select>
        </div>

        {role === "user" && (
          <label className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg border border-line cursor-pointer select-none">
            <input
              type="checkbox"
              checked={canManageConsole}
              onChange={(e) => setCanManageConsole(e.target.checked)}
              className="mt-0.5"
            />
            <span className="text-[11.5px] leading-relaxed text-fg-muted">
              授予后台权限（非管理员亦可访问管理控制台）
            </span>
          </label>
        )}

        <div>
          <label className="block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint mb-1.5">
            重置密码（留空则不修改）
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={PASSWORD_POLICY_LABEL}
            className="field"
          />
          <p className="mt-1.5 text-[10.5px] text-fg-faint">
            修改密码后该用户所有会话将立即失效，需用新密码重新登录。
          </p>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/*  Settings 页面                                                      */
/* ------------------------------------------------------------------ */

export default function Settings() {
  const toast = useToast();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [showAddUser, setShowAddUser] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<User | null>(null);
  const [deleting, setDeleting] = useState(false);
  // MCP 服务器
  const [mcpServers, setMcpServers] = useState<McpServerView[]>([]);
  const [mcpEditor, setMcpEditor] = useState<{ id?: string; name: string; command: string; args: string; env: string; cwd: string } | null>(null);
  const [mcpSaving, setMcpSaving] = useState(false);
  const [mcpTools, setMcpTools] = useState<{ server: string; tools: McpTool[] } | null>(null);
  const [mcpToolsLoading, setMcpToolsLoading] = useState(false);
  const [pendingDeleteMcp, setPendingDeleteMcp] = useState<McpServerView | null>(null);

  const [editTarget, setEditTarget] = useState<User | null>(null);
  const [resetTarget, setResetTarget] = useState<User | null>(null);
  const [resetPwd, setResetPwd] = useState("");
  const [resetting, setResetting] = useState(false);
  const [notifyTesting, setNotifyTesting] = useState(false);
  // 会话吊销（强制该用户重新登录）
  const [revokeTarget, setRevokeTarget] = useState<User | null>(null);
  const [revoking, setRevoking] = useState(false);
  // 登录历史（认证事件：登录/登出/吊销/改密，源自审计日志）
  const [history, setHistory] = useState<LoginHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [piStatus, setPiStatus] = useState<{ running: boolean; pid: number | null } | null>(null);
  const [piBusy, setPiBusy] = useState(false);

  // 用户组（Agent 分配的中间粒度）
  const [groups, setGroups] = useState<UserGroup[]>([]);
  const [groupEditor, setGroupEditor] = useState<{ id?: string; name: string; memberIds: string[] } | null>(null);
  const [groupSaving, setGroupSaving] = useState(false);
  const [pendingDeleteGroup, setPendingDeleteGroup] = useState<UserGroup | null>(null);

  const refreshGroups = useCallback(() => {
    ipc.groupList().then((r) => setGroups(r.groups ?? [])).catch(() => {});
  }, []);

  const refreshPi = useCallback(() => {
    ipc.piStatus().then(setPiStatus).catch(() => setPiStatus(null));
  }, []);

  const refreshHistory = useCallback(() => {
    setHistoryLoading(true);
    ipc
      .loginHistory({ limit: 100 })
      .then((r) => setHistory(r.entries ?? []))
      .catch(() => setHistory([])) // 非管理员 / Web 兜底：无权限时静默为空
      .finally(() => setHistoryLoading(false));
  }, []);

  /** 吊销某用户的全部登录会话（强制重新登录；不改密码） */
  const confirmRevoke = async () => {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      await ipc.userRevokeTokens({ id: revokeTarget.id });
      toast.success(`已吊销「${revokeTarget.name}」的全部会话，其需重新登录`);
      setRevokeTarget(null);
      refreshHistory();
    } catch (e) {
      toast.error(`吊销失败：${e}`);
    } finally {
      setRevoking(false);
    }
  };

  useEffect(() => {
    ipc.configGet().then(setConfig).catch(() => toast.error("配置加载失败"));
    ipc.userList().then((res) => setUsers(res.users)).catch(() => {});
    refreshGroups();
    refreshMcp();
    refreshPi();
    refreshHistory();
    const iv = setInterval(refreshPi, 5000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshPi, refreshGroups, refreshHistory]);

  const saveGroup = async () => {
    if (!groupEditor || !groupEditor.name.trim()) return;
    setGroupSaving(true);
    try {
      await ipc.groupUpsert({
        id: groupEditor.id,
        name: groupEditor.name.trim(),
        memberIds: groupEditor.memberIds,
      });
      toast.success(groupEditor.id ? "用户组已更新" : "用户组已创建");
      setGroupEditor(null);
      refreshGroups();
    } catch (e) {
      toast.error(`保存失败：${e}`);
    } finally {
      setGroupSaving(false);
    }
  };

  const confirmDeleteGroup = async () => {
    if (!pendingDeleteGroup) return;
    try {
      await ipc.groupDelete({ id: pendingDeleteGroup.id });
      toast.success("用户组已删除");
      setPendingDeleteGroup(null);
      refreshGroups();
    } catch (e) {
      toast.error(`删除失败：${e}`);
    }
  };

  const saveConfig = () => {
    if (!config) return;
    ipc
      .configUpdate(config)
      .then(() => toast.success("配置已保存"))
      .catch((e) => toast.error(`保存失败：${e}`));
  };

  const confirmDeleteUser = () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setDeleting(true);
    ipc
      .userDelete({ id: target.id })
      .then(() => {
        setUsers((prev) => prev.filter((u) => u.id !== target.id));
        toast.success(`用户「${target.name}」已删除`);
        setPendingDelete(null);
      })
      .catch((e) => toast.error(`删除失败：${e}`))
      .finally(() => setDeleting(false));
  };

  const refreshMcp = useCallback(() => {
    ipc.mcpList().then((r) => setMcpServers(r.servers ?? [])).catch(() => {});
  }, []);

  /** 拉取某 MCP server 的工具清单（会拉起进程，可能耗时） */
  const openMcpTools = async (id: string) => {
    setMcpTools({ server: id, tools: [] });
    setMcpToolsLoading(true);
    try {
      const r = await ipc.mcpTools({ id });
      setMcpTools({ server: id, tools: r.tools ?? [] });
      if (r.error) toast.error(`获取工具失败：${r.error}`);
    } catch (e) {
      toast.error(`获取工具失败：${e}`);
    } finally {
      setMcpToolsLoading(false);
    }
  };

  const saveMcp = () => {
    if (!mcpEditor || !mcpEditor.name.trim() || !mcpEditor.command.trim()) return;
    setMcpSaving(true);
    // args / env 支持空白分隔与 KEY=VALUE 行，便于填写
    const args = mcpEditor.args.split(/\s+/).filter(Boolean);
    const env: Record<string, string> = {};
    for (const line of mcpEditor.env.split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/);
      if (m) env[m[1]] = m[2];
    }
    ipc
      .mcpUpsert({
        id: mcpEditor.id,
        name: mcpEditor.name.trim(),
        command: mcpEditor.command.trim(),
        args,
        env,
        cwd: mcpEditor.cwd.trim() || undefined,
        enabled: true,
      })
      .then(() => {
        toast.success(mcpEditor.id ? "MCP 服务器已更新" : "MCP 服务器已添加");
        setMcpEditor(null);
        refreshMcp();
      })
      .catch((e) => toast.error(`保存失败：${e}`))
      .finally(() => setMcpSaving(false));
  };

  const addUser = (input: { name: string; username: string; password: string; role: "user" | "admin"; canManageConsole: boolean }) => {
    ipc
      .userCreate(input)
      .then(() => ipc.userList())
      .then((res) => {
        setUsers(res.users);
        toast.success(`用户「${input.name}」已添加`);
      })
      .catch((e) => toast.error(`添加失败：${e}`))
      .finally(() => setShowAddUser(false));
  };

  /** Agent 进程启停（此前仅有 API，UI 无入口） */
  const togglePi = async () => {
    setPiBusy(true);
    try {
      if (piStatus?.running) {
        await ipc.piStop();
        toast.success("Agent 进程已停止");
      } else {
        const ok = await ipc.piStart();
        if (ok) toast.success("Agent 进程已启动");
        else toast.error("启动失败：请检查引擎 CLI 是否已安装");
      }
      refreshPi();
    } catch (e) {
      toast.error(`操作失败：${e}`);
    } finally {
      setPiBusy(false);
    }
  };

  if (!config) {
    return (
      <PageShell title="Settings" description="用户、进程与系统配置">
        <div className="card px-4 py-10 text-center text-[11.5px] text-fg-faint">加载中…</div>
      </PageShell>
    );
  }

  return (
    <PageShell
      title="Settings"
      description="用户、进程与系统配置"
      actions={
        <Button variant="primary" onClick={saveConfig}>
          保存配置
        </Button>
      }
    >
      <div className="space-y-6 max-w-3xl">
        {/* 运行时进程 */}
        <section>
          <h2 className="text-[12.5px] font-semibold text-fg-muted mb-2.5">运行时</h2>
          <div className="card px-4 py-3.5 flex items-center gap-3">
            <span className={`shrink-0 w-2 h-2 rounded-full ${piStatus?.running ? "bg-green animate-breathe-soft" : "bg-n-600"}`} />
            <div className="min-w-0">
              <p className="text-[12.5px] text-fg-muted">
                {piStatus?.running ? "Agent 进程运行中" : "Agent 进程未运行"}
              </p>
              <p className="text-[10.5px] text-fg-faint mt-0.5">
                {piStatus?.pid ? `PID ${piStatus.pid}` : "进程由平台统一拉起并提供治理能力"}
              </p>
            </div>
            <div className="ml-auto shrink-0">
              <Button
                variant={piStatus?.running ? "danger" : "default"}
                icon={piStatus?.running ? <IconStop size={12} /> : <IconPlay size={12} />}
                onClick={togglePi}
                disabled={piBusy}
              >
                {piBusy ? "处理中…" : piStatus?.running ? "停止" : "启动"}
              </Button>
            </div>
          </div>
        </section>

        {/* 用户管理 */}
        <section>
          <div className="flex items-center justify-between mb-2.5">
            <h2 className="text-[12.5px] font-semibold text-fg-muted">用户</h2>
            <Button size="sm" icon={<IconPlus size={12} />} onClick={() => setShowAddUser(true)}>
              添加用户
            </Button>
          </div>

          <div className="card overflow-hidden">
            {users.length === 0 ? (
              <EmptyState
                compact
                icon={<IconUsers size={16} />}
                title="暂无用户"
                description="添加后可将 Worker 指派给对应成员。"
              />
            ) : (
              users.map((u, i) => (
                <div
                  key={u.id}
                  className={`flex items-center gap-3 px-4 py-2.5 ${i > 0 ? "border-t border-line" : ""}`}
                >
                  <div className="size-7 rounded-full bg-n-850 border border-line flex items-center justify-center shrink-0">
                    <span className="text-[10px] font-medium text-fg-subtle">
                      {u.name.slice(0, 2)}
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[12.5px] text-fg-muted truncate">{u.name}</span>
                      {u.canManageConsole && u.role !== "admin" && (
                        <span className="text-[9.5px] font-medium px-1.5 py-0.5 rounded bg-primary-bg/60 text-primary border border-primary-border/50">
                          后台
                        </span>
                      )}
                    </div>
                    <div className="text-[10.5px] text-fg-faint truncate">@{u.username}</div>
                  </div>
                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                    u.role === "admin"
                      ? "bg-primary-bg text-primary border border-primary-border"
                      : "bg-n-850 text-fg-subtle border border-line"
                  }`}>
                    {u.role}
                  </span>
                  <span className="text-[10.5px] text-fg-faint hidden sm:block">{new Date(u.createdAt).toLocaleDateString()}</span>
                  <Button size="sm" variant="ghost" onClick={() => setEditTarget(u)}>
                    编辑
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setResetTarget(u)}>
                    重置密码
                  </Button>
                  <Button size="sm" variant="ghost" title="强制该用户重新登录（不改密码）" onClick={() => setRevokeTarget(u)}>
                    吊销会话
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => setPendingDelete(u)}>
                    删除
                  </Button>
                </div>
              ))
            )}
          </div>
        </section>

        {/* 登录历史 */}
        <section>
          <div className="flex items-center justify-between mb-2.5">
            <h2 className="text-[12.5px] font-semibold text-fg-muted">登录历史</h2>
            <Button size="sm" onClick={refreshHistory} disabled={historyLoading}>
              {historyLoading ? "刷新中…" : "刷新"}
            </Button>
          </div>
          <div className="card overflow-hidden">
            {history.length === 0 ? (
              <EmptyState
                compact
                icon={<IconUsers size={16} />}
                title="近 7 天没有认证事件"
                description="登录、登出、吊销会话、修改密码都会记录在这里（源自审计日志）。"
              />
            ) : (
              <div className="max-h-64 overflow-y-auto">
                {history.map((h, i) => (
                  <div
                    key={`${h.timestamp}-${i}`}
                    className={`flex items-center gap-3 px-4 py-2 ${i > 0 ? "border-t border-line" : ""}`}
                  >
                    <span className="text-[10.5px] font-mono text-fg-faint whitespace-nowrap">
                      {new Date(h.timestamp).toLocaleString()}
                    </span>
                    <span className="text-[11.5px] text-fg-muted truncate">@{h.username}</span>
                    <span className="text-[11px] text-fg-subtle">{h.action}</span>
                    <span className="ml-auto">
                      {h.ok ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-bg text-green font-medium">成功</span>
                      ) : (
                        <span
                          className="text-[10px] px-1.5 py-0.5 rounded bg-red-bg text-red font-medium"
                          title={h.reason}
                        >
                          失败
                        </span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <p className="mt-2 text-[10.5px] text-fg-faint">
            展示近 7 天最多 100 条认证事件；连续失败登录与锁定也会计入。数据源自审计日志，受哈希链保护。
          </p>
        </section>

        {/* 用户组 */}
        <section>
          <div className="flex items-center justify-between mb-2.5">
            <h2 className="text-[12.5px] font-semibold text-fg-muted">用户组</h2>
            <Button size="sm" icon={<IconPlus size={12} />} onClick={() => setGroupEditor({ name: "", memberIds: [] })}>
              新建用户组
            </Button>
          </div>
          <div className="card overflow-hidden">
            {groups.length === 0 ? (
              <EmptyState
                compact
                icon={<IconUsers size={16} />}
                title="还没有用户组"
                description="创建组后，可以在 Worker 的「分配」里让整组成员都能使用该 Agent。"
              />
            ) : (
              groups.map((g, i) => (
                <div
                  key={g.id}
                  className={`flex items-center gap-3 px-4 py-2.5 ${i > 0 ? "border-t border-line" : ""}`}
                >
                  <IconUsers size={14} className="shrink-0 text-fg-faint" />
                  <span className="text-[12.5px] text-fg-muted truncate">{g.name}</span>
                  <span className="text-[10.5px] text-fg-faint truncate flex-1">
                    {g.memberIds.map((id) => users.find((u) => u.id === id)?.name ?? id).join("、") || "无成员"}
                  </span>
                  <span className="ml-auto shrink-0 text-[10.5px] text-fg-faint">{g.memberIds.length} 人</span>
                  <Button size="sm" variant="ghost" onClick={() => setGroupEditor({ id: g.id, name: g.name, memberIds: g.memberIds })}>
                    编辑
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => setPendingDeleteGroup(g)}>
                    删除
                  </Button>
                </div>
              ))
            )}
          </div>
        </section>

        {/* MCP 服务器（外部工具，调用过策略 + 审计） */}
        <section>
          <div className="flex items-center justify-between mb-2.5">
            <h2 className="text-[12.5px] font-semibold text-fg-muted">MCP 服务器</h2>
            <Button size="sm" icon={<IconPlus size={12} />} onClick={() => setMcpEditor({ name: "", command: "", args: "", env: "", cwd: "" })}>
              添加服务器
            </Button>
          </div>

          <div className="card overflow-hidden">
            {mcpServers.length === 0 ? (
              <EmptyState
                compact
                icon={<IconNetwork size={16} />}
                title="还没有 MCP 服务器"
                description="接入后，Agent 可调用外部工具（文件/数据库/检索…），且每次调用都会过策略与审计。"
              />
            ) : (
              mcpServers.map((s, i) => (
                <div
                  key={s.id}
                  className={`flex items-center gap-3 px-4 py-2.5 ${i > 0 ? "border-t border-line" : ""}`}
                >
                  <span className={`shrink-0 w-2 h-2 rounded-full ${s.running ? "bg-green animate-breathe-soft" : "bg-n-600"}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[12.5px] text-fg-muted truncate">{s.name}</span>
                      {!s.enabled && (
                        <span className="text-[9.5px] px-1.5 py-0.5 rounded bg-n-850 text-fg-faint border border-line">已禁用</span>
                      )}
                    </div>
                    <div className="text-[10.5px] text-fg-faint truncate font-mono">
                      {s.command} {s.args.join(" ")}
                    </div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => void openMcpTools(s.id)}>
                    工具
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setMcpEditor({ id: s.id, name: s.name, command: s.command, args: s.args.join(" "), env: "", cwd: s.cwd ?? "" })}>
                    编辑
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => setPendingDeleteMcp(s)}>
                    删除
                  </Button>
                </div>
              ))
            )}
          </div>
        </section>

        {/* 系统配置 */}
        <section>
          <h2 className="text-[12.5px] font-semibold text-fg-muted mb-2.5">系统配置</h2>
          <div className="card p-5 space-y-4">
            <FieldRow label="搜索代理">
              <input
                value={config.searchProxy}
                onChange={(e) => setConfig({ ...config, searchProxy: e.target.value })}
                placeholder="http://localhost:1080"
                className="field"
              />
            </FieldRow>

            <FieldRow label="审计目录">
              <input
                value={config.auditDir}
                onChange={(e) => setConfig({ ...config, auditDir: e.target.value })}
                placeholder="留空则使用 <项目根>/audit"
                className="field font-mono"
              />
            </FieldRow>

            <FieldRow label="最大并发 Worker">
              <input
                type="number"
                value={config.maxWorkers}
                onChange={(e) => setConfig({ ...config, maxWorkers: Math.max(1, Number(e.target.value)) })}
                className="field max-w-[120px]"
              />
            </FieldRow>

            <FieldRow label="任务超时（毫秒）">
              <input
                type="number"
                value={config.taskTimeoutMs}
                onChange={(e) => setConfig({ ...config, taskTimeoutMs: Math.max(1000, Number(e.target.value)) })}
                className="field max-w-[160px]"
              />
            </FieldRow>

            <FieldRow label="子 Agent 委派深度上限">
              <input
                type="number"
                min={1}
                max={8}
                value={config.maxDelegationDepth ?? 2}
                onChange={(e) => setConfig({ ...config, maxDelegationDepth: Math.min(8, Math.max(1, Number(e.target.value) || 2)) })}
                className="field max-w-[120px]"
              />
            </FieldRow>
          </div>
          <p className="mt-2 text-[10.5px] text-fg-faint">
            委派深度：1 = 子 Agent 不能再向外委派；2 = 允许 A→B→C 两级（默认）。
          </p>
          <p className="mt-2 text-[10.5px] text-fg-faint">
            环境变量优先级高于此处配置；.env 仅在变量未设置时生效。
          </p>
        </section>

        {/* 知识库向量化（RAG） */}
        <section>
          <h2 className="text-[12.5px] font-semibold text-fg-muted mb-2.5">知识库向量化（RAG）</h2>
          <div className="card p-5 space-y-4">
            <FieldRow label="Embedding Provider">
              <select
                value={config.embedding?.providerId ?? ""}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    embedding: { providerId: e.target.value, model: config.embedding?.model ?? "" },
                  })
                }
                className="field cursor-pointer"
              >
                <option value="">（未配置 — 知识库摄取/检索不可用）</option>
                {config.providers.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </FieldRow>

            <FieldRow label="Embedding 模型">
              <input
                value={config.embedding?.model ?? ""}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    embedding: { providerId: config.embedding?.providerId ?? "", model: e.target.value },
                  })
                }
                placeholder="text-embedding-3-small"
                className="field font-mono"
              />
            </FieldRow>
          </div>
          <p className="mt-2 text-[10.5px] text-fg-faint">
            复用所选 Provider 的地址与密钥：OpenAI 兼容调 /embeddings，Ollama 调 /api/embed。
            保存后到「知识库」页添加文档。
          </p>
        </section>

        {/* 通知（无人值守结果外推） */}
        <section>
          <h2 className="text-[12.5px] font-semibold text-fg-muted mb-2.5">通知</h2>
          <div className="card p-5 space-y-4">
            <FieldRow label="Webhook 地址">
              <input
                value={config.notifyWebhook ?? ""}
                onChange={(e) => setConfig({ ...config, notifyWebhook: e.target.value })}
                placeholder="留空则只写站内通知（顶栏铃铛）"
                className="field font-mono"
              />
            </FieldRow>

            <div className="flex items-center gap-3">
              <Button
                size="sm"
                disabled={notifyTesting}
                onClick={async () => {
                  setNotifyTesting(true);
                  try {
                    const r = await ipc.notifyTest();
                    if (r.ok) {
                      toast.success("测试通知已发送（Webhook + 站内）");
                    } else if (!r.sent) {
                      toast.error(`未发送：${r.error ?? "未配置 Webhook"}`);
                    } else {
                      toast.error(`Webhook 发送失败：${r.error ?? "未知错误"}`);
                    }
                  } catch (e) {
                    toast.error(`测试失败：${e}`);
                  } finally {
                    setNotifyTesting(false);
                  }
                }}
              >
                {notifyTesting ? "发送中…" : "发送测试通知"}
              </Button>
              <span className="text-[10.5px] text-fg-faint">
                读取已保存的配置 —— 改完地址请先「保存配置」再测试
              </span>
            </div>
          </div>
          <p className="mt-2 text-[10.5px] text-fg-faint">
            定时任务完成 / 失败、预算耗尽等后台事件会推到这里；留空则只在顶栏铃铛提醒。
            飞书、钉钉群机器人地址会被自动识别并按各自格式发送，其余按通用 JSON POST。
          </p>
        </section>
      </div>

      <AddUserDialog
        open={showAddUser}
        onClose={() => setShowAddUser(false)}
        onAdd={addUser}
      />

      {/* MCP 服务器编辑器 */}
      <Modal
        open={mcpEditor !== null}
        title={mcpEditor?.id ? "编辑 MCP 服务器" : "添加 MCP 服务器"}
        onClose={() => setMcpEditor(null)}
        widthClass="max-w-lg"
        footer={
          <>
            <Button onClick={() => setMcpEditor(null)}>取消</Button>
            <Button variant="primary" onClick={saveMcp} disabled={mcpSaving || !mcpEditor?.name.trim() || !mcpEditor?.command.trim()}>
              {mcpSaving ? "保存中…" : "保存"}
            </Button>
          </>
        }
      >
        <div className="space-y-3.5">
          <div>
            <label className="block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint mb-1.5">
              名称
            </label>
            <input
              autoFocus
              value={mcpEditor?.name ?? ""}
              onChange={(e) => setMcpEditor((p) => (p ? { ...p, name: e.target.value } : p))}
              placeholder="例如 Filesystem"
              className="field"
            />
          </div>
          <div>
            <label className="block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint mb-1.5">
              启动命令
            </label>
            <input
              value={mcpEditor?.command ?? ""}
              onChange={(e) => setMcpEditor((p) => (p ? { ...p, command: e.target.value } : p))}
              placeholder="npx"
              className="field font-mono"
            />
          </div>
          <div>
            <label className="block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint mb-1.5">
              参数（空格分隔）
            </label>
            <input
              value={mcpEditor?.args ?? ""}
              onChange={(e) => setMcpEditor((p) => (p ? { ...p, args: e.target.value } : p))}
              placeholder="-y @modelcontextprotocol/server-filesystem D:\\project"
              className="field font-mono"
            />
          </div>
          <div>
            <label className="block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint mb-1.5">
              工作目录（可选）
            </label>
            <input
              value={mcpEditor?.cwd ?? ""}
              onChange={(e) => setMcpEditor((p) => (p ? { ...p, cwd: e.target.value } : p))}
              placeholder="留空则用项目根目录"
              className="field font-mono"
            />
          </div>
          <div>
            <label className="block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint mb-1.5">
              环境变量（每行 KEY=VALUE，可选）
            </label>
            <textarea
              value={mcpEditor?.env ?? ""}
              onChange={(e) => setMcpEditor((p) => (p ? { ...p, env: e.target.value } : p))}
              placeholder={"GITHUB_TOKEN=${EAG_GITHUB_TOKEN}"}
              rows={3}
              className="field font-mono resize-none"
            />
            <p className="mt-1.5 text-[10.5px] text-fg-faint">
              支持 {"${ENV_VAR}"} 占位符，密钥不落明文。
            </p>
          </div>
        </div>
      </Modal>

      {/* MCP 工具清单 */}
      <Modal
        open={mcpTools !== null}
        title="MCP 工具"
        onClose={() => setMcpTools(null)}
        widthClass="max-w-lg"
        footer={<Button onClick={() => setMcpTools(null)}>关闭</Button>}
      >
        {mcpToolsLoading ? (
          <p className="py-6 text-center text-[11.5px] text-fg-faint">正在启动 MCP 服务器并拉取工具…</p>
        ) : (mcpTools?.tools.length ?? 0) === 0 ? (
          <p className="py-6 text-center text-[11.5px] text-fg-faint">没有可用工具（服务器可能未正确启动）</p>
        ) : (
          <div className="max-h-80 overflow-y-auto space-y-1">
            {mcpTools?.tools.map((t) => (
              <div key={t.qualifiedName} className="px-3 py-2 rounded-lg border border-line">
                <div className="text-[12px] text-fg-muted font-mono">{t.name}</div>
                {t.description && (
                  <div className="text-[10.5px] text-fg-faint mt-0.5 leading-relaxed">{t.description}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </Modal>

      {/* 删除 MCP 服务器 */}
      <ConfirmModal
        open={pendingDeleteMcp !== null}
        title="删除该 MCP 服务器？"
        description={`「${pendingDeleteMcp?.name ?? ""}」的配置将被移除，正在运行的进程会被停止。`}
        confirmText="删除"
        danger
        onCancel={() => setPendingDeleteMcp(null)}
        onConfirm={async () => {
          if (!pendingDeleteMcp) return;
          try {
            await ipc.mcpDelete({ id: pendingDeleteMcp.id });
            toast.success("已删除");
            setPendingDeleteMcp(null);
            refreshMcp();
          } catch (e) {
            toast.error(`删除失败：${e}`);
          }
        }}
      />

      {/* 编辑用户 */}
      <EditUserDialog
        user={editTarget}
        onClose={() => setEditTarget(null)}
        onSaved={() => ipc.userList().then((res) => setUsers(res.users)).catch(() => {})}
      />

      {/* 重置密码 */}
      <Modal
        open={resetTarget !== null}
        title={`重置「${resetTarget?.name ?? ""}」的密码`}
        onClose={() => { setResetTarget(null); setResetPwd(""); }}
        widthClass="max-w-sm"
        footer={
          <>
            <Button onClick={() => { setResetTarget(null); setResetPwd(""); }}>取消</Button>
            <Button
              variant="primary"
              disabled={resetting || !passwordPolicyOk(resetPwd)}
              onClick={() => {
                if (!resetTarget) return;
                setResetting(true);
                ipc.userUpdate({ id: resetTarget.id, password: resetPwd })
                  .then(() => {
                    toast.success(`已重置「${resetTarget.name}」的密码`);
                    setResetTarget(null);
                    setResetPwd("");
                  })
                  .catch((e) => toast.error(`重置失败：${e}`))
                  .finally(() => setResetting(false));
              }}
            >
              {resetting ? "重置中…" : "重置密码"}
            </Button>
          </>
        }
      >
        <div>
          <label className="block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint mb-1.5">
            新密码（{PASSWORD_POLICY_LABEL}）
          </label>
          <input
            type="password"
            autoFocus
            value={resetPwd}
            onChange={(e) => setResetPwd(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && passwordPolicyOk(resetPwd) && !resetting && (e.target as HTMLInputElement).form?.requestSubmit()}
            placeholder="••••••••"
            className="field"
          />
          <p className="mt-2 text-[10.5px] text-fg-faint">
            重置后该用户所有已登录会话将立即失效，需用新密码重新登录。
          </p>
        </div>
      </Modal>

      {/* 用户组编辑器 */}
      <Modal
        open={groupEditor !== null}
        title={groupEditor?.id ? "编辑用户组" : "新建用户组"}
        onClose={() => setGroupEditor(null)}
        widthClass="max-w-md"
        footer={
          <>
            <Button onClick={() => setGroupEditor(null)}>取消</Button>
            <Button variant="primary" onClick={saveGroup} disabled={groupSaving || !groupEditor?.name.trim()}>
              {groupSaving ? "保存中…" : "保存"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint mb-1.5">
              组名
            </label>
            <input
              autoFocus
              value={groupEditor?.name ?? ""}
              onChange={(e) => setGroupEditor((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
              placeholder="例如：后端团队"
              className="field"
            />
          </div>

          <div>
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint mb-2">
              成员（已选 {groupEditor?.memberIds.length ?? 0}）
            </div>
            <div className="space-y-0.5 max-h-52 overflow-y-auto rounded-lg border border-line p-1.5">
              {users.length === 0 ? (
                <p className="px-2 py-2 text-[11px] text-fg-faint">暂无用户</p>
              ) : (
                users.map((u) => {
                  const checked = groupEditor?.memberIds.includes(u.id) ?? false;
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
                          setGroupEditor((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  memberIds: checked
                                    ? prev.memberIds.filter((x) => x !== u.id)
                                    : [...prev.memberIds, u.id],
                                }
                              : prev,
                          )
                        }
                        className="accent-primary size-3.5 shrink-0"
                      />
                      <span className="text-[12px] text-fg-muted truncate">{u.name}</span>
                      <span className="text-[10px] text-fg-faint">{u.role}</span>
                    </label>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </Modal>

      {/* 删除用户组确认 */}
      <ConfirmModal
        open={pendingDeleteGroup !== null}
        title="删除该用户组？"
        description={pendingDeleteGroup ? `「${pendingDeleteGroup.name}」将被移除；已分配给该组的 Worker 会失去组内可见性（直接分配不受影响）。` : undefined}
        confirmText="删除"
        danger
        onCancel={() => setPendingDeleteGroup(null)}
        onConfirm={confirmDeleteGroup}
      />

      {/* 吊销会话确认 */}
      <ConfirmModal
        open={revokeTarget !== null}
        title="吊销该用户的全部会话？"
        description={revokeTarget
          ? `「${revokeTarget.name}」的所有登录态将立即失效（含其他设备），需重新登录。密码不变，适用于 token 疑似泄漏或临时冻结。`
          : undefined}
        confirmText="吊销会话"
        danger
        busy={revoking}
        onCancel={() => setRevokeTarget(null)}
        onConfirm={confirmRevoke}
      />

      {/* 删除用户确认（替代 window.confirm） */}
      <ConfirmModal
        open={pendingDelete !== null}
        title="删除该用户？"
        description={pendingDelete
          ? `「${pendingDelete.name}」将被移除；其名称会同时从所有 Agent 的分配列表与用户组中清除（Agent 本身保留）。`
          : undefined}
        confirmText="删除"
        danger
        busy={deleting}
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDeleteUser}
      />
    </PageShell>
  );
}

/* ------------------------------------------------------------------ */
/*  通用                                                                 */
/* ------------------------------------------------------------------ */

function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4">
      <label className="w-36 shrink-0 text-[11.5px] text-fg-subtle">{label}</label>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}
