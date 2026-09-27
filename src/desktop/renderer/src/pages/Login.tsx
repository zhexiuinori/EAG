import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useUserStore } from "../stores/userStore.ts";
import { useToast } from "../components/Toast.tsx";
import { IconShield } from "../components/icons.tsx";

/**
 * 登录页。
 *
 * Web 模式登录凭证（token）保存在 localStorage，随每个请求携带；
 * 未登录访问任何页面都会在 RequireAuth 处被重定向到这里（带 ?from= 原路径）。
 * 全新安装时 users.json 会初始化默认管理员账号 admin（初始密码 admin123）。
 */
export default function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const login = useUserStore((s) => s.login);
  const toast = useToast();
  const nav = useNavigate();
  const [params] = useSearchParams();

  // 未登录被拦截时会带上 ?from=<原路径>，登录后回到原处（而非丢到默认页）。
  // 安全：只接受站内绝对路径，拒绝 //evil.com 这类开放重定向。
  const from = params.get("from");
  const safeFrom =
    from && from.startsWith("/") && !from.startsWith("//") ? from : null;
  // token 过期被 401 拦截跳回时带 expired=1：给出明确提示，而非让用户对着登录页发懵
  const expired = params.get("expired") === "1";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password || busy) return;
    setBusy(true);
    try {
      const outcome = await login(username.trim(), password);
      if (!outcome.ok) {
        if (outcome.reason === "locked") {
          const min = Math.max(1, Math.ceil((outcome.retryAfterSec ?? 900) / 60));
          toast.error(`失败次数过多，账号已临时锁定，请约 ${min} 分钟后重试`);
        } else {
          toast.error("用户名或密码错误");
        }
        return;
      }
      const session = outcome.session;
      toast.success(`欢迎，${session.userName}`);
      if (outcome.passwordWeak) {
        toast.error("您仍在使用初始密码 admin123，请尽快在「设置 → 账户」中修改");
      }
      // 优先级：原本要去的页面 > 管理员默认管理页 > 普通用户工作区
      if (safeFrom) {
        nav(safeFrom, { replace: true });
      } else if (session.role === "admin" || session.canManageConsole) {
        nav("/admin/workers", { replace: true });
      } else {
        nav("/app", { replace: true });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex bg-base">
      {/* 品牌区（Dolphin 形态：左侧渐变品牌带，小屏隐藏） */}
      <div className="hidden lg:flex flex-col justify-between w-[44%] p-12 relative overflow-hidden bg-gradient-to-br from-primary-strong via-primary to-primary-strong">
        {/* 装饰光斑 */}
        <div className="absolute -top-24 -left-24 size-96 rounded-full bg-white/10 blur-3xl pointer-events-none" />
        <div className="absolute -bottom-32 -right-16 size-[28rem] rounded-full bg-black/15 blur-3xl pointer-events-none" />

        <div className="relative flex items-center gap-2.5">
          <div className="size-9 rounded-xl bg-white/15 backdrop-blur flex items-center justify-center">
            <IconShield size={18} className="text-white" />
          </div>
          <span className="text-[15px] font-semibold text-white tracking-tight">EAG</span>
        </div>

        <div className="relative">
          <h1 className="text-[30px] font-semibold text-white leading-snug tracking-tight">
            Enterprise Agent<br />Governance
          </h1>
          <p className="mt-3 text-[13.5px] text-white/75 leading-relaxed max-w-sm">
            让嵌入业务的编码 Agent 可控、可审、可治理 —— 会话优先的工作台，治理一个不少。
          </p>
          <ul className="mt-8 space-y-3">
            {[
              "Claude Code / Pi / Codex 多引擎统一接入",
              "策略、审计、预算贯穿每一次执行",
              "定时任务与知识库开箱即用",
            ].map((t) => (
              <li key={t} className="flex items-center gap-2.5 text-[12.5px] text-white/85">
                <span className="size-1.5 rounded-full bg-white/70 shrink-0" />
                {t}
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-[11px] text-white/50">
          MIT Licensed · 本地部署 · 数据不出域
        </p>
      </div>

      {/* 表单区 */}
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="mb-8 text-center lg:text-left">
            <div className="mx-auto lg:mx-0 size-12 rounded-2xl bg-primary-strong flex items-center justify-center shadow-lg shadow-primary/20 mb-4 lg:hidden">
              <IconShield size={22} className="text-white" />
            </div>
            <h2 className="text-[18px] font-semibold text-fg tracking-tight">欢迎回来</h2>
            <p className="text-[12px] text-fg-subtle mt-1">登录以继续使用</p>
          </div>

          {expired && (
            <div className="mb-4 rounded-lg border border-primary-border bg-primary-bg px-3.5 py-2.5 text-[12px] text-fg">
              登录已过期（会话有效期 12 小时），请重新登录。登录后会回到你刚才的页面。
            </div>
          )}

          <form
            onSubmit={submit}
            className="card p-6 space-y-4 animate-in"
          >
            <div>
              <label htmlFor="username" className="block text-[11px] font-semibold text-fg-subtle mb-1.5">
                用户名
              </label>
              <input
                id="username"
                autoFocus
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="admin"
                className="field !h-10"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-[11px] font-semibold text-fg-subtle mb-1.5">
                密码
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="field !h-10"
              />
            </div>

            <button
              type="submit"
              disabled={busy || !username.trim() || !password}
              className="w-full h-10 mt-2 bg-primary-strong hover:bg-primary disabled:opacity-40 disabled:cursor-not-allowed text-white text-[13px] font-medium rounded-xl transition-colors"
            >
              {busy ? "登录中…" : "登录"}
            </button>
          </form>

          <p className="mt-4 text-center text-[10.5px] text-fg-faint">
            忘记密码请联系管理员在「设置 → 用户」中重置
          </p>
        </div>
      </div>
    </div>
  );
}

