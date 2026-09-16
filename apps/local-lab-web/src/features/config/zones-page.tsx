import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

import { ApplyBar } from '@/components/config/apply-bar';
import { SectionRail, scrollToSection, type RailItem } from '@/components/config/section-rail';
import { UnsavedNavGate } from '@/components/config/unsaved-nav-gate';
import { SectionHeading } from '@/components/console';
import type { Zone, ZoneWrite, ZonesConfig } from '@/contract';
import { ZONE_INDEX_MAX, ZONE_INDEX_MIN } from '@/contract';
import { ZoneRuntimeCard, useZoneRuntime } from '@/features/runtime';
import { FleetGraph, useFleetTopology, type TopologyNode } from '@/features/topology';
import { tsr } from '@/lib/api';
import { useReportDirty } from '@/lib/config-dirty';
import { errorMessage, thrownBodyError } from '@/lib/errors';
import { canSaveForm, shouldHydrateForm } from '@/lib/unsaved-nav';

interface Row extends ZoneWrite {
  /** The name this row was loaded under. A differing `name` is a rename rather than a new zone. */
  was: string | null;
  baseDeclared: boolean;
}

const toRow = (zone: Zone): Row => ({
  name: zone.name,
  index: zone.index,
  bridges: zone.bridges,
  was: zone.name,
  baseDeclared: zone.baseDeclared,
});

const nextFreeIndex = (rows: Row[]): number => {
  const taken = new Set(rows.map((row) => row.index));
  for (let i = ZONE_INDEX_MIN; i <= ZONE_INDEX_MAX; i++) if (!taken.has(i)) return i;
  return ZONE_INDEX_MAX;
};

/** Rows the save would write, counting a dropped zone too — the apply bar reports work pending, and a
 *  removal is work the same way an edit is. */
export const dirtyZoneCount = (rows: Row[], before: Zone[]): number => {
  const removed = before.filter((zone) => !rows.some((row) => row.was === zone.name)).length;
  const touched = rows.filter((row) => {
    const was = before.find((zone) => zone.name === row.was);
    return was === undefined || was.name !== row.name || was.index !== row.index || was.bridges !== row.bridges;
  }).length;
  return removed + touched;
};

/** A bare-metal machine has no per-node card on the fleet page, so its roster section is the anchor. */
const hashFor = (name: string, nodes: TopologyNode[]): string =>
  nodes.find((node) => node.name === name)?.kind === 'baremetal' ? 'BAREMETAL' : `node-${name}`;

/** Only one rename can ride a save, because the desired set cannot express two. */
const renameOf = (rows: Row[]): { from: string; to: string } | undefined => {
  const changed = rows.filter((row) => row.was !== null && row.was !== row.name);
  return changed.length === 1 ? { from: changed[0].was as string, to: changed[0].name } : undefined;
};

