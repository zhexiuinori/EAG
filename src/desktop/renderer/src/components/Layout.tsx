import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import TopBar from "./TopBar.tsx";
import Sidebar from "./Sidebar.tsx";

interface Props { children: ReactNode }

const ADMIN_PATHS = ["/admin"];

function isAdmin(path: string) {
  return ADMIN_PATHS.some((p) => path.startsWith(p));
}

/**
 * 应用外壳。
 *
 * 结构参考主流 Agent 平台：左侧栏（品牌 + 导航）+ 右侧主区（顶栏 + 内容）。
 * 主区不滚动，由各页面的 PageShell 自行管理内容区滚动——
 * 这样"页头固定 + 内容区独立卡片滚动"才能成立。
 */
export default function Layout({ children }: Props) {
  const loc = useLocation();
  const admin = isAdmin(loc.pathname);
  // 登录页是独立的全屏页面：不显示侧边栏 / 顶栏
  const bare = loc.pathname === "/login";

  if (bare) {
    return <div className="h-screen overflow-hidden bg-base text-fg">{children}</div>;
  }

  return (
    <div className="flex h-screen overflow-hidden bg-base text-fg">
      <Sidebar isAdmin={admin} />

      <div className="flex-1 flex flex-col min-w-0">
        <TopBar isAdmin={admin} />
        <main className="flex-1 min-h-0 overflow-hidden">{children}</main>
      </div>
    </div>
  );
}
