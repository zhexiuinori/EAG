import { create } from "zustand";

/**
 * 主题状态。参考 QwenPaw 的主题链路：
 *   mode（dark/light/system）→ <html> 上的 class → CSS 变量 → 全站生效。
 * 颜色全部由 index.css 的 --eag-* 变量定义，切换主题无需触碰组件代码。
 */

export type ThemeMode = "dark" | "light" | "system";

const STORAGE_KEY = "eag-theme";

function systemPrefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
}

function resolveDark(mode: ThemeMode): boolean {
  return mode === "system" ? systemPrefersDark() : mode === "dark";
}

function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  root.classList.toggle("theme-light", !resolveDark(mode));
}

function readStoredMode(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "dark" || v === "light" || v === "system") return v;
  } catch {
    // 忽略
  }
  return "dark";
}

interface ThemeState {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
  mode: readStoredMode(),
  setMode: (mode) => {
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // 忽略
    }
    applyTheme(mode);
    set({ mode });
  },
}));

/** 应用启动时调用一次：应用当前主题并跟随系统变化（system 模式）。 */
export function initTheme(): void {
  applyTheme(useThemeStore.getState().mode);
  const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
  mq?.addEventListener("change", () => {
    if (useThemeStore.getState().mode === "system") applyTheme("system");
  });
}
