import type { ReactNode } from 'react';

// shared overlay shell for the test-runner picker modals: a full-bleed scrim, a centered card with a
// titled header + ✕ close, the caller's body, and a footer with a note plus Cancel/confirm buttons.
export function PickerModal({
  title,
  onClose,
  width,
  footerNote,
  confirmLabel,
  onConfirm,
  confirmDisabled,
  onConfirmMouseDown,
  children,
}: {
  title: string;
  onClose: () => void;
  // full Tailwind width class (e.g. 'w-[560px]') — kept literal at the call site so the JIT emits it.
  width: string;
  footerNote?: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  confirmDisabled?: boolean;
  onConfirmMouseDown?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/70 p-4">
      <div
        className={`border-border-dim bg-bg-secondary max-h-full ${width} space-y-4 overflow-auto rounded-lg border p-5`}
      >
        <div className="flex items-center justify-between">
          <div className="text-text-primary text-sm font-semibold">{title}</div>
          <button onClick={onClose} className="text-text-dim hover:text-text-primary text-sm">
            ✕
          </button>
        </div>

        {children}

        <div className="flex items-center justify-between">
          {footerNote}
          <div className="flex gap-2">
            <button onClick={onClose} className="text-text-muted hover:bg-hover-bg rounded-md px-3 py-1.5 text-sm">
              Cancel
            </button>
            <button
              onClick={onConfirm}
              onMouseDown={onConfirmMouseDown}
              disabled={confirmDisabled}
              className="bg-status-offline/20 text-status-offline hover:bg-status-offline/30 rounded-md px-3 py-1.5 text-sm disabled:opacity-40"
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
