import { useNavigate } from "react-router-dom";
import PageShell from "../components/PageShell.tsx";
import Button from "../components/Button.tsx";
import EmptyState from "../components/EmptyState.tsx";
import { IconAlert } from "../components/icons.tsx";

/** 未匹配路由的兜底页面（此前任意路径落入空白）。 */
export default function NotFound() {
  const nav = useNavigate();
  return (
    <PageShell title="页面不存在">
      <EmptyState
        icon={<IconAlert size={18} />}
        title="找不到这个页面"
        description="地址可能已失效，或该功能尚未开放。请从左侧导航返回。"
        action={
          <Button variant="primary" onClick={() => nav("/app")}>
            返回工作区
          </Button>
        }
      />
    </PageShell>
  );
}

