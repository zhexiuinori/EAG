import { create } from "zustand";
import * as ipc from "../lib/ipc.ts";
import type { AppConfig } from "@shared/types.ts";

/**
 * 全局配置缓存。
 *
 * 此前 TopBar / WorkChat / AdminWorkers / Models / Settings 各自 useEffect
 * configGet()，同一份配置被反复拉取且互不同步。统一到 store 后：
 *   · 首次读取后缓存，force 才重新拉取；
 *   · 任何写入都经过这里，各消费方自动拿到新值。
 */

interface ConfigState {
  config: AppConfig | null;
  loading: boolean;
  error: string | null;
  /** 读取配置（默认走缓存；force = true 强制刷新） */
  load: (force?: boolean) => Promise<AppConfig | null>;
  /** 直接替换本地缓存（用于批量编辑） */
  setConfig: (config: AppConfig) => void;
  /** 局部更新并持久化（成功后同步缓存） */
  patchAndSave: (patch: Partial<AppConfig>) => Promise<void>;
}

export const useConfigStore = create<ConfigState>((set, get) => ({
  config: null,
  loading: false,
  error: null,

  load: async (force = false) => {
    const cur = get().config;
    if (cur && !force) return cur;
    set({ loading: true, error: null });
    try {
      const config = await ipc.configGet();
      set({ config, loading: false });
      return config;
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  },

  setConfig: (config) => set({ config }),

  patchAndSave: async (patch) => {
    const cur = get().config;
    await ipc.configUpdate(patch);
    if (cur) set({ config: { ...cur, ...patch } });
  },
}));
