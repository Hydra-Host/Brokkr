import { useEffect, useMemo, useState } from 'react';

import { NodeChips, useFleetNodes } from '@/components/ui/node-chips';
import { PickerModal } from '@/components/ui/picker-modal';
import type { DiskLayoutSelection, DiskLayouts, StorageConfig, StorageDiskGroup } from '@/contract';
import { tsr } from '@/lib/api';
import { errorMessage } from '@/lib/errors';

const CONFIG_LABELS: Record<string, string> = {
  direct: 'Direct',
  lvm: 'LVM',
  raid0: 'RAID 0',
  raid1: 'RAID 1',
  raid5: 'RAID 5',
  raid6: 'RAID 6',
  raid10: 'RAID 10',
  raid50: 'RAID 50',
  raid60: 'RAID 60',
};

const STANDARD_MOUNTPOINTS = ['/', '/home', '/data', '/var', '/srv', '/opt'];

type Row = { config: string; format: string; mountpoint: string };
type Rows = Record<string, Row>;

const diskTypeOf = (configs: StorageConfig[], group: string) =>
  configs.find((c) => c.disk_group_name === group)?.disk_type ?? group;

function fmtSize(bytes?: number): string {
  if (!bytes) return '';
  const gb = bytes / 1_000_000_000;
  return gb >= 1000 ? `${(gb / 1000).toFixed(gb % 1000 ? 1 : 0)} TB` : `${Math.round(gb)} GB`;
}

// Default rows from the node's seeded layout (matches the hub's getDefaultDiskLayouts).
function defaultRows(cat: DiskLayouts): Rows {
  const byGroup: Record<string, StorageDiskGroup> = {};
  const d = cat.default;
  if (d.os_disks_group) byGroup[d.os_disks_group.group] = d.os_disks_group;
  for (const g of d.data_disks_groups ?? []) byGroup[g.group] = g;
  for (const g of d.cold_storage_disks_groups ?? []) byGroup[g.group] = g;

  const rows: Rows = {};
  cat.configs.forEach((c, i) => {
    const seed = byGroup[c.disk_group_name];
    const nonDirect = c.capabilities.find((cap) => cap !== 'direct');
    rows[c.disk_group_name] = {
      config: seed?.config ?? nonDirect ?? c.capabilities[0] ?? 'direct',
      format: seed?.file_system ?? c.file_systems[0] ?? 'ext4',
      mountpoint: seed?.mountpoint ?? (i === 0 ? '/' : i === 1 ? '/data' : `/data${i}`),
    };
  });
  return rows;
}

// Errors unless the rows form a valid layout: exactly one root group, distinct mountpoints.
function buildSelection(cat: DiskLayouts, rows: Rows): { selection: DiskLayoutSelection } | { error: string } {
  const groups: StorageDiskGroup[] = cat.configs.map((c) => {
    const r = rows[c.disk_group_name];
    return { group: c.disk_group_name, config: r.config, file_system: r.format, mountpoint: r.mountpoint };
  });

  // Direct collapses to a single root group; all other disks stay unpartitioned.
  const direct = groups.find((g) => g.config === 'direct');
  if (direct) {
    const os = { ...direct, mountpoint: '/' };
    return {
      selection: {
        label: `${diskTypeOf(cat.configs, os.group)} direct/${os.file_system} → / (others unpartitioned)`,
        os,
        data: [],
      },
    };
  }

  const roots = groups.filter((g) => g.mountpoint === '/');
  if (roots.length !== 1) return { error: 'exactly one group must mount at / (the OS group)' };
  const mps = groups.map((g) => g.mountpoint);
  if (new Set(mps).size !== mps.length) return { error: 'each group needs a distinct mountpoint' };

  const os = roots[0];
  const data = groups.filter((g) => g !== os);
  const label = groups
    .map((g) => `${diskTypeOf(cat.configs, g.group)} ${g.config}/${g.file_system}→${g.mountpoint}`)
    .join(' · ');
  return { selection: { label, os, data } };
}

