import { Routes, Route, Navigate } from "react-router-dom";
import Layout from "./components/Layout.tsx";
import Workspace from "./pages/Workspace.tsx";
import WorkChat from "./pages/WorkChat.tsx";
import AdminWorkers from "./pages/AdminWorkers.tsx";
import Audit from "./pages/Audit.tsx";
import Policy from "./pages/Policy.tsx";
import Swarm from "./pages/Swarm.tsx";
import Governance from "./pages/Governance.tsx";
import Knowledge from "./pages/Knowledge.tsx";
import Schedules from "./pages/Schedules.tsx";
import Models from "./pages/Models.tsx";
import Settings from "./pages/Settings.tsx";
import Inbox from "./pages/Inbox.tsx";
import Login from "./pages/Login.tsx";
import NotFound from "./pages/NotFound.tsx";
import RequireAuth from "./components/RequireAuth.tsx";
import RequireAdmin from "./components/RequireAdmin.tsx";

export default function App() {
  return (
    <Layout>
      <Routes>
        {/* 登录（登录后回跳见 Login.tsx；from 参数保留来源路径） */}
        <Route path="/login" element={<Login />} />

        {/* User workspace（需登录） */}
        <Route index element={<Navigate to="/app" replace />} />
        <Route path="/app" element={<RequireAuth><Workspace /></RequireAuth>} />
        <Route path="/app/chat/:workerId" element={<RequireAuth><WorkChat /></RequireAuth>} />
        <Route path="/app/chat/:workerId/:sessionId" element={<RequireAuth><WorkChat /></RequireAuth>} />

        {/* Admin console（登录 + 后台权限守卫） */}
        <Route path="/admin/inbox" element={<RequireAuth><RequireAdmin><Inbox /></RequireAdmin></RequireAuth>} />
        <Route path="/admin/workers" element={<RequireAuth><RequireAdmin><AdminWorkers /></RequireAdmin></RequireAuth>} />
        <Route path="/admin/models" element={<RequireAuth><RequireAdmin><Models /></RequireAdmin></RequireAuth>} />
        <Route path="/admin/audit" element={<RequireAuth><RequireAdmin><Audit /></RequireAdmin></RequireAuth>} />
        <Route path="/admin/policy" element={<RequireAuth><RequireAdmin><Policy /></RequireAdmin></RequireAuth>} />
        <Route path="/admin/swarm" element={<RequireAuth><RequireAdmin><Swarm /></RequireAdmin></RequireAuth>} />
        <Route path="/admin/governance" element={<RequireAuth><RequireAdmin><Governance /></RequireAdmin></RequireAuth>} />
        <Route path="/admin/knowledge" element={<RequireAuth><RequireAdmin><Knowledge /></RequireAdmin></RequireAuth>} />
        <Route path="/admin/schedules" element={<RequireAuth><RequireAdmin><Schedules /></RequireAdmin></RequireAuth>} />
        <Route path="/admin/settings" element={<RequireAuth><RequireAdmin><Settings /></RequireAdmin></RequireAuth>} />

        {/* 兜底：未匹配路径 → 登录页或 404 */}
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Layout>
  );
}


