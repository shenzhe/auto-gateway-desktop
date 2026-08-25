// 确认对话框：通过 portal 渲染的模态确认框，替代被 WebView 屏蔽的 window.confirm。
import { createPortal } from "react-dom";

export type ConfirmDialogProps = {
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  onResolve: (accepted: boolean) => void;
};

export function ConfirmDialog({
  message,
  confirmLabel,
  cancelLabel,
  onResolve,
}: ConfirmDialogProps) {
  return createPortal(
    <div
      className="confirmOverlay"
      role="dialog"
      aria-modal="true"
      aria-live="assertive"
    >
      <div className="confirmDialog">
        <p className="confirmMessage">{message}</p>
        <div className="confirmActions">
          <button
            type="button"
            className="secondaryButton"
            onClick={() => onResolve(false)}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className="primaryButton"
            // Autofocus the destructive action's confirm button so keyboard
            // users can review the message first via shift-tab.
            autoFocus
            onClick={() => onResolve(true)}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
