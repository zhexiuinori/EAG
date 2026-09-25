import { create } from "zustand";
import * as ipc from "../lib/ipc.ts";
import type { BackgroundTask } from "@shared/types.ts";

/**
 * 后台任务状态。
 *
 * 主进程在任务状态变化时通过 task:event 推送快照；运行中的输出预览由面板
 * 展开时轮询 task:list 获取（避免逐 token 事件风暴）。
 */

interface TaskState {
  tasks: BackgroundTask[];
  loaded: boolean;
  load: (workerId?: string) => Promise<void>;
  submit: (workerId: string, text: string) => Promise<BackgroundTask>;
  cancel: (id: string) => Promise<void>;
}

export const useTaskStore = create<TaskState>((set) => ({
  tasks: [],
  loaded: false,

  load: async (workerId?: string) => {
    try {
      const r = await ipc.taskList(workerId ? { workerId } : undefined);
      set({ tasks: r.tasks ?? [], loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  submit: async (workerId, text) => {
    const task = await ipc.taskSubmit({ workerId, text });
    set((s) => ({ tasks: [task, ...s.tasks] }));
    return task;
  },

  cancel: async (id) => {
    await ipc.taskCancel({ id });
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === id
          ? { ...t, status: "cancelled" as const, endedAt: new Date().toISOString() }
          : t,
      ),
    }));
  },
}));

/** 应用启动时接入任务事件流（状态变化实时更新列表）。 */
export function initTaskEvents(): void {
  ipc.onTaskEvent((task) => {
    useTaskStore.setState((s) => {
      const idx = s.tasks.findIndex((t) => t.id === task.id);
      if (idx === -1) return { tasks: [task, ...s.tasks] };
      const next = [...s.tasks];
      next[idx] = task;
      return { tasks: next };
    });
  });
}
