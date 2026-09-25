import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App.tsx";
import ErrorBoundary from "./components/ErrorBoundary.tsx";
import { ToastProvider } from "./components/Toast.tsx";
import { initTheme } from "./stores/themeStore.ts";
import { initTaskEvents } from "./stores/taskStore.ts";
import { initApprovalEvents } from "./stores/approvalStore.ts";
import { useUserStore } from "./stores/userStore.ts";
import "./index.css";

// 应用持久化的主题（dark / light / system），须在首帧渲染前执行
initTheme();

// 接入后台任务与审批事件流（状态变化实时反映到 UI）
initTaskEvents();
initApprovalEvents();

// 启动即恢复登录态：localStorage 有 token 则 authSession 返回有效身份，
// 否则按未登录处理（RequireAuth 会导向登录页）
void useUserStore.getState().load();


// HashRouter 而非 BrowserRouter：
// Electron 打包后通过 loadFile() 以 file:// 协议加载，此时 location.pathname
// 是文件的绝对路径（如 /D:/.../index.html），BrowserRouter 的路由全部失配，
// 主内容区会渲染成空白。hash 路由在 file:// 与静态托管下均可正常工作。
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <HashRouter>
        {/* ToastProvider 置于 Router 内：Toast 需按当前路由决定停靠位置
            （聊天页底部是输入区，不能被浮层盖住） */}
        <ToastProvider>
          <App />
        </ToastProvider>
      </HashRouter>
    </ErrorBoundary>
  </React.StrictMode>,
);
