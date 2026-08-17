import type { FleetPending } from '@repo/local-lab-contract';

import { pendingChangeCount } from '@/lib/pending';

/** Apply is gated while the form has unsaved edits (mirrors Rebuild's dirty-gate) or an apply is
 *  already running. Exported so the rule is unit-tested without a DOM. */
export const applyDisabled = (busy: boolean, blocked: boolean): boolean => busy || blocked;

export function PendingBanner({
  pending,
  onApply,
  busy,
  blocked = false,
  blockedReason,
}: {
  pending: FleetPending;
  onApply: () => void;
  busy: boolean;
  // Apply is gated (e.g. unsaved edits) — distinct from `busy` (which owns the "Applying…"
  // label); folding this into busy would mislabel a dirty-but-idle banner as Applying.
  blocked?: boolean;
  blockedReason?: string;
}) {
  if (pending.inSync) return null;
  const s = pending.summary;
  const netChanged = pending.network.changed;
  const count = pendingChangeCount(pending);
  if (pending.severity === 'mode-change') {
    return (
      <div className="border-status-warning/70 bg-status-warning/20 flex items-center gap-3 rounded-md border px-3 py-2">
        <span className="text-status-warning text-sm font-medium">⚠ Fleet mode changed — not yet applied</span>
        <button
          onClick={onApply}
          disabled={applyDisabled(busy, blocked)}
          title={blocked ? blockedReason : undefined}
          className="bg-status-warning/35 text-status-warning hover:bg-status-warning/45 border-status-warning/70 ml-auto rounded-md border px-3 py-1 text-sm font-medium disabled:opacity-40"
        >
          {busy ? 'Applying…' : 'Apply mode'}
        </button>
      </div>
    );
  }
  if (count === 0 && pending.note) {
    return (
      <div className="border-status-warning/70 bg-status-warning/20 text-status-warning flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
        ⚠ {pending.note}
      </div>
    );
  }
  const danger = pending.severity === 'needs-full-rebuild';
  const parts = [
    s.added && `${s.added} added`,
    s.removed && `${s.removed} removed`,
    s.changed && `${s.changed} changed`,
    netChanged && 'network',
  ].filter(Boolean);
  return (
    <div className="border-status-warning/70 bg-status-warning/20 flex flex-col gap-1 rounded-md border px-3 py-2">
      <div className="flex items-center gap-3">
        <span className="text-status-warning text-sm font-medium">
          ⚠ {count} pending {count === 1 ? 'change' : 'changes'}
          {parts.length ? ` (${parts.join(', ')})` : ''} — not yet applied
        </span>
        <button
          onClick={onApply}
          disabled={applyDisabled(busy, blocked)}
          title={blocked ? blockedReason : undefined}
          className="bg-status-warning/35 text-status-warning hover:bg-status-warning/45 border-status-warning/70 ml-auto rounded-md border px-3 py-1 text-sm font-medium disabled:opacity-40"
        >
          {busy ? 'Applying…' : danger ? 'Apply (full rebuild)' : 'Apply'}
        </button>
      </div>
      {(pending.nodes.changed.length > 0 ||
        pending.nodes.added.length > 0 ||
        pending.nodes.removed.length > 0 ||
        netChanged) && (
        <details className="text-status-warning text-[11px]">
          <summary className="cursor-pointer">what changed?</summary>
          <ul className="mt-1 space-y-0.5">
            {pending.nodes.changed.map((n) => (
              <li key={n.name}>
                {n.name}: {n.fields.map((f) => `${f.field} ${f.from}→${f.to}`).join(', ')}
              </li>
            ))}
            {pending.nodes.added.map((n) => (
              <li key={n.name}>+ {n.name} (new)</li>
            ))}
            {pending.nodes.removed.map((n) => (
              <li key={n.name}>− {n.name} (removed)</li>
            ))}
            {netChanged && <li>network: {pending.network.fields.join(', ') || 'CIDR'} changed — full rebuild</li>}
          </ul>
        </details>
      )}
    </div>
  );
}
