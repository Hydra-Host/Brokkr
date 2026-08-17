import { useEffect, useMemo, useState } from 'react';

import { NodeChips, useFleetNodes } from '@/components/ui/node-chips';
import { PickerModal } from '@/components/ui/picker-modal';
import type { LayerGroup, LayerOption } from '@/contract';
import { tsr } from '@/lib/api';
import { errorMessage } from '@/lib/errors';

type Selections = Record<string, string[]>;

function selValues(sel: Selections): Set<string> {
  return new Set(Object.values(sel).flat());
}

function optionEligible(o: LayerOption, sel: Selections, valueGroup: Record<string, string>): boolean {
  const sv = selValues(sel);
  for (const r of o.relations) {
    if (r.type === 'CONFLICTS' && sv.has(r.relatedOptionValue)) return false;
  }
  const orGroups = new Map<string, string[]>();
  for (const r of o.relations) {
    if (r.type !== 'REQUIRES') continue;
    const key = r.groupId ?? r.relatedOptionValue;
    orGroups.set(key, [...(orGroups.get(key) ?? []), r.relatedOptionValue]);
  }
  for (const alts of orGroups.values()) {
    const targetGroups = new Set(alts.map((a) => valueGroup[a]).filter(Boolean));
    const targetDecided = [...targetGroups].some((gs) => (sel[gs]?.length ?? 0) > 0);
    const anySelected = alts.some((a) => sv.has(a));
    if (targetDecided && !anySelected) return false;
  }
  return true;
}

function stabilize(sel: Selections, groups: LayerGroup[], valueGroup: Record<string, string>): Selections {
  let cur = { ...sel };
  for (let i = 0; i < 6; i++) {
    let changed = false;
    for (const g of groups) {
      const kept = (cur[g.slug] ?? []).filter((v) => {
        const o = g.options.find((x) => x.value === v);
        return o ? optionEligible(o, cur, valueGroup) : false;
      });
      if (kept.length !== (cur[g.slug]?.length ?? 0)) {
        cur = { ...cur, [g.slug]: kept };
        changed = true;
      }
    }
    if (!changed) break;
  }
  return cur;
}

