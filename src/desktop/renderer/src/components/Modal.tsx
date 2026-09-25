import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Button from "./Button.tsx";
import { IconX } from "./icons.tsx";

/**
 * 通用模态框。此前 AdminWorkers / Settings / Models 各自手写遮罩 + 卡片 + 关闭逻辑，
 * 且删除确认退化为 window.confirm（Electron 中原生 confirm 体验割裂、无法定制）。
 *
 * 必须 Portal 到 body 的原因：`backdrop-filter`（如 TopBar 的 backdrop-blur-sm）
 * 会成为 `position: fixed` 后代的**包含块** —— 若 Modal 被渲染在带 blur 的祖先
 * 内部（改密码弹窗就在顶栏 header 里），fixed 定位会被困在祖先内，
 * 表现为"弹窗卡在页面顶部、内容被裁剪、无法居中"（本机实测踩到）。
 * 与 Dropdown 的 Portal 修复同理：浮层永远挂到 body 顶层，免疫祖先污染。
 */

interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children?: ReactNode;
  footer?: ReactNode;
  /** 卡片宽度类，默认 max-w-lg */
  widthClass?: string;
}

export function Modal({ open, title, onClose, children, footer, widthClass = "max-w-lg" }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-[2px] p-4 animate-in"
      onClick={onClose}
    >
      <div
        className={`w-full ${widthClass} max-h-[90vh] flex flex-col rounded-xl border border-line-strong bg-elevated shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="shrink-0 flex items-center justify-between px-5 h-12 border-b border-line">
          <h2 className="text-[13.5px] font-semibold text-fg truncate">{title}</h2>
          <button
            onClick={onClose}
            className="shrink-0 p-1 rounded-md text-fg-faint hover:text-fg-muted hover:bg-n-850/60 transition-colors"
            aria-label="关闭"
          >
            <IconX size={13} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-5">{children}</div>

        {footer && (
          <div className="shrink-0 flex justify-end gap-2 px-5 py-3.5 border-t border-line">{footer}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}

interface ConfirmModalProps {
  open: boolean;
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  /** 危险操作（删除等）：确认按钮用红色语义 */
  danger?: boolean;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/** 二次确认弹窗（替代 window.confirm）。 */
export function ConfirmModal({
  open,
  title,
  description,
  confirmText = "确认",
  cancelText = "取消",
  danger = false,
  busy = false,
  onCancel,
  onConfirm,
}: ConfirmModalProps) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      widthClass="max-w-sm"
      footer={
        <>
          <Button onClick={onCancel} disabled={busy}>{cancelText}</Button>
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} disabled={busy}>
            {busy ? "处理中…" : confirmText}
          </Button>
        </>
      }
    >
      {description && <p className="text-[12px] text-fg-subtle leading-relaxed">{description}</p>}
    </Modal>
  );
}
