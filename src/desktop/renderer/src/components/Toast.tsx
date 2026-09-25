import {
  createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode,
} from "react";
import { useLocation } from "react-router-dom";
import { IconAlert, IconCheck, IconInfo, IconX } from "./icons.tsx";

/**
 * 全局轻提示。
 *
 * 此前各页面各写一套"定时消失的条"（Policy / AdminWorkers / Models 三份实现），
 * 且多数失败路径被静默吞掉。统一到这里后：任何操作都能给出一致的成功/失败反馈。
 */

type ToastKind = "success" | "error" | "info";

interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
}

export interface ToastApi {
  show: (kind: ToastKind, text: string) => void;
  success: (text: string) => void;
  error: (text: string) => void;
  info: (text: string) => void;
}

const ToastCtx = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast 必须在 <ToastProvider> 内使用");
  return ctx;
}

const KIND_CLASS: Record<ToastKind, string> = {
  success: "border-green/30 text-green",
  error: "border-red/30 text-red",
  info: "border-line-strong text-fg-muted",
};

const KIND_ICON: Record<ToastKind, ReactNode> = {
  success: <IconCheck size={13} />,
  error: <IconAlert size={13} />,
  info: <IconInfo size={13} />,
};

/** 同时可见的上限，超出丢弃最旧的 */
const MAX_VISIBLE = 4;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (kind: ToastKind, text: string) => {
      const id = ++seq.current;
      setItems((prev) => [...prev.slice(-(MAX_VISIBLE - 1)), { id, kind, text }]);
      window.setTimeout(() => dismiss(id), kind === "error" ? 6000 : 3200);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (t) => show("success", t),
      error: (t) => show("error", t),
      info: (t) => show("info", t),
    }),
    [show],
  );

  // 停靠位置随页面而变：
  //   · 聊天页 —— 底部是输入框与发送/停止按钮（最高频交互），标题栏右侧又有
  //     "新对话/更多"按钮，故停在标题栏正下方（TopBar h-14 + 标题栏 h-14 = 112px），
  //     只与较早的历史消息短暂重叠，不挡任何可交互控件。
  //   · 其余页 —— 右上角是 PageShell 的操作按钮（新建/创建等），保持右下更合适。
  // 两种情况下卡片本体都 pointer-events-none：即使与内容视觉重叠，也绝不拦截点击。
  const { pathname } = useLocation();
  const atChat = pathname.startsWith("/chat");

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div
        className={`fixed z-[100] flex flex-col gap-2 w-[340px] max-w-[calc(100vw-2.5rem)] pointer-events-none ${
          atChat ? "right-5 top-[120px]" : "right-5 bottom-5"
        }`}
      >
        {items.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`pointer-events-none flex items-start gap-2.5 px-3.5 py-2.5 rounded-xl border bg-elevated/95 backdrop-blur-sm shadow-2xl animate-in ${KIND_CLASS[t.kind]}`}
          >
            <span className="shrink-0 mt-[1px]">{KIND_ICON[t.kind]}</span>
            <p className="flex-1 text-[12px] leading-relaxed break-words text-fg-muted">{t.text}</p>
            {/* 仅关闭按钮可点击：保留手动关闭，同时不阻断下层任何操作 */}
            <button
              onClick={() => dismiss(t.id)}
              className="pointer-events-auto shrink-0 p-0.5 rounded text-fg-faint hover:text-fg-muted transition-colors"
              aria-label="关闭提示"
            >
              <IconX size={11} />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
