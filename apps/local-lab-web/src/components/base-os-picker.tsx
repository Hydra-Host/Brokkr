import { useEffect, useMemo, useState } from 'react';

import { NodeChips, useFleetNodes } from '@/components/ui/node-chips';
import { PickerModal } from '@/components/ui/picker-modal';
import { tsr } from '@/lib/api';
import { errorMessage } from '@/lib/errors';

export interface BaseOsAssignment {
  nodeIndex: number;
  baseOses: string[];
}

type SplitMode = 'round-robin' | 'contiguous';

function splitRoundRobin<T>(items: T[], buckets: number): T[][] {
  const out: T[][] = Array.from({ length: buckets }, () => []);
  items.forEach((it, i) => out[i % buckets].push(it));
  return out;
}

function splitContiguous<T>(items: T[], buckets: number): T[][] {
  const base = Math.floor(items.length / buckets);
  const extra = items.length % buckets;
  const out: T[][] = [];
  let idx = 0;
  for (let b = 0; b < buckets; b++) {
    const size = base + (b < extra ? 1 : 0);
    out.push(items.slice(idx, idx + size));
    idx += size;
  }
  return out;
}

function splitItems<T>(items: T[], buckets: number, mode: SplitMode): T[][] {
  return mode === 'contiguous' ? splitContiguous(items, buckets) : splitRoundRobin(items, buckets);
}

export function BaseOsPicker({
  initialNodes,
  onClose,
  onRun,
}: {
  initialNodes: number[];
  onClose: () => void;
  onRun: (p: { assignments: BaseOsAssignment[] }) => void;
}) {
  const nodes = useFleetNodes();
  const allNodeIdx = nodes.map((n) => n.index);
  const nodeLabel = (i: number) => nodes.find((n) => n.index === i)?.label ?? `node ${i}`;

  const [selectedNodes, setSelectedNodes] = useState<number[]>(
    initialNodes.length ? [...initialNodes].sort((a, b) => a - b) : [],
  );
  // base OS layers are device-agnostic, so the catalog is read from node 0.
  const layerCatalog = tsr.getLayerCatalog.useQuery({
    queryKey: ['layer-catalog', 0],
    queryData: { params: { nodeIndex: '0' } },
    retry: false,
  });
  const cat = layerCatalog.data?.status === 200 ? layerCatalog.data.body : null;
  const err = errorMessage(layerCatalog.error);
  const loading = layerCatalog.isPending;
  const [selected, setSelected] = useState<string[]>([]);
  const [split, setSplit] = useState<SplitMode>('round-robin');

  useEffect(() => {
    if (!selectedNodes.length && allNodeIdx.length) setSelectedNodes(allNodeIdx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes]);

  useEffect(() => {
    if (cat) setSelected(cat.baseLayers.map((b) => b.slug));
  }, [cat]);

  const bases = cat?.baseLayers ?? [];
  const toggleOs = (slug: string) =>
    setSelected((s) => (s.includes(slug) ? s.filter((x) => x !== slug) : [...s, slug]));
  const allOsOn = bases.length > 0 && selected.length === bases.length;
  const toggleAllOs = () => setSelected(allOsOn ? [] : bases.map((b) => b.slug));
  const toggleNode = (i: number) =>
    setSelectedNodes((s) => (s.includes(i) ? s.filter((x) => x !== i) : [...s, i].sort((a, b) => a - b)));
  const allNodesOn = allNodeIdx.length > 0 && selectedNodes.length === allNodeIdx.length;
  const toggleAllNodes = () => setSelectedNodes(allNodesOn ? [] : allNodeIdx);

  const ordered = bases.map((b) => b.slug).filter((s) => selected.includes(s));
  const assignments = useMemo<BaseOsAssignment[]>(() => {
    if (!selectedNodes.length || !ordered.length) return [];
    const chunks = splitItems(ordered, selectedNodes.length, split);
    return selectedNodes.map((nodeIndex, k) => ({ nodeIndex, baseOses: chunks[k] })).filter((a) => a.baseOses.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNodes, selected, bases, split]);

  return (
    <PickerModal
      title="Base OS matrix — fan out across nodes"
      onClose={onClose}
      width="w-[600px]"
      footerNote={
        <span className="text-text-dim text-[11px]">
          One pinned run per node, in parallel — each reprovisions between its base OSes.
        </span>
      }
      confirmLabel="Cycle + verify"
      onConfirm={() => onRun({ assignments })}
      confirmDisabled={assignments.length === 0}
    >
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="text-text-muted text-[11px] tracking-wide uppercase">
            Nodes ({selectedNodes.length}/{allNodeIdx.length})
          </label>
          {allNodeIdx.length > 0 && (
            <button onClick={toggleAllNodes} className="text-accent/80 hover:text-accent text-[11px]">
              {allNodesOn ? 'clear all' : 'select all'}
            </button>
          )}
        </div>
        <NodeChips nodes={nodes} isSelected={(i) => selectedNodes.includes(i)} onToggle={toggleNode} />
      </div>

      {loading && <div className="text-text-dim text-xs">loading catalog…</div>}
      {err && !cat && <div className="text-status-offline text-xs">{err}</div>}

      {cat && !loading && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="text-text-muted text-[11px] tracking-wide uppercase">
              Base OS ({selected.length}/{bases.length})
            </label>
            {bases.length > 0 && (
              <button onClick={toggleAllOs} className="text-accent/80 hover:text-accent text-[11px]">
                {allOsOn ? 'clear all' : 'select all'}
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {bases.map((b) => {
              const on = selected.includes(b.slug);
              return (
                <button
                  key={b.slug}
                  onClick={() => toggleOs(b.slug)}
                  title={b.name}
                  className={`rounded-md border px-2 py-1 text-xs transition ${
                    on
                      ? 'border-status-online/50 bg-status-online/10 text-status-online'
                      : 'border-border-dim text-text-muted hover:bg-hover-bg'
                  }`}
                >
                  {b.slug}
                </button>
              );
            })}
            {bases.length === 0 && <span className="text-text-dim text-[11px]">no base OS layers eligible</span>}
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <label className="text-text-muted text-[11px] tracking-wide uppercase">Split</label>
        {(['round-robin', 'contiguous'] as SplitMode[]).map((mode) => (
          <button
            key={mode}
            onClick={() => setSplit(mode)}
            title={
              mode === 'round-robin'
                ? 'interleave OSes across nodes (balanced)'
                : 'ordered blocks — node 1 gets the first chunk, etc.'
            }
            className={`rounded-md border px-2 py-0.5 font-mono text-[11px] transition ${
              split === mode
                ? 'border-accent/50 bg-accent/10 text-accent'
                : 'border-border-dim text-text-muted hover:bg-hover-bg'
            }`}
          >
            {mode}
          </button>
        ))}
      </div>

      {assignments.length > 0 && (
        <div className="border-border-dim bg-text-dim/[0.02] space-y-1 rounded-md border p-2.5">
          <div className="text-text-muted text-[11px] tracking-wide uppercase">
            Distribution — {ordered.length} OS over {assignments.length} node{assignments.length > 1 ? 's' : ''} ·{' '}
            {split}
          </div>
          {assignments.map((a) => (
            <div key={a.nodeIndex} className="flex items-baseline gap-2 text-[11px]">
              <span className="text-accent/90 w-16 shrink-0 font-mono">{nodeLabel(a.nodeIndex)}</span>
              <span className="text-text-muted font-mono">{a.baseOses.join(', ')}</span>
            </div>
          ))}
        </div>
      )}
    </PickerModal>
  );
}
