import { useEffect, useRef, useState, type ReactNode } from 'react';

import type { Run, StackOp } from '@/contract';
import { copyText } from '@/lib/clipboard';
import { usePaintedHtml, type LogRef } from '@/lib/use-log-stream';

import { HEALTH_UI, RUNNING_HEALTH, healthUi } from './status/health-ui';

export { HEALTH_UI, RUNNING_HEALTH, healthUi };

const STATUS_COLOR: Record<string, string> = {
  running: 'text-status-warning',
  passed: 'text-status-online',
  failed: 'text-status-offline',
  cancelled: 'text-text-dim',
};

export function OpList({
  ops,
  activeOp,
  disabled,
  gatedText,
  onOpClick,
  forceDisabled,
  disabledReason,
}: {
  ops: StackOp[];
  activeOp: string | null;
  disabled: boolean;
  gatedText: (op: StackOp) => string | null;
  onOpClick: (op: StackOp) => void;
  forceDisabled?: boolean;
  disabledReason?: string;
}) {
  const [tip, setTip] = useState<{ id: string; text: string; x: number; y: number } | null>(null);
  const [pinned, setPinned] = useState(false);

  const show = (e: React.MouseEvent, op: StackOp) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setTip({ id: op.id, text: op.description, x: r.right + 8, y: r.top });
  };
  const hide = () => {
    if (!pinned) setTip(null);
  };
  const toggle = (e: React.MouseEvent, op: StackOp) => {
    e.stopPropagation();
    if (tip?.id === op.id && pinned) {
      setPinned(false);
      setTip(null);
    } else {
      show(e, op);
      setPinned(true);
    }
  };

  return (
    <div className="space-y-2">
      {ops.map((op) => {
        const gated = gatedText(op);
        return (
          <div key={op.id} className="relative">
            <button
              onClick={() => onOpClick(op)}
              disabled={disabled || gated !== null || !!forceDisabled}
              title={(forceDisabled ? disabledReason : null) ?? gated ?? undefined}
              className={[
                'w-full rounded-md border py-2 pr-9 pl-3 text-left text-sm transition disabled:cursor-not-allowed disabled:opacity-40',
                op.destructive
                  ? 'border-status-offline/30 text-status-offline hover:bg-status-offline/10'
                  : 'border-border-dim text-text-primary hover:bg-hover-bg',
                activeOp === op.id ? 'ring-accent/50 ring-1' : '',
              ].join(' ')}
            >
              <div className="flex items-center gap-2 font-medium">
                {op.label}
                {op.needsSudo && <span className="text-status-warning/80 text-[10px]">root</span>}
              </div>
              <div className="text-text-dim font-mono text-[11px]">{gated ?? `task ${op.task}`}</div>
            </button>
            <button
              type="button"
              aria-label={`About: ${op.label}`}
              onMouseEnter={(e) => !pinned && show(e, op)}
              onMouseLeave={hide}
              onClick={(e) => toggle(e, op)}
              className="border-border-dim text-text-dim hover:border-border hover:text-text-primary absolute top-2 right-2 flex h-4 w-4 items-center justify-center rounded-full border text-[10px] leading-none font-semibold"
            >
              i
            </button>
          </div>
        );
      })}
      {tip && (
        <div
          className="border-border-dim bg-bg-secondary text-text-primary fixed z-50 max-w-[280px] rounded-md border p-2.5 text-[11px] leading-snug shadow-xl"
          style={{ left: tip.x, top: tip.y }}
        >
          {tip.text}
        </div>
      )}
    </div>
  );
}

