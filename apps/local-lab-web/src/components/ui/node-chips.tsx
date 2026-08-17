import { useMemo } from 'react';

import { tsr } from '@/lib/api';

export interface FleetNode {
  index: number;
  label: string;
}

/** The fleet's nodes as {index, label} rows. Memoized so the array is stable across renders (safe as
 *  an effect dependency) until the underlying fleet config changes. */
export function useFleetNodes(): FleetNode[] {
  const fleet = tsr.getFleetConfig.useQuery({ queryKey: ['fleet-config'] });
  const body = fleet.data?.status === 200 ? fleet.data.body : null;
  return useMemo(() => (body?.nodes ?? []).map((n, i) => ({ index: i, label: n.name })), [body]);
}

/** The node chip row shared by every picker. `isSelected`/`onToggle` cover both single-select (one
 *  active node) and multi-select (a set of nodes) callers — the button markup is identical. */
export function NodeChips({
  nodes,
  isSelected,
  onToggle,
}: {
  nodes: FleetNode[];
  isSelected: (index: number) => boolean;
  onToggle: (index: number) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {nodes.map((n) => (
        <button
          key={n.index}
          onClick={() => onToggle(n.index)}
          className={`rounded-md border px-2 py-1 font-mono text-xs transition ${
            isSelected(n.index)
              ? 'border-accent/50 bg-accent/10 text-accent'
              : 'border-border-dim text-text-muted hover:bg-hover-bg'
          }`}
        >
          {n.label}
        </button>
      ))}
    </div>
  );
}
