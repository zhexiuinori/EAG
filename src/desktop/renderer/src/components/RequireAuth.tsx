import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useUserStore } from "../stores/userStore.ts";

/**
 * 登录守卫：未登录（无有效会话）跳转登录页，并记住来源路径。
 * 身份加载中时先不渲染，避免未登录状态误判成"未登录"造成闪烁。
 */
export default function RequireAuth({ children }: { children: ReactNode }) {
  const session = useUserStore((s) => s.session);
  const loaded = useUserStore((s) => s.loaded);
  const loc = useLocation();

  if (!loaded) return null;

  if (!session) {
    const from = encodeURIComponent(loc.pathname + loc.search);
    return <Navigate to={`/login?from=${from}`} replace />;
  }

  return <>{children}</>;
}
