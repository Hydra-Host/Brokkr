import type { ReactNode } from 'react';

export interface ApplyBarModel {
  /** False when the devenv eval seed failed: every field below is a bare default, so saving is refused. */
  seeded: boolean;
  /** Knobs whose value differs from their declared default. */
  overridden: number;
  total: number;
  /** Unsaved edits in the page's own form. The domain pages own their forms, so they supply this. */
  unsaved?: number;
  /** What applying the pending work costs, once the apply classifier can say. */
  cost?: string;
  /** Fleet drift the engine reports, in the shape PendingBanner already renders. */
  fleetPending?: { count: number; note: string | null } | null;
}

const TONE = {
  blocked: 'border-status-offline/50 bg-status-offline/10 text-status-offline',
  pending: 'border-status-warning/50 bg-status-warning/10 text-status-warning',
  clean: 'border-border-dim bg-bg-secondary text-text-dim',
} as const;

/** One line, always in the same place, on every /config page. The page below it scrolls; this does
 *  not — which is the whole reason the layout is pinned to one screen. */
export function ApplyBar({ model, actions }: { model: ApplyBarModel; actions?: ReactNode }) {
  const parts: string[] = [];
  if (model.unsaved && model.unsaved > 0) parts.push(`${model.unsaved} unsaved`);
  if (model.overridden > 0) parts.push(`${model.overridden} of ${model.total} overridden`);
  if (model.fleetPending && model.fleetPending.count > 0)
    parts.push(`${model.fleetPending.count} fleet changes pending`);
  if (model.cost) parts.push(model.cost);

  const tone = !model.seeded ? TONE.blocked : parts.length > 0 ? TONE.pending : TONE.clean;
  const message = !model.seeded
    ? 'Saving is blocked — the devenv eval seed failed, so every field below shows a bare default'
    : parts.length > 0
      ? parts.join(' · ')
      : 'no changes on this stack';

  return (
    <div
      data-tour="apply-bar"
      className={`flex flex-wrap items-center gap-3 rounded-md border px-3 py-2 text-[11px] ${tone}`}
    >
      <span className="min-w-0 flex-1 break-words">{message}</span>
      {model.fleetPending?.note && <span className="text-status-warning/80 shrink-0">{model.fleetPending.note}</span>}
      {actions && <span className="ml-auto flex shrink-0 items-center gap-2">{actions}</span>}
    </div>
  );
}