export function ConfigZonesPage() {
  const cfg = tsr.getZonesConfig.useQuery({ queryKey: ['zones-config'] });
  const topology = useFleetTopology();
  const navigate = useNavigate();
  const put = tsr.putZonesConfig.useMutation();
  const runtime = useZoneRuntime();
  const [rows, setRows] = useState<Row[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [active, setActive] = useState<string>();
  useReportDirty('zones', dirty);

  const body: ZonesConfig | null = cfg.data?.status === 200 ? cfg.data.body : null;

  useEffect(() => {
    if (!body) return;
    if (!shouldHydrateForm(hydrated, dirty)) return;
    setRows(body.zones.map(toRow));
    setHydrated(true);
    setDirty(false);
    // dirty/hydrated are read but not deps: a save-success flip must not rehydrate the pre-save set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.data]);

  const patch = (i: number, p: Partial<Row>) => {
    setRows((rs) => rs.map((row, k) => (k === i ? { ...row, ...p } : row)));
    setDirty(true);
  };
  const addZone = () => {
    setRows((rs) => [
      ...rs,
      { name: `zone-${nextFreeIndex(rs)}`, index: nextFreeIndex(rs), bridges: 1, was: null, baseDeclared: false },
    ]);
    setDirty(true);
  };
  const removeZone = (i: number) => {
    setRows((rs) => rs.filter((_, k) => k !== i));
    setDirty(true);
  };

  const rename = renameOf(rows);
  const usedBridges = rows.reduce((n, row) => n + row.bridges, 0);
  const saveable = canSaveForm(hydrated, dirty, put.isPending) && (body?.seeded ?? false);

  const save = () => {
    if (!saveable) return;
    setError('');
    put.mutate(
      { body: { zones: rows.map(({ name, index, bridges }) => ({ name, index, bridges })), rename } },
      {
        onSuccess: () => {
          setDirty(false);
          void cfg.refetch();
        },
        onError: (err: unknown) => setError(thrownBodyError(err) ?? 'the zone set was refused'),
      },
    );
  };

  const rail: RailItem[] = [
    ...rows.map((row) => ({
      id: `zone-${row.index}`,
      label: row.name || '(unnamed)',
      changed: row.was === null || row.was !== row.name ? 1 : 0,
    })),
    ...(body && body.reconcile.length > 0
      ? [{ id: 'RECONCILE', label: 'reconcile', changed: 0, note: `${body.reconcile.length}` }]
      : []),
  ];
  const select = (id: string) => {
    setActive(id);
    scrollToSection(id);
  };

  const readError = errorMessage(cfg.error);

  return (
    <div className="grid grid-cols-1 gap-6 lg:h-full lg:grid-cols-[260px_1fr]">
      <UnsavedNavGate dirty={dirty} what="zone" />
      <SectionRail
        items={rail}
        activeId={active}
        onSelect={select}
        footer={
          <div className="text-text-dim space-y-1 px-2 text-[10px]">
            <div>
              {usedBridges} of {body?.capacity.total ?? 0} bridge ordinals used
            </div>
            <div>reserved: {(body?.reservedNames ?? []).join(', ') || 'none'}</div>
          </div>
        }
      />

      <div className="flex min-h-0 flex-col gap-4 lg:overflow-auto">
        <ApplyBar
          model={{
            seeded: body?.seeded ?? true,
            overridden: rows.filter((row) => row.was !== null && row.was !== row.name).length,
            total: rows.length,
            unsaved: dirty ? dirtyZoneCount(rows, body?.zones ?? []) : 0,
            cost: rename ? `renaming ${rename.from} re-derives its acl password, so the seed must run` : undefined,
          }}
          actions={
            <>
              <button
                onClick={save}
                disabled={!saveable}
                className="bg-accent/20 text-accent hover:bg-accent/30 rounded-md px-3 py-1 text-[11px] disabled:opacity-40"
              >
                {put.isPending ? 'saving…' : dirty ? 'Save zones' : 'Saved'}
              </button>
              <button
                onClick={addZone}
                className="border-border-dim text-text-muted hover:bg-hover-bg rounded border px-2 py-1 text-[11px]"
              >
                + Add zone
              </button>
            </>
          }
        />

        {readError && <div className="text-status-offline text-sm">failed to load zones — {readError}</div>}
        {error && <div className="text-status-offline text-[11px]">{error}</div>}

        <div id="TOPOLOGY" className="scroll-mt-2 space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <SectionHeading>Fleet</SectionHeading>
            <span className="text-text-dim text-[11px]">
              every zone with the bridges and nodes it holds — click a zone to reach its card, a node to reach its
              hardware
            </span>
          </div>
          <FleetGraph
            model={topology.model}
            onSelectZone={(name) => scrollToSection(`zone-${rows.find((row) => row.was === name)?.index ?? 0}`)}
            onSelectNode={(name) =>
              void navigate({
                to: '/config/fleet',
                hash: hashFor(name, [
                  ...topology.model.zones.flatMap((zone) => zone.nodes),
                  ...topology.model.orphanNodes,
                ]),
              })
            }
          />
        </div>

        {rows.map((row, i) => (
          <ZoneCard
            key={row.was ?? `new-${i}`}
            row={row}
            derived={body?.zones.find((zone) => zone.name === row.was)?.derived ?? null}
            nodes={topology.model.zones.find((zone) => zone.name === row.was)?.nodes ?? []}
            runtime={runtime.zones?.find((zone) => zone.zoneName === row.was) ?? null}
            onPatch={(p) => patch(i, p)}
            onRemove={() => removeZone(i)}
            canRemove={rows.length > 1}
          />
        ))}

        {body && <ReconcileSection body={body} />}
      </div>
    </div>
  );
}

function ZoneCard({
  row,
  derived,
  nodes,
  runtime,
  onPatch,
  onRemove,
  canRemove,
}: {
  row: Row;
  derived: Zone['derived'] | null;
  nodes: TopologyNode[];
  runtime: Parameters<typeof ZoneRuntimeCard>[0]['zone'] | null;
  onPatch: (p: Partial<Row>) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const renamed = row.was !== null && row.was !== row.name;
  return (
    <div
      id={`zone-${row.index}`}
      className="border-border-dim bg-text-dim/[0.02] scroll-mt-2 space-y-3 rounded-lg border p-3"
    >
      <div className="flex flex-wrap items-end gap-3">
        <span aria-hidden className={`w-0.5 shrink-0 self-stretch ${renamed ? 'bg-accent' : 'bg-transparent'}`} />
        <label className="flex flex-col gap-0.5">
          <span className="text-text-label text-[10px] tracking-wide uppercase">name</span>
          <input
            value={row.name}
            onChange={(e) => onPatch({ name: e.target.value })}
            className="border-border-dim bg-bg-primary text-text-primary focus:border-accent/50 w-40 rounded border px-1.5 py-1 font-mono text-[11px] outline-none"
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-text-label text-[10px] tracking-wide uppercase">index</span>
          <input
            type="number"
            value={row.index}
            min={ZONE_INDEX_MIN}
            max={ZONE_INDEX_MAX}
            onChange={(e) => onPatch({ index: Number(e.target.value) })}
            className="border-border-dim bg-bg-primary text-text-primary focus:border-accent/50 w-20 rounded border px-1.5 py-1 font-mono text-[11px] outline-none"
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-text-label text-[10px] tracking-wide uppercase">bridges</span>
          <input
            type="number"
            value={row.bridges}
            min={1}
            onChange={(e) => onPatch({ bridges: Number(e.target.value) })}
            className="border-border-dim bg-bg-primary text-text-primary focus:border-accent/50 w-20 rounded border px-1.5 py-1 font-mono text-[11px] outline-none"
          />
        </label>
        <button
          onClick={onRemove}
          disabled={!canRemove}
          title={canRemove ? 'remove this zone from the declared set' : 'a fleet needs at least one zone'}
          className="border-border-dim text-text-muted hover:bg-hover-bg ml-auto rounded border px-2 py-1 text-[10px] disabled:opacity-40"
        >
          remove
        </button>
      </div>

      {renamed && (
        <div className="text-status-warning/90 text-[10px]">
          renaming {row.was} — the index stays, so the hub row and every derived node identity stay too
        </div>
      )}

      {derived && (
        <div className="text-text-dim grid grid-cols-1 gap-x-4 gap-y-0.5 text-[10px] sm:grid-cols-2">
          <div>
            uuid <span className="text-text-muted font-mono">{derived.uuid}</span>
          </div>
          <div className="sm:col-span-2">
            nodes <span className="text-text-muted font-mono">{derived.nodeCount}</span>
            {nodes.length > 0 && (
              <span className="ml-2 inline-flex flex-wrap gap-1.5">
                {nodes.map((node) => (
                  <Link
                    key={node.name}
                    to="/config/fleet"
                    hash={hashFor(node.name, nodes)}
                    className="border-border-dim text-text-muted hover:bg-hover-bg rounded border px-1.5 font-mono"
                  >
                    {node.name}
                  </Link>
                ))}
              </span>
            )}
            <Link
              to="/config/fleet"
              search={{ zone: row.name }}
              hash="NODES"
              className="text-accent/80 hover:text-accent ml-2"
              title={`add a node already assigned to ${row.name}`}
            >
              + add node
            </Link>
          </div>
          <div className="sm:col-span-2">
            bridges{' '}
            <span className="text-text-muted font-mono">
              {derived.bridges.map((bridge) => `${bridge.proc} :${bridge.port}/:${bridge.grpc}`).join(' · ') || '—'}
            </span>
          </div>
        </div>
      )}

      {runtime ? (
        <ZoneRuntimeCard zone={runtime} />
      ) : (
        <div className="text-text-label text-[10px]">declared, not seeded — save, then apply above</div>
      )}
    </div>
  );
}

/** A hub row the fleet does not declare is listed rather than reconciled, and the seeded fixture is
 *  labelled — every stack has it, so calling it drift would fire every time. */
function ReconcileSection({ body }: { body: ZonesConfig }) {
  return (
    <div id="RECONCILE" className="scroll-mt-2 space-y-2">
      <SectionHeading>Reconcile</SectionHeading>
      {body.hubReadError !== null ? (
        <div className="text-status-offline text-[11px]">
          the hub Zone rows could not be read — {body.hubReadError}. Nothing below is a measurement.
        </div>
      ) : body.reconcile.length === 0 ? (
        <div className="text-text-dim text-[11px]">the hub and the fleet declare the same zones</div>
      ) : (
        <div className="space-y-1">
          {body.reconcile.map((rowItem) => (
            <div
              key={`${rowItem.side}-${rowItem.name ?? rowItem.zoneId}`}
              className="flex flex-wrap items-baseline gap-2 text-[11px]"
            >
              <span className="text-text-primary w-40 font-mono">{rowItem.name ?? '(unnamed)'}</span>
              <span className="text-text-dim w-24">{rowItem.side === 'hub-only' ? 'in the hub' : 'in the fleet'}</span>
              {rowItem.fixture ? (
                <span className="text-text-label">seeded for admin ops — every stack has it</span>
              ) : (
                <span className="text-status-warning/80">
                  {rowItem.side === 'hub-only' ? 'no fleet zone declares it' : 'the hub has not seeded it'}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