export function RecentRuns({
  runs,
  onSelect,
  onCancel,
  activeId,
}: {
  runs: Run[];
  onSelect?: (runId: string) => void;
  onCancel?: (runId: string) => void;
  activeId?: string | null;
}) {
  return (
    <div className="space-y-1 text-xs">
      {runs.length === 0 && <div className="text-text-dim">no runs yet</div>}
      {runs.map((r) => {
        const body = (
          <>
            <span className="text-text-muted truncate" title={r.opId}>
              {r.label}
            </span>
            <span className="flex items-center gap-2">
              <span className={STATUS_COLOR[r.status]}>
                {r.status}
                {r.exitCode !== null && r.status === 'failed' ? ` (${r.exitCode})` : ''}
              </span>
              {onCancel && r.status === 'running' && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onCancel(r.runId);
                  }}
                  className="bg-status-offline/15 text-status-offline hover:bg-status-offline/25 rounded px-1.5 py-0.5 text-[10px] tracking-wide uppercase"
                  title="SIGTERM the vitest child"
                >
                  cancel
                </button>
              )}
            </span>
          </>
        );
        return onSelect ? (
          <div
            key={r.runId}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(r.runId)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(r.runId);
              }
            }}
            className={[
              'flex w-full cursor-pointer items-center justify-between rounded px-1.5 py-1 font-mono transition',
              activeId === r.runId ? 'bg-accent/10 text-accent' : 'hover:bg-hover-bg',
            ].join(' ')}
          >
            {body}
          </div>
        ) : (
          <div key={r.runId} className="flex items-center justify-between font-mono">
            {body}
          </div>
        );
      })}
    </div>
  );
}

const ctrlBtnCls = (active: boolean) =>
  [
    'rounded border px-2 py-0.5 text-[10px] font-mono transition',
    active
      ? 'border-accent/40 bg-accent/15 text-accent'
      : 'border-border-dim bg-bg-secondary text-text-muted hover:bg-hover-bg hover:text-text-primary',
  ].join(' ');

