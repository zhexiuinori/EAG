import { create } from "zustand";
import * as ipc from "../lib/ipc.ts";
import type { Worker } from "@shared/types.ts";

/**
 * Worker 列表缓存。
 *
 * 分两条通道：
 *   · mine —— 当前用户的工作区可见 Agent（workspaceList）
 *   · all  —— 管理端全量（workerList）
 * 路由到不同页面时不再各自请求；新建/删除/启停后调用对应 load(force) 刷新。
 */

interface WorkerState {
  mine: Worker[];
  all: Worker[];
  loadedMine: boolean;
  loadedAll: boolean;
  loadingMine: boolean;
  loadingAll: boolean;

  loadMine: (force?: boolean) => Promise<Worker[]>;
  loadAll: (force?: boolean) => Promise<Worker[]>;
  /** 身份切换后清空用户侧缓存 */
  reset: () => void;
}

export const useWorkerStore = create<WorkerState>((set, get) => ({
  mine: [],
  all: [],
  loadedMine: false,
  loadedAll: false,
  loadingMine: false,
  loadingAll: false,

  loadMine: async (force = false) => {
    if (get().loadedMine && !force) return get().mine;
    set({ loadingMine: true });
    try {
      const r = await ipc.workspaceList();
      const workers = r.workers ?? [];
      set({ mine: workers, loadedMine: true, loadingMine: false });
      return workers;
    } catch {
      set({ loadingMine: false });
      return get().mine;
    }
  },

  loadAll: async (force = false) => {
    if (get().loadedAll && !force) return get().all;
    set({ loadingAll: true });
    try {
      const r = await ipc.workerList();
      const workers = r.workers ?? [];
      set({ all: workers, loadedAll: true, loadingAll: false });
      return workers;
    } catch {
      set({ loadingAll: false });
      return get().all;
    }
  },

  reset: () => set({ mine: [], loadedMine: false }),
}));
