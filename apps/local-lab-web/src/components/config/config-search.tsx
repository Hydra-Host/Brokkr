import { useMemo, useState } from 'react';

import type { ConfigTreeEntry } from '@/contract';

import { knobLocation } from '@/features/config/knob-location';
import { isOverridden } from '@/lib/config-tree';

export interface SearchHit {
  entry: ConfigTreeEntry;
  route: string;
  anchor: string;
  section: string;
}

/** Label, path and value all match, because an operator looks for a knob by whichever of the three
 *  they happen to remember. A secret's value is masked, so only its label and path can match. */
export function searchConfig(entries: ConfigTreeEntry[], query: string): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const hits: SearchHit[] = [];
  for (const entry of entries) {
    const haystack = `${entry.label} ${entry.path} ${entry.secret ? '' : entry.value}`.toLowerCase();
    if (!haystack.includes(q)) continue;
    const where = knobLocation(entry.path);
    if (!where) continue;
    hits.push({ entry, route: where.route, anchor: where.anchor, section: where.section });
  }
  return hits;
}

export function ConfigSearch({ entries, onPick }: { entries: ConfigTreeEntry[]; onPick: (hit: SearchHit) => void }) {
  const [query, setQuery] = useState('');
  const hits = useMemo(() => searchConfig(entries, query), [entries, query]);

  return (
    <div className="space-y-1">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="find a knob…"
        aria-label="Find a knob by label, path or value"
        className="border-border-dim bg-bg-primary text-text-primary placeholder:text-text-label focus:border-accent/50 w-full rounded border px-2 py-1 font-mono text-[11px] outline-none"
      />
      {query.trim().length >= 2 && (
        <div className="space-y-0.5">
          {hits.length === 0 && <div className="text-text-dim text-[10px]">no knob matches</div>}
          {hits.slice(0, 12).map((hit) => (
            <button
              key={hit.entry.path}
              onClick={() => {
                setQuery('');
                onPick(hit);
              }}
              className="hover:bg-hover-bg flex w-full items-baseline gap-1.5 rounded px-1 py-0.5 text-left text-[10px]"
            >
              {isOverridden(hit.entry) && (
                <span className="bg-accent h-2.5 w-0.5 shrink-0 self-center shadow-[0_0_4px_var(--color-accent-glow)]" />
              )}
              <span className="text-text-muted min-w-0 truncate">{hit.entry.label}</span>
              <span className="text-text-label ml-auto shrink-0 font-mono">{hit.section}</span>
            </button>
          ))}
          {hits.length > 12 && <div className="text-text-dim text-[10px]">{hits.length - 12} more…</div>}
        </div>
      )}
    </div>
  );
}
