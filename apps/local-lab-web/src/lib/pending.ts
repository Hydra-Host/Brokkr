import type { FleetPending } from '@repo/local-lab-contract';

/** Network drift counts as 1 even when no per-node field changed; shared by the banner and save toast so headlines can't diverge. */
export function pendingChangeCount(pending: FleetPending): number {
  const s = pending.summary;
  return s.added + s.removed + s.changed + (pending.network.changed ? 1 : 0);
}

/** A pure plane flip has zero drift counts; its wording mirrors PendingBanner's planes-change branch so toast and banner stay consistent. */
export function saveToastMessage(pending: FleetPending | null): string {
  if (!pending || pending.inSync) return 'Saved';
  if (pending.severity === 'planes-change')
    return 'Saved — fleet planes changed, not yet applied. Apply to take effect.';
  const n = pendingChangeCount(pending);
  if (n === 0 && pending.note) return `Saved — ${pending.note}`;
  return `Saved — ${n} change${n === 1 ? '' : 's'} pending. Apply to take effect.`;
}