export function LayerPicker({
  initialNode,
  onClose,
  onRun,
}: {
  initialNode: number;
  onClose: () => void;
  onRun: (p: { nodeIndex: number; base: string; customizations: Record<string, string | string[]> }) => void;
}) {
  const [node, setNode] = useState(initialNode);
  const nodes = useFleetNodes();
  const layerCatalog = tsr.getLayerCatalog.useQuery({
    queryKey: ['layer-catalog', node],
    queryData: { params: { nodeIndex: String(node) } },
    retry: false,
  });
  const cat = layerCatalog.data?.status === 200 ? layerCatalog.data.body : null;
  const err = errorMessage(layerCatalog.error);
  const loading = layerCatalog.isPending;
  const [base, setBase] = useState<string | null>(null);
  const [sel, setSel] = useState<Selections>({});

  // cleared synchronously during render (not an effect) so a warm-cached catalog never paints
  // with the previous node's base/selections.
  const [prevNode, setPrevNode] = useState(node);
  if (node !== prevNode) {
    setPrevNode(node);
    setBase(null);
    setSel({});
  }

  useEffect(() => {
    if (cat && base === null && cat.baseLayers.length > 0) {
      setBase(cat.baseLayers[0].slug);
    }
  }, [cat, base]);

  const groups: LayerGroup[] = useMemo(() => {
    const order = ['gpuDriver', 'gpuFramework', 'mlFramework', 'miscSoftware'];
    const rank = (slug: string) => {
      const i = order.indexOf(slug);
      return i === -1 ? order.length : i;
    };
    const g = cat && base ? (cat.componentsByBase[base] ?? []) : [];
    return [...g].sort((a, b) => rank(a.slug) - rank(b.slug));
  }, [cat, base]);
  const valueGroup = useMemo(() => {
    const m: Record<string, string> = {};
    for (const g of groups) for (const o of g.options) m[o.value] = g.slug;
    return m;
  }, [groups]);

  // a catalog refresh can drop the picked base or change eligibility — reconcile so Run can't
  // submit picks the current catalog no longer offers.
  useEffect(() => {
    if (!cat) return;
    if (base !== null && !cat.baseLayers.some((b) => b.slug === base)) {
      setBase(null); // the default-base effect re-picks from the fresh catalog
      setSel({});
      return;
    }
    setSel((s) => {
      // drop selections under groups the refreshed catalog no longer offers before stabilize, which
      // only prunes within current groups — an orphan keeps feeding CONFLICTS, wrongly disabling options.
      const known = new Set(groups.map((g) => g.slug));
      const kept = Object.fromEntries(Object.entries(s).filter(([slug]) => known.has(slug)));
      return stabilize(kept, groups, valueGroup);
    });
  }, [cat, base, groups, valueGroup]);

  const apply = (raw: Selections) => setSel(stabilize(raw, groups, valueGroup));
  const toggleSingle = (g: LayerGroup, v: string) => apply({ ...sel, [g.slug]: sel[g.slug]?.[0] === v ? [] : [v] });
  const toggleMulti = (g: LayerGroup, v: string) => {
    const cur = sel[g.slug] ?? [];
    apply({ ...sel, [g.slug]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] });
  };

  // filtered against the current catalog: guards the Run payload on the render where cat updates,
  // before the reconcile effect prunes the checkbox state one flush later.
  const customizations = useMemo(() => {
    const out: Record<string, string | string[]> = {};
    for (const g of groups) {
      const offered = new Set(g.options.map((o) => o.value));
      const s = (sel[g.slug] ?? []).filter((v) => offered.has(v));
      if (!s.length) continue;
      out[g.slug] = g.selectionType === 'SINGLE_SELECT' ? s[0] : s;
    }
    return out;
  }, [groups, sel]);

  // same window for the base: a refreshed catalog may have dropped it — gate Run on validity now,
  // not on the effect that resets it.
  const baseValid = base !== null && !!cat?.baseLayers.some((b) => b.slug === base);

  const summary = Object.values(customizations).flat();

  return (
    <PickerModal
      title="Layer test — select layers"
      onClose={onClose}
      width="w-[560px]"
      footerNote={
        <div className="text-text-dim max-w-[300px] truncate font-mono text-[11px]">
          {base ? `${base}${summary.length ? ' + ' + summary.join(', ') : ' (base only)'}` : 'pick a base OS'}
        </div>
      }
      confirmLabel="Provision + verify"
      onConfirm={() => base && baseValid && onRun({ nodeIndex: node, base, customizations })}
      confirmDisabled={!baseValid}
    >
      <div className="space-y-1">
        <label className="text-text-muted text-[11px] tracking-wide uppercase">Node</label>
        <NodeChips nodes={nodes} isSelected={(i) => node === i} onToggle={setNode} />
      </div>

      {loading && <div className="text-text-dim text-xs">loading catalog…</div>}
      {err && !cat && <div className="text-status-offline text-xs">{err}</div>}

      {cat && !loading && (
        <>
          <div className="text-text-dim text-[11px]">
            device <span className="font-mono">{cat.deviceId.slice(-4)}</span> · {cat.lifecycleStatus ?? '?'} · GPU:{' '}
            <span className="font-mono">{cat.gpuModel ?? 'none'}</span>
            {!cat.gpuModel && (
              <span className="text-status-warning/70 mt-0.5 block">
                No GPU discovered → only hardware-agnostic layers (docker, mellanox) are eligible. Pass a GPU through
                (Settings) + rebuild, then re-discover to unlock driver/CUDA.
              </span>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-text-muted text-[11px] tracking-wide uppercase">Base OS</label>
            <div className="flex flex-wrap gap-1.5">
              {cat.baseLayers.map((b) => (
                <button
                  key={b.slug}
                  onClick={() => {
                    setBase(b.slug);
                    setSel({});
                  }}
                  title={b.name}
                  className={`rounded-md border px-2 py-1 text-xs transition ${
                    base === b.slug
                      ? 'border-accent/50 bg-accent/10 text-accent'
                      : 'border-border-dim text-text-muted hover:bg-hover-bg'
                  }`}
                >
                  {b.slug}
                </button>
              ))}
              {cat.baseLayers.length === 0 && (
                <span className="text-text-dim text-[11px]">no base layers eligible</span>
              )}
            </div>
          </div>

          {base &&
            groups.map((g) => (
              <div key={g.slug} className="space-y-1.5">
                <label className="text-text-muted text-[11px] tracking-wide uppercase">
                  {g.name}{' '}
                  <span className="text-text-dim normal-case">
                    · {g.selectionType === 'MULTI_SELECT' ? 'multi' : 'one'}
                  </span>
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {g.options.map((o) => {
                    const ok = optionEligible(o, sel, valueGroup);
                    const on = (sel[g.slug] ?? []).includes(o.value);
                    return (
                      <button
                        key={o.value}
                        disabled={!ok && !on}
                        onClick={() =>
                          g.selectionType === 'MULTI_SELECT' ? toggleMulti(g, o.value) : toggleSingle(g, o.value)
                        }
                        title={!ok ? 'ineligible with the current selection' : o.label}
                        className={`rounded-md border px-2 py-1 text-xs transition ${
                          on
                            ? 'border-status-online/50 bg-status-online/10 text-status-online'
                            : ok
                              ? 'border-border-dim text-text-muted hover:bg-hover-bg'
                              : 'border-border-dim text-text-label cursor-not-allowed line-through'
                        }`}
                      >
                        {o.value}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          {base && groups.length === 0 && (
            <div className="text-text-dim text-[11px]">
              no component layers eligible for this base — base-only deploy
            </div>
          )}
        </>
      )}
    </PickerModal>
  );
}