export const wrapClass = (wrap: boolean) => (wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre');

export function ConsoleControls({
  getText,
  wrap,
  tail,
  clear,
}: {
  getText: () => string;
  wrap?: { on: boolean; toggle: () => void };
  tail?: { on: boolean; toggle: () => void };
  clear?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="absolute top-2 right-2 z-10 flex gap-1">
      {clear && (
        <button type="button" title="Clear log output" onClick={clear} className={ctrlBtnCls(false)}>
          clear
        </button>
      )}
      {tail && (
        <button
          type="button"
          title={tail.on ? 'Auto-following tail — click to stop' : 'Click to jump to bottom and follow tail'}
          onClick={tail.toggle}
          className={ctrlBtnCls(tail.on)}
        >
          tail
        </button>
      )}
      {wrap && (
        <button type="button" title="Toggle line wrap" onClick={wrap.toggle} className={ctrlBtnCls(wrap.on)}>
          wrap
        </button>
      )}
      <button
        type="button"
        title="Copy entire output"
        onClick={() => {
          void copyText(getText()).then((ok) => {
            if (ok) {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }
          });
        }}
        className={ctrlBtnCls(false)}
      >
        {copied ? 'copied ✓' : 'copy'}
      </button>
    </div>
  );
}

export function AnsiLogPane({
  logHtml,
  logRef,
  placeholder,
  tail,
  clear,
  degraded,
  disconnected,
}: {
  logHtml: string;
  logRef: LogRef;
  placeholder: string;
  tail?: { on: boolean; toggle: () => void };
  clear?: () => void;
  // degraded: the stream dropped and is reconnecting. disconnected: it gave up (no reconnect pending).
  degraded?: boolean;
  disconnected?: boolean;
}) {
  const [wrap, setWrap] = useState(true);
  const cls = `flex-1 min-h-0 min-w-0 overflow-auto bg-bg-secondary border border-border-dim rounded-lg p-4 text-xs font-mono text-text-primary ${wrapClass(wrap)}`;
  const paintRef = usePaintedHtml(logRef, logHtml || placeholder);
  return (
    <div className="relative flex min-h-[55vh] min-w-0 flex-1 flex-col lg:min-h-0">
      {(degraded || disconnected) && (
        <div
          className={`bg-bg-secondary absolute top-2 left-2 z-10 rounded border px-2 py-0.5 font-mono text-[10px] ${
            disconnected
              ? 'border-status-offline/40 text-status-offline'
              : 'border-status-warning/40 text-status-warning'
          }`}
        >
          {disconnected ? 'disconnected — reopen to retry' : 'reconnecting…'}
        </div>
      )}
      {/* Render controls whenever a stream is attached (clear/tail callback supplied) or there's
          content — without this, clicking `clear` hid every button because logHtml went empty. */}
      {(logHtml || clear || tail) && (
        <ConsoleControls
          getText={() => (logHtml ? (logRef.current?.textContent ?? '') : '')}
          wrap={{ on: wrap, toggle: () => setWrap((w) => !w) }}
          tail={tail}
          clear={clear}
        />
      )}
      <pre ref={paintRef} className={cls} />
    </div>
  );
}

/** Rendering contract for {@link GateModal}, decoupled from StackOp so non-op flows (e.g. the
 *  fleet-apply data-loss confirm) can drive the same modal. Adapters build this from their own model. */
export interface GateView {
  label: string;
  destructive: boolean;
  // Extra line under the title on destructive gates (e.g. an op's `task X`, or a data-loss warning).
  description?: ReactNode;
  needsPassword: boolean;
  password: string;
  setPassword: (v: string) => void;
  error: string;
  busy: boolean;
  confirm: () => void;
  cancel: () => void;
  // Overrides the confirm button copy; defaults to Run / Run anyway (or validating… while busy).
  confirmLabel?: string;
}

// only the topmost mounted gate owns the document-level keys — stacked gates would otherwise
// all cancel on one Escape (and non-destructive ones all confirm on one Enter).
const gateKeyOwners: symbol[] = [];

/** Confirm/password gate. `fixed` pins the scrim to the viewport (root-level modals); the default
 *  `absolute` scopes it to the nearest positioned ancestor (the stack/fleet op panels). */
export function GateModal({ gate, fixed }: { gate: GateView; fixed?: boolean }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const keyOwner = useRef(Symbol('gate'));

  useEffect(() => {
    const token = keyOwner.current;
    gateKeyOwners.push(token);
    return () => {
      const i = gateKeyOwners.indexOf(token);
      if (i !== -1) gateKeyOwners.splice(i, 1);
    };
  }, []);

  // escape always cancels; enter confirms only a non-destructive passwordless gate — destructive
  // gates require a deliberate click.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (gateKeyOwners[gateKeyOwners.length - 1] !== keyOwner.current) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        gate.cancel();
      } else if (e.key === 'Enter' && !gate.destructive && !gate.needsPassword && !gate.busy) {
        e.preventDefault();
        gate.confirm();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [gate]);

  // a destructive passwordless gate autofocuses cancel so a stray enter/space can't confirm data loss.
  useEffect(() => {
    if (gate.destructive && !gate.needsPassword) cancelRef.current?.focus();
  }, [gate.destructive, gate.needsPassword]);

  return (
    <div className={`${fixed ? 'fixed' : 'absolute'} inset-0 z-50 flex items-center justify-center bg-black/60`}>
      <div className="border-border-dim bg-bg-secondary w-[420px] space-y-3 rounded-lg border p-5">
        <div className="text-text-primary text-sm font-semibold">
          {gate.destructive ? `Confirm: ${gate.label}` : gate.label}
        </div>
        {gate.destructive && gate.description && <p className="text-status-offline/90 text-xs">{gate.description}</p>}
        {gate.needsPassword && (
          <div className="space-y-1">
            <label className="text-text-muted text-xs">
              sudo password (root needed; cached for this session, never stored)
            </label>
            <input
              type="password"
              autoFocus
              value={gate.password}
              onChange={(e) => gate.setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && gate.confirm()}
              className="border-border-dim bg-bg-primary text-text-primary focus:border-accent/50 w-full rounded-md border px-2 py-1.5 text-sm outline-none"
            />
            <p className="text-text-dim text-[11px]">
              caching here is best-effort across the detached fleet run. For durable, prompt-free sim sudo run{' '}
              <span className="text-text-muted font-mono">devenv tasks run sudo:setup</span> once in a terminal.
            </p>
          </div>
        )}
        {gate.error && <div className="text-status-offline text-xs">{gate.error}</div>}
        <div className="flex justify-end gap-2 pt-1">
          <button
            ref={cancelRef}
            onClick={gate.cancel}
            className="text-text-muted hover:bg-hover-bg rounded-md px-3 py-1.5 text-sm"
          >
            Cancel
          </button>
          <button
            onClick={gate.confirm}
            disabled={gate.busy}
            className={[
              'rounded-md px-3 py-1.5 text-sm disabled:opacity-50',
              gate.destructive
                ? 'bg-status-offline/20 text-status-offline hover:bg-status-offline/30'
                : 'bg-accent/20 text-accent hover:bg-accent/30',
            ].join(' ')}
          >
            {gate.busy ? 'validating…' : (gate.confirmLabel ?? (gate.destructive ? 'Run anyway' : 'Run'))}
          </button>
        </div>
      </div>
    </div>
  );
}

