import { useState } from 'react';

import { GateModal } from '@/components/console';
import type { ApplyRow } from '@/features/config/apply-model';
import { useApply } from '@/lib/use-apply';
import { usePaintedHtml } from '@/lib/use-log-stream';

const BOX = 'rounded-md border px-3 py-2 text-[11px]';
const WARN = `${BOX} border-status-warning/50 bg-status-warning/10 text-status-warning`;
const BAD = `${BOX} border-status-offline/50 bg-status-offline/10 text-status-offline`;

/** One place to apply every config change, on every /config page. The row's action comes from the
 *  class the path declares, so nothing here decides what a change costs. */
export function ApplyPanel() {
  const apply = useApply();
  const log = usePaintedHtml(apply.stream.logRef, apply.stream.logHtml || 'applying…');

  if (apply.readError) {
    return (
      <div className={WARN}>
        The pending state could not be read ({apply.readError}), so this panel cannot say whether anything is waiting on
        an apply. An empty panel here would be a guess.
      </div>
    );
  }
  if (apply.seeded === false) {
    return (
      <div className={BAD}>
        The devenv eval seed failed, so every field below is a bare default and saving is refused.
      </div>
    );
  }
  if (apply.rows.length === 0 && apply.applyingOf === null) return null;

  return (
    <div className="space-y-2">
      {apply.rows.length > 0 && (
        <div className={`${WARN} space-y-1.5`}>
          <div className="text-status-warning text-[10px] tracking-wide uppercase">saved, not applied</div>
          {apply.rows.map((row) => (
            <Row key={row.id} row={row} busy={apply.busy} onRun={() => apply.run(row)} />
          ))}
        </div>
      )}
      {apply.error && <div className="text-status-offline font-mono text-[11px]">{apply.error}</div>}
      {apply.applyingOf !== null && (
        <div className="space-y-1">
          <div className="text-text-label text-[10px] tracking-wide uppercase">{apply.applyingOf}</div>
          <pre
            ref={log}
            className="border-border-dim bg-bg-secondary text-text-primary max-h-56 overflow-auto rounded-md border p-3 font-mono text-xs whitespace-pre"
          />
        </div>
      )}
      {apply.gate && <GateModal gate={apply.gate} />}
    </div>
  );
}

function Row({ row, busy, onRun }: { row: ApplyRow; busy: boolean; onRun: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span className="text-text-label w-12 shrink-0 text-[10px] tracking-wide uppercase">{row.domain}</span>
      <span className="text-text-muted min-w-0 font-mono break-all">{row.detail}</span>
      <span className="text-status-warning/80 min-w-0">{row.cost}</span>
      {row.steps.length > 0 && (
        <button onClick={() => setOpen(!open)} className="text-accent/80 hover:text-accent shrink-0">
          {open ? '▾ steps' : `▸ ${row.steps.length} steps`}
        </button>
      )}
      <span className="ml-auto shrink-0">
        {row.action === null ? (
          // a class no run clears renders no button at all: a disabled one reads as "try later"
          <span className="text-text-label">no action applies this</span>
        ) : (
          <button
            onClick={onRun}
            disabled={busy || row.blockedBy !== null}
            title={row.blockedBy ?? undefined}
            className={`rounded px-2 py-1 text-[11px] disabled:opacity-40 ${
              row.destructive
                ? 'bg-status-offline/20 text-status-offline hover:bg-status-offline/30'
                : 'bg-accent/20 text-accent hover:bg-accent/30'
            }`}
          >
            {row.blockedBy ?? (busy ? 'applying…' : `Apply${row.destructive ? ' ⚠' : ''}`)}
          </button>
        )}
      </span>
      {open && (
        <ol className="text-text-muted w-full space-y-0.5 pl-12">
          {row.steps.map((step, i) => (
            <li key={step.id} className="flex flex-wrap items-baseline gap-2">
              <span className="text-text-label w-4 shrink-0 font-mono">{i + 1}.</span>
              <span className="text-text-primary font-mono">{step.id}</span>
              <span>{step.label}</span>
              <span className="text-text-label min-w-0 text-[10px]">{step.why}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
