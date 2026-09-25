import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import * as ipc from "../lib/ipc.ts";
import { passwordPolicyOk, PASSWORD_POLICY_LABEL } from "../lib/password.ts";
import {
  IconChevronRight, IconCheck,
  IconSun, IconMoon, IconMonitor, IconInbox, IconLogout, IconEdit, IconBell,
} from "./icons.tsx";
import Dropdown, { MenuItem, MenuDivider, MenuLabel } from "./Dropdown.tsx";
import { Modal } from "./Modal.tsx";
import Button from "./Button.tsx";
import { useToast } from "./Toast.tsx";
import { useUserStore } from "../stores/userStore.ts";
import { useThemeStore } from "../stores/themeStore.ts";
import { useApprovalStore, countPendingApprovals } from "../stores/approvalStore.ts";
import type { SystemStatus, NotifyEvent } from "@shared/types.ts";

/** 通知级别 → 圆点颜色 */
const NOTIFY_DOT: Record<NotifyEvent["level"], string> = {
  info: "bg-primary",
  success: "bg-green",
  warn: "bg-yellow",
  error: "bg-red",
};

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / 日期 */
function fmtNotifyTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

interface Props { isAdmin: boolean }

export default function TopBar({ isAdmin }: Props) {
  // 身份：顶栏展示当前登录账号，可退出登录
  const session = useUserStore((s) => s.session);
  const loadUsers = useUserStore((s) => s.load);
  const logout = useUserStore((s) => s.logout);
  const changePassword = useUserStore((s) => s.changePassword);

  // 修改自己的密码
  const [showChangePwd, setShowChangePwd] = useState(false);
  const [pwdOld, setPwdOld] = useState("");
  const [pwdNew, setPwdNew] = useState("");
  const [pwdConfirm, setPwdConfirm] = useState("");
  const [pwdBusy, setPwdBusy] = useState(false);

  // 通知（无人值守结果）：仅后台权限用户可见，30s 轮询未读数
  const canConsole = !!session && (session.role === "admin" || session.canManageConsole);
  const [notifyItems, setNotifyItems] = useState<NotifyEvent[]>([]);
  const [notifyUnread, setNotifyUnread] = useState(0);

  const refreshNotify = useCallback(() => {
    if (!canConsole) return;
    ipc.notifyList()
      .then((r) => { setNotifyItems(r.items ?? []); setNotifyUnread(r.unread ?? 0); })
      .catch(() => {});
  }, [canConsole]);

  useEffect(() => {
    refreshNotify();
    if (!canConsole) return;
    const iv = setInterval(refreshNotify, 30_000);
    return () => clearInterval(iv);
  }, [refreshNotify, canConsole]);

  const themeMode = useThemeStore((s) => s.mode);
  const setThemeMode = useThemeStore((s) => s.setMode);

  // 待批审批角标（参考 QwenPaw 的 Inbox 提醒）
  const approvals = useApprovalStore((s) => s.approvals);
  const loadApprovals = useApprovalStore((s) => s.load);
  const pendingApprovals = countPendingApprovals(approvals);

  const toast = useToast();
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const loc = useLocation();
  const nav = useNavigate();

  useEffect(() => {
    void loadUsers();
    void loadApprovals();
    ipc.statusGet().then(setStatus).catch(() => {});
    const iv = setInterval(() => ipc.statusGet().then(setStatus).catch(() => {}), 5000);
    return () => clearInterval(iv);
  }, [loadUsers, loadApprovals]);

  const pageTitle = (() => {
    const p = loc.pathname;
    if (p.startsWith("/app/chat/")) return "会话";
    if (p.startsWith("/admin/inbox")) return "Inbox";
    if (p.startsWith("/admin/workers")) return "Workers";
    if (p.startsWith("/admin/models")) return "Models";
    if (p.startsWith("/admin/audit")) return "Audit";
    if (p.startsWith("/admin/policy")) return "Policy";
    if (p.startsWith("/admin/swarm")) return "Swarm";
    if (p.startsWith("/admin/settings")) return "Settings";
    return "工作区";
  })();

  const userId = session?.userId ?? status?.userId ?? "";
  const initials = userId.slice(0, 2).toUpperCase() || "—";
  const running = !!status?.piRunning;

  return (
    // relative z-40：顶栏在 DOM 中位于 <main> 之前，页面内的 positioned 元素
    // 可能在绘制顺序上盖住它；给顶栏一个正层级，确保其自身及内部 badge 等
    // 始终压在页面内容之上。下拉菜单已由 Dropdown 组件 Portal 到 body（z-60），
    // 不再依赖此层级。取 40 < Modal(50)，保证模态框仍能盖住顶栏。
    <header className="relative z-40 shrink-0 h-14 bg-surface/50 backdrop-blur-sm border-b border-line flex items-center px-5 gap-4">
      {/* 面包屑 */}
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="text-[12px] text-fg-faint">EAG</span>
        <IconChevronRight size={13} className="text-fg-faint/60 shrink-0" />
        <span className="text-[12.5px] font-medium text-fg-muted truncate">{pageTitle}</span>
      </div>

      <div className="flex-1" />

      {/* 模型选择已移到会话页（WorkChat）：
          全局默认 Provider 属管理员配置（Models 页），用户对模型的临时切换
          是"本 Agent + 我"的会话级行为，不应出现在全局顶栏。 */}

      {/* 审批收件箱：仅管理员可见（审批是治理信息） */}
      {session?.role === "admin" && (
        <button
          onClick={() => nav("/admin/inbox")}
          title={pendingApprovals > 0 ? `${pendingApprovals} 条待批审批` : "审批收件箱"}
          className={`relative p-2 rounded-lg transition-colors ${
            pendingApprovals > 0
              ? "text-yellow hover:bg-yellow-bg"
              : "text-fg-subtle hover:text-fg-muted hover:bg-n-850/60"
          }`}
        >
          <IconInbox size={15} />
          {pendingApprovals > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-0.5 rounded-full bg-yellow text-n-1000 text-[9px] font-bold flex items-center justify-center tabular-nums">
              {pendingApprovals > 99 ? "99+" : pendingApprovals}
            </span>
          )}
        </button>
      )}

      {/* 通知：无人值守结果（定时任务完成/失败、预算耗尽…）—— 仅后台权限可见 */}
      {canConsole && (
        <Dropdown
          widthClass="w-80"
          trigger={() => (
            <button
              title={notifyUnread > 0 ? `${notifyUnread} 条未读通知` : "通知"}
              className={`relative p-2 rounded-lg transition-colors ${
                notifyUnread > 0
                  ? "text-primary hover:bg-primary-bg"
                  : "text-fg-subtle hover:text-fg-muted hover:bg-n-850/60"
              }`}
            >
              <IconBell size={15} />
              {notifyUnread > 0 && (
                <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-0.5 rounded-full bg-primary text-white text-[9px] font-bold flex items-center justify-center tabular-nums">
                  {notifyUnread > 99 ? "99+" : notifyUnread}
                </span>
              )}
            </button>
          )}
        >
          {() => (
            <>
              <div className="flex items-center justify-between px-3 py-1">
                <span className="text-[11px] font-semibold text-fg-muted">通知</span>
                {notifyUnread > 0 && (
                  <button
                    className="text-[10.5px] text-primary hover:underline"
                    onClick={async () => {
                      const r = await ipc.notifyRead({});
                      setNotifyItems(r.items ?? []);
                      setNotifyUnread(r.unread ?? 0);
                    }}
                  >
                    全部已读
                  </button>
                )}
              </div>
              <MenuDivider />
              <div className="max-h-72 overflow-y-auto">
                {notifyItems.length === 0 ? (
                  <div className="px-3 py-6 text-center text-[11px] text-fg-faint">
                    暂无通知（定时任务完成后会出现在这里）
                  </div>
                ) : (
                  notifyItems.slice(0, 20).map((n) => (
                    <div key={n.id} className="px-3 py-2 hover:bg-n-850/40 transition-colors">
                      <div className="flex items-start gap-2">
                        <span className={`mt-[5px] size-1.5 rounded-full shrink-0 ${NOTIFY_DOT[n.level]}`} />
                        <div className="min-w-0 flex-1">
                          <div className={`text-[11.5px] leading-snug break-words ${n.read ? "text-fg-subtle" : "text-fg-muted font-medium"}`}>
                            {n.title}
                          </div>
                          {n.body && (
                            <div className="text-[10.5px] text-fg-faint mt-0.5 whitespace-pre-wrap break-words line-clamp-3">
                              {n.body}
                            </div>
                          )}
                          <div className="text-[10px] text-fg-faint/80 mt-1">{fmtNotifyTime(n.at)}</div>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
              {notifyItems.length > 0 && (
                <>
                  <MenuDivider />
                  <div className="px-2 py-1">
                    <button
                      className="w-full text-center px-2 py-1.5 rounded-md text-[11px] text-fg-faint hover:text-red hover:bg-red-bg transition-colors"
                      onClick={async () => {
                        await ipc.notifyClear();
                        setNotifyItems([]);
                        setNotifyUnread(0);
                      }}
                    >
                      清空全部
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </Dropdown>
      )}

      {/* 运行状态 */}
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-n-900/80 border border-line">
        <span className="relative flex items-center justify-center shrink-0">
          <span className={`w-1.5 h-1.5 rounded-full ${running ? "bg-green" : "bg-n-600"}`} />
          {running && <span className="absolute w-1.5 h-1.5 rounded-full bg-green animate-breathe" />}
        </span>
        <span className="text-[11.5px] text-fg-subtle font-medium">
          {running ? "Agent 运行中" : "空闲"}
        </span>
      </div>

      {/* 主题切换（dark / light / system，参考 QwenPaw 的主题链路） */}
      <Dropdown
        widthClass="w-40"
        trigger={() => (
          <button
            title="主题"
            className="p-2 rounded-lg text-fg-subtle hover:text-fg-muted hover:bg-n-850/60 transition-colors"
          >
            {themeMode === "light"
              ? <IconSun size={15} />
              : themeMode === "dark"
                ? <IconMoon size={15} />
                : <IconMonitor size={15} />}
          </button>
        )}
      >
        {(close) => (
          <>
            <MenuItem
              icon={<IconMoon size={13} />}
              label="深色"
              active={themeMode === "dark"}
              hint={themeMode === "dark" ? <IconCheck size={12} className="text-primary" /> : undefined}
              onClick={() => { setThemeMode("dark"); close(); }}
            />
            <MenuItem
              icon={<IconSun size={13} />}
              label="浅色"
              active={themeMode === "light"}
              hint={themeMode === "light" ? <IconCheck size={12} className="text-primary" /> : undefined}
              onClick={() => { setThemeMode("light"); close(); }}
            />
            <MenuItem
              icon={<IconMonitor size={13} />}
              label="跟随系统"
              active={themeMode === "system"}
              hint={themeMode === "system" ? <IconCheck size={12} className="text-primary" /> : undefined}
              onClick={() => { setThemeMode("system"); close(); }}
            />
          </>
        )}
      </Dropdown>

      {/* 当前用户 + 退出登录 */}
      <Dropdown
        widthClass="w-52"
        trigger={() => (
          <button
            title="账户"
            className="flex items-center gap-2 pl-3 border-l border-line hover:opacity-85 transition-opacity cursor-pointer"
          >
            <div className="size-6 rounded-full bg-gradient-to-br from-n-700 to-n-800 border border-line-strong flex items-center justify-center">
              <span className="text-[10px] font-semibold text-fg-muted">{initials}</span>
            </div>
            <span className="text-[11.5px] text-fg-subtle font-medium">{session?.username || userId || "—"}</span>
          </button>
        )}
      >
        {(close) => (
          <>
            <MenuLabel>{session?.userName ?? "—"}</MenuLabel>
            <div className="px-3 pb-1 text-[10.5px] text-fg-faint leading-relaxed">
              {session?.role === "admin" ? "管理员" : session?.canManageConsole ? "用户 · 已授权后台" : "用户"}
            </div>
            <MenuDivider />
            <MenuItem
              icon={<IconEdit size={13} />}
              label="修改密码"
              onClick={() => {
                close();
                setPwdOld("");
                setPwdNew("");
                setPwdConfirm("");
                setShowChangePwd(true);
              }}
            />
            <MenuItem
              icon={<IconLogout size={13} />}
              label="退出登录"
              danger
              onClick={async () => {
                close();
                await logout();
                nav("/login", { replace: true });
                toast.success("已退出登录");
              }}
            />
          </>
        )}
      </Dropdown>

      {/* 修改自己的密码 */}
      <Modal
        open={showChangePwd}
        title="修改密码"
        onClose={() => setShowChangePwd(false)}
        widthClass="max-w-sm"
        footer={
          <>
            <Button onClick={() => setShowChangePwd(false)}>取消</Button>
            <Button
              variant="primary"
              disabled={pwdBusy || pwdOld.length === 0 || !passwordPolicyOk(pwdNew) || pwdConfirm !== pwdNew}
              onClick={async () => {
                setPwdBusy(true);
                const ok = await changePassword(pwdOld, pwdNew);
                setPwdBusy(false);
                if (ok) {
                  toast.success("密码已修改，已自动保持登录");
                  setShowChangePwd(false);
                } else {
                  toast.error(`修改失败：旧密码不正确，或新密码不符合策略（${PASSWORD_POLICY_LABEL}）`);
                }
              }}
            >
              {pwdBusy ? "提交中…" : "确认修改"}
            </Button>
          </>
        }
      >
        <div className="space-y-3.5">
          <div>
            <label className="block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint mb-1.5">
              当前密码
            </label>
            <input
              type="password"
              autoFocus
              value={pwdOld}
              onChange={(e) => setPwdOld(e.target.value)}
              className="field"
            />
          </div>
          <div>
            <label className="block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint mb-1.5">
              新密码（{PASSWORD_POLICY_LABEL}）
            </label>
            <input
              type="password"
              value={pwdNew}
              onChange={(e) => setPwdNew(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !pwdBusy && pwdOld && passwordPolicyOk(pwdNew) && pwdConfirm === pwdNew) {
                  (e.target as HTMLInputElement).closest("form")?.requestSubmit();
                }
              }}
              className="field"
            />
          </div>
          <div>
            <label className="block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint mb-1.5">
              确认新密码
            </label>
            <input
              type="password"
              value={pwdConfirm}
              onChange={(e) => setPwdConfirm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !pwdBusy && pwdOld && passwordPolicyOk(pwdNew) && pwdConfirm === pwdNew) {
                  (e.target as HTMLInputElement).closest("form")?.requestSubmit();
                }
              }}
              className="field"
            />
            {pwdConfirm.length > 0 && pwdConfirm !== pwdNew && (
              <p className="mt-1 text-[10.5px] text-red">两次输入的新密码不一致</p>
            )}
          </div>
          <p className="text-[10.5px] text-fg-faint">
            修改后其他设备的已登录会话将失效，本机保持登录。
          </p>
        </div>
      </Modal>
    </header>
  );
}


