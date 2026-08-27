import type { ReactNode } from 'react';

import type { RejectedEntry } from '@/contract';

export const rejectionLine = (r: RejectedEntry): string =>
  r.detail ? `${r.path} — ${r.reason} (${r.detail})` : `${r.path} — ${r.reason}`;

/** A 200 that dropped part of the request. Silence here is what let a pinned path answer ok and
 *  change nothing, so every writer that can partly refuse renders this. */
export function RejectedWrites({ rejected, note }: { rejected: RejectedEntry[]; note?: ReactNode }) {
  if (rejected.length === 0) return null;
  return (
    <div className="border-status-warning/50 bg-status-warning/10 space-y-0.5 rounded-md border px-3 py-2 text-[11px]">
      <div className="text-status-warning">Not written:</div>
      {rejected.map((r) => (
        <div key={r.path} className="text-text-muted font-mono">
          {rejectionLine(r)}
        </div>
      ))}
      {note && <div className="text-status-warning/80 pt-1">{note}</div>}
    </div>
  );
}
