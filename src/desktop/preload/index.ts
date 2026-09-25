import { contextBridge, ipcRenderer } from "electron";
import {
  RENDERER_IPC_CHANNELS,
  AGENT_EVENT_CHANNEL,
  WORKSPACE_CHAT_EVENT,
  TERMINAL_EVENT,
  SWARM_EVENT,
  TASK_EVENT,
  APPROVAL_EVENT,
} from "../shared/ipc-channels.ts";

const api: Record<string, unknown> = {};

// 只暴露白名单内的 channel：高危的 pi:exec 不出现在 window.eag 上。
// 注意：这只是缩小攻击面，权限判定仍在主进程 ipc-handlers.ts 完成。
for (const channel of RENDERER_IPC_CHANNELS) {
  api[channel] = (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);
}

// Streamed agent events (deprecated)
api.onAgentEvent = (cb: (data: unknown) => void) => {
  const listener = (_event: unknown, data: unknown) => cb(data);
  ipcRenderer.on(AGENT_EVENT_CHANNEL, listener);
  return () => ipcRenderer.removeListener(AGENT_EVENT_CHANNEL, listener);
};

// Workspace chat stream
api.onWorkspaceChatEvent = (cb: (data: unknown) => void) => {
  const listener = (_event: unknown, data: unknown) => cb(data);
  ipcRenderer.on(WORKSPACE_CHAT_EVENT, listener);
  return () => ipcRenderer.removeListener(WORKSPACE_CHAT_EVENT, listener);
};

// Terminal output stream
api.onTerminalEvent = (cb: (data: unknown) => void) => {
  const listener = (_event: unknown, data: unknown) => cb(data);
  ipcRenderer.on(TERMINAL_EVENT, listener);
  return () => ipcRenderer.removeListener(TERMINAL_EVENT, listener);
};

// Swarm execution progress stream
api.onSwarmEvent = (cb: (data: unknown) => void) => {
  const listener = (_event: unknown, data: unknown) => cb(data);
  ipcRenderer.on(SWARM_EVENT, listener);
  return () => ipcRenderer.removeListener(SWARM_EVENT, listener);
};

// Background task status stream
api.onTaskEvent = (cb: (data: unknown) => void) => {
  const listener = (_event: unknown, data: unknown) => cb(data);
  ipcRenderer.on(TASK_EVENT, listener);
  return () => ipcRenderer.removeListener(TASK_EVENT, listener);
};

// Approval stream
api.onApprovalEvent = (cb: (data: unknown) => void) => {
  const listener = (_event: unknown, data: unknown) => cb(data);
  ipcRenderer.on(APPROVAL_EVENT, listener);
  return () => ipcRenderer.removeListener(APPROVAL_EVENT, listener);
};

contextBridge.exposeInMainWorld("eag", api);