export function SectionHeading({ children }: { children: ReactNode }) {
  return <h2 className="text-text-primary text-sm font-semibold tracking-wide uppercase">{children}</h2>;
}

export function SvcBtn({
  label,
  onClick,
  disabled,
  danger,
  title,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={[
        'rounded border px-2 py-1 transition disabled:cursor-not-allowed disabled:opacity-50',
        danger
          ? 'border-status-offline/30 text-status-offline hover:bg-status-offline/10'
          : 'border-border-dim text-text-primary hover:bg-hover-bg',
      ].join(' ')}
    >
      {label}
    </button>
  );
}

export type ProcStatus = {
  id: string;
  label: string;
  status: string;
  restarts?: number;
  exitCode?: number;
  detail?: string;
};

export function DatastoreCard({
  ds,
  active,
  busy,
  onView,
  onViewEnv,
  onControl,
  allowEnable,
}: {
  ds: ProcStatus;
  active: boolean;
  busy: boolean;
  onView: () => void;
  onViewEnv?: () => void;
  onControl: (action: 'start' | 'stop' | 'restart') => void;
  allowEnable?: boolean;
}) {
  const running = RUNNING_HEALTH.includes(ds.status);
  const exists = ds.status !== 'missing';
  const ui = healthUi(ds.status);
  const note = ds.restarts ? `${ui.note} · ↻${ds.restarts}` : ui.note;
  return (
    <div
      className={[
        'rounded-md border px-3 py-2 text-sm',
        active ? 'border-accent/50 bg-accent/5' : 'border-border-dim',
      ].join(' ')}
    >
      <div className="flex items-center justify-between">
        <button
          onClick={onView}
          disabled={!exists}
          className="hover:text-text-primary flex items-center gap-2 text-left disabled:opacity-50"
        >
          <span className={`h-2 w-2 rounded-full ${ui.dot}`} />
          <span className="text-text-primary font-medium">{ds.label}</span>
        </button>
        <span className={`text-[11px] ${ui.text}`}>{note}</span>
      </div>
      {ds.detail && ds.status !== 'up' && (
        <div className="text-text-dim mt-1 truncate text-[11px]" title={ds.detail}>
          {ds.detail}
        </div>
      )}
      <div className="mt-2 flex gap-1.5 text-[11px]">
        <SvcBtn
          label="start"
          disabled={busy || running || !exists || (ds.status === 'disabled' && !allowEnable)}
          onClick={() => onControl('start')}
        />
        <SvcBtn
          label="restart"
          disabled={busy || !exists || (ds.status === 'disabled' && !allowEnable)}
          onClick={() => onControl('restart')}
        />
        <SvcBtn label="stop" danger disabled={busy || !running} onClick={() => onControl('stop')} />
        {onViewEnv && (
          <button
            onClick={onViewEnv}
            disabled={!exists}
            className="text-text-muted hover:bg-hover-bg ml-auto rounded px-2 py-1 disabled:opacity-40"
          >
            env
          </button>
        )}
        <button
          onClick={onView}
          disabled={!exists}
          className={[
            'text-text-muted hover:bg-hover-bg rounded px-2 py-1 disabled:opacity-40',
            onViewEnv ? '' : 'ml-auto',
          ].join(' ')}
        >
          logs
        </button>
      </div>
    </div>
  );
}