export function DiskLayoutPicker({
  initialNode,
  onClose,
  onRun,
}: {
  initialNode: number;
  onClose: () => void;
  onRun: (p: { nodeIndex: number; diskLayouts: DiskLayoutSelection[] }) => void;
}) {
  const [node, setNode] = useState(initialNode);
  const nodes = useFleetNodes();
  const layouts = tsr.getDiskLayouts.useQuery({
    queryKey: ['disk-layouts', node],
    queryData: { params: { nodeIndex: String(node) } },
    retry: false,
  });
  const cat = layouts.data?.status === 200 ? layouts.data.body : null;
  const err = errorMessage(layouts.error);
  const loading = layouts.isPending;
  const [rows, setRows] = useState<Rows>({});

  // seed the editable rows from a freshly loaded catalog (or clear while loading/errored).
  useEffect(() => {
    setRows(cat ? defaultRows(cat) : {});
  }, [cat]);

  const configs = cat?.configs ?? [];
  const singleGroup = configs.length === 1;
  const directGroup = configs.find((c) => rows[c.disk_group_name]?.config === 'direct')?.disk_group_name;

  const mountpointOptions = useMemo(() => {
    if (singleGroup) return ['/'];
    const seeded = Object.values(rows).map((r) => r.mountpoint);
    return Array.from(new Set([...STANDARD_MOUNTPOINTS, ...seeded])).filter(Boolean);
  }, [singleGroup, rows]);

  const setRow = (group: string, patch: Partial<Row>) => {
    setRows((rs) => {
      let resolved = patch;
      if (patch.mountpoint !== undefined) {
        const taken = new Set(
          Object.entries(rs)
            .filter(([k]) => k !== group)
            .map(([, v]) => v.mountpoint),
        );
        if (taken.has(patch.mountpoint)) {
          for (let i = 0; i < 1000; i++) {
            const candidate = `/data${i}`;
            if (!taken.has(candidate)) {
              resolved = { ...patch, mountpoint: candidate };
              break;
            }
          }
        }
      }
      return { ...rs, [group]: { ...rs[group], ...resolved } };
    });
  };

  // Backstop for paths that bypass setRow (HMR-preserved state, etc): de-dupe mountpoints.
  useEffect(() => {
    const order = cat?.configs.map((c) => c.disk_group_name) ?? Object.keys(rows);
    const seen = new Set<string>();
    const fixes: Record<string, string> = {};
    for (const g of order) {
      const r = rows[g];
      if (!r) continue;
      if (!seen.has(r.mountpoint)) {
        seen.add(r.mountpoint);
        continue;
      }
      for (let i = 0; i < 1000; i++) {
        const candidate = `/data${i}`;
        if (!seen.has(candidate)) {
          fixes[g] = candidate;
          seen.add(candidate);
          break;
        }
      }
    }
    if (Object.keys(fixes).length === 0) return;
    setRows((rs) => {
      const next = { ...rs };
      for (const [g, m] of Object.entries(fixes)) next[g] = { ...next[g], mountpoint: m };
      return next;
    });
  }, [rows, cat]);

  // Parent-owned so handleRun reads drafts without depending on blur timing.
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  // a node switch reseeds rows and clears drafts synchronously during render (before paint) so a
  // warm-cached new catalog never briefly renders with the previous node's rows and an enabled Run.
  const [prevNode, setPrevNode] = useState(node);
  if (node !== prevNode) {
    setPrevNode(node);
    setRows(cat ? defaultRows(cat) : {});
    setDrafts({});
  }

  const mergedRows = useMemo(() => {
    const merged: Record<string, Row> = { ...rows };
    for (const [group, draft] of Object.entries(drafts)) {
      const trimmed = draft.trim();
      if (trimmed && merged[group] && trimmed !== merged[group].mountpoint) {
        merged[group] = { ...merged[group], mountpoint: trimmed };
      }
    }
    return merged;
  }, [rows, drafts]);

  const currentSelection = useMemo(() => {
    // a warm cache can pair a non-null cat with rows not yet seeded for its groups (the seeding
    // effect runs post-paint), so guard against a partial rows map before buildSelection reads it.
    if (!cat || !cat.configs.every((c) => mergedRows[c.disk_group_name])) return null;
    const r = buildSelection(cat, mergedRows);
    return 'error' in r ? null : r.selection;
  }, [cat, mergedRows]);

  const handleRun = () => {
    if (!currentSelection) return;
    // Promote pending drafts to rows so subsequent interactions see them.
    let next = rows;
    let changed = false;
    for (const [group, draft] of Object.entries(drafts)) {
      const trimmed = draft.trim();
      if (trimmed && next[group] && trimmed !== next[group].mountpoint) {
        next = { ...next, [group]: { ...next[group], mountpoint: trimmed } };
        changed = true;
      }
    }
    if (changed) {
      setRows(next);
      setDrafts({});
    }
    onRun({ nodeIndex: node, diskLayouts: [currentSelection] });
  };

  return (
    <PickerModal
      title="Disk layout — configure layouts like provisioning"
      onClose={onClose}
      width="w-[640px]"
      footerNote={
        <span className="text-text-dim text-[11px]">
          Reprovisions between each layout, verifies on the booted OS, then end-rental.
        </span>
      }
      confirmLabel="Cycle + verify"
      onConfirm={handleRun}
      confirmDisabled={!currentSelection}
      // blur the focused custom-path input before reading rows so a typed-but-uncommitted draft
      // commits via its onBlur first.
      onConfirmMouseDown={() => {
        const active = document.activeElement;
        if (active instanceof HTMLElement) active.blur();
      }}
    >
      <div className="space-y-1">
        <label className="text-text-muted text-[11px] tracking-wide uppercase">Node</label>
        <NodeChips nodes={nodes} isSelected={(i) => node === i} onToggle={setNode} />
      </div>

      {loading && <div className="text-text-dim text-xs">loading storage layouts…</div>}
      {!loading && ((err && !cat) || (cat !== null && configs.length === 0)) && (
        <div className="border-status-warning/30 bg-status-warning/5 text-status-warning/90 rounded-md border p-2.5 text-[11px]">
          <span className="font-semibold">Disqualified from the disk-layout test</span> — no disk-layout data for this
          node
          {err ? `: ${err}` : ''}. Bring the stack up, then run <span className="font-mono">Discover</span> on the node
          (Fleet) to collect its disks, and retry.
        </div>
      )}

      {cat && !loading && configs.length > 0 && (
        <div className="space-y-3">
          <label className="text-text-muted text-[11px] tracking-wide uppercase">Configure a layout</label>
          {configs.map((c) => {
            const r = rows[c.disk_group_name];
            if (!r) return null;
            const isDirectRow = c.disk_group_name === directGroup;
            const dimmed = !!directGroup && !isDirectRow;
            const formats = c.file_systems.length ? c.file_systems : ['ext4'];
            return (
              <div
                key={c.disk_group_name}
                className={`border-border-dim space-y-2 rounded-md border p-2.5 ${dimmed ? 'pointer-events-none opacity-50' : ''}`}
              >
                <div className="flex items-baseline justify-between">
                  <span className="text-text-primary font-mono text-sm">{c.disk_type.toUpperCase()}</span>
                  <span className="text-text-dim font-mono text-[10px]">
                    {c.num_disks ?? c.disks.length} disk{(c.num_disks ?? c.disks.length) === 1 ? '' : 's'}
                    {c.size_per_disk ? ` · ${fmtSize(c.size_per_disk)} each` : ''}
                  </span>
                </div>
                {isDirectRow && (
                  <p className="text-status-warning/80 text-[10px]">
                    Direct partitions a single disk at / — all other groups stay unpartitioned.
                  </p>
                )}
                {dimmed && (
                  <p className="text-text-dim text-[10px] italic">Unpartitioned while another group is Direct.</p>
                )}

                <ChipRow
                  label="Layout"
                  value={r.config}
                  options={c.capabilities.map((cap) => ({ value: cap, label: CONFIG_LABELS[cap] ?? cap }))}
                  onPick={(v) => setRow(c.disk_group_name, { config: v })}
                />
                <ChipRow
                  label="Format"
                  value={r.format}
                  options={formats.map((f) => ({ value: f, label: f }))}
                  onPick={(v) => setRow(c.disk_group_name, { format: v })}
                />
                <ChipRow
                  label="Mount"
                  value={isDirectRow ? '/' : r.mountpoint}
                  disabled={isDirectRow}
                  options={mountpointOptions.map((m) => ({ value: m, label: m }))}
                  onPick={(v) => {
                    setRow(c.disk_group_name, { mountpoint: v });
                    // Picking a standard chip discards any pending custom draft
                    // so mergedRows doesn't keep preferring a stale typed value.
                    setDrafts((prev) => {
                      if (!(c.disk_group_name in prev)) return prev;
                      const next = { ...prev };
                      delete next[c.disk_group_name];
                      return next;
                    });
                  }}
                  custom={
                    singleGroup || isDirectRow
                      ? undefined
                      : {
                          value: r.mountpoint,
                          onChange: (v) => setRow(c.disk_group_name, { mountpoint: v }),
                          draft: drafts[c.disk_group_name] ?? '',
                          onDraftChange: (d) => setDrafts((prev) => ({ ...prev, [c.disk_group_name]: d })),
                        }
                  }
                />
              </div>
            );
          })}

          {currentSelection && (
            <div className="border-border-dim bg-text-dim/[0.03] text-text-muted truncate rounded-md border px-2.5 py-1.5 font-mono text-[11px]">
              {currentSelection.label}
            </div>
          )}
          {!currentSelection && (
            <div className="text-status-warning/70 text-[11px]">
              Configure exactly one group at <span className="font-mono">/</span> with distinct mountpoints to enable
              the run.
            </div>
          )}
        </div>
      )}
    </PickerModal>
  );
}

