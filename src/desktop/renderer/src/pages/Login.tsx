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
    <div className="min-h-screen flex items-center justify-center bg-base p-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto size-12 rounded-2xl bg-primary-strong flex items-center justify-center shadow-lg shadow-primary/20 mb-4">
            <IconShield size={22} className="text-white" />
          </div>
          <h1 className="text-[18px] font-semibold text-fg tracking-tight">Enterprise Agent Governance</h1>
          <p className="text-[12px] text-fg-subtle mt-1">登录以继续使用</p>
        </div>

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
  );
}

