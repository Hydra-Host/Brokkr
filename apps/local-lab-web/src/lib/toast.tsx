import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

type ToastKind = 'ok' | 'error' | 'info';
type Toast = { id: number; kind: ToastKind; message: string };

export type ToastApi = {
  ok: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

const AUTO_DISMISS_MS = 7000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      const id = ++seq.current;
      setToasts((ts) => [...ts, { id, kind, message }]);
      setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
    },
    [dismiss],
  );

  const api = useRef<ToastApi>({
    ok: (m) => push('ok', m),
    error: (m) => push('error', m),
    info: (m) => push('info', m),
  }).current;

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="fixed right-4 bottom-4 z-50 flex w-[min(92vw,28rem)] flex-col gap-2">
        {toasts.map((t) => (
          <button
            key={t.id}
            onClick={() => dismiss(t.id)}
            title="dismiss"
            className={[
              'rounded-md border px-3 py-2 text-left text-sm shadow-lg backdrop-blur transition',
              t.kind === 'error'
                ? 'border-status-offline/40 bg-bg-secondary text-status-offline'
                : t.kind === 'ok'
                  ? 'border-status-online/40 bg-bg-secondary text-status-online'
                  : 'border-status-info/40 bg-bg-secondary text-status-info',
            ].join(' ')}
          >
            <span className="mr-2 font-mono text-[11px] tracking-wide uppercase opacity-60">
              {t.kind === 'error' ? 'failed' : t.kind === 'ok' ? 'ok' : 'info'}
            </span>
            {t.message}
          </button>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}
