import type { ReactNode } from "react";
import PageShell from "./PageShell.tsx";
import EmptyState from "./EmptyState.tsx";
import { IconShield } from "./icons.tsx";
import { useUserStore } from "../stores/userStore.ts";

/**
 * 管理路由守卫。
 *
 * 主进程侧的特权 channel 有 assertAllowed 兜底（真正的安全边界），
 * 但前端此前没有守卫：非管理员可以直接改 hash 访问 /admin/* 页面，
 * 看到不应看到的管理界面。这里按会话角色拦截并给出说明。
 */
export default function RequireAdmin({ children }: { children: ReactNode }) {
  const session = useUserStore((s) => s.session);
  const loaded = useUserStore((s) => s.loaded);

  // 身份尚未就绪：先不渲染（避免误判为非管理员造成闪烁）
  if (!loaded) return null;

  // admin 或获授后台权限（canManageConsole）者均可访问
  const allowed = !!session && (session.role === "admin" || session.canManageConsole);
  if (!allowed) {
    return (
      <PageShell title="无权访问">
        <EmptyState
          icon={<IconShield size={18} />}
          title="需要后台权限"
          description="当前身份没有访问管理控制台的权限。请联系管理员在设置中为你的账号开启后台权限。"
        />
      </PageShell>
    );
  }

  return <>{children}</>;
}