// `custom.draft` is parent-owned so handleRun reads pending drafts without blur-timing deps.
function ChipRow({
  label,
  value,
  options,
  onPick,
  disabled,
  custom,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onPick: (v: string) => void;
  disabled?: boolean;
  custom?: {
    value: string;
    onChange: (v: string) => void;
    draft: string;
    onDraftChange: (d: string) => void;
  };
}) {
  const known = options.some((o) => o.value === value);
  const draft = custom?.draft ?? '';
  const placeholderDraft = known ? '' : value;
  const shown = draft || placeholderDraft;

  const commit = () => {
    if (!custom) return;
    const trimmed = draft.trim();
    if (!trimmed || trimmed === value) return;
    custom.onChange(trimmed);
    custom.onDraftChange('');
  };

  return (
    <div className="flex items-center gap-2">
      <span className="text-text-dim w-12 shrink-0 text-[10px] tracking-wide uppercase">{label}</span>
      <div className="flex flex-wrap gap-1">
        {options.map((o) => (
          <button
            key={o.value}
            disabled={disabled}
            onClick={() => onPick(o.value)}
            className={`rounded border px-2 py-0.5 text-xs transition ${
              value === o.value
                ? 'border-status-online/50 bg-status-online/10 text-status-online'
                : 'border-border-dim text-text-muted hover:bg-hover-bg'
            } ${disabled ? 'cursor-not-allowed' : ''}`}
          >
            {o.label}
          </button>
        ))}
        {custom && (
          <input
            value={shown}
            onChange={(e) => custom.onDraftChange(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                commit();
                e.currentTarget.blur();
              }
            }}
            placeholder="custom /path"
            className="border-border-dim text-text-muted placeholder:text-text-label focus:border-accent/40 w-28 rounded border bg-transparent px-2 py-0.5 text-xs outline-none"
          />
        )}
      </div>
    </div>
  );
}
