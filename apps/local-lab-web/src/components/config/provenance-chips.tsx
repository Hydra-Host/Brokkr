import type { FieldProvenance } from '@/lib/config-tree';

/** Same badge shape the process-env pane uses, so a chip means the same thing on both surfaces. */
function Badge({ label, cls, title }: { label: string; cls: string; title: string }) {
  return (
    <span title={title} className={`shrink-0 rounded px-1 py-0.5 tracking-wide uppercase ${cls}`}>
      {label}
    </span>
  );
}

const SOURCE_CLASS = {
  pin: 'text-status-warning',
  file: 'text-accent/80',
  default: 'text-text-dim',
} as const;

/** The chips say where a value came from; the gutter says whether it moved. Separating them is what
 *  lets a row report danger and changed at once. */
export function ProvenanceChips({ prov }: { prov: FieldProvenance }) {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[10px]">
      {prov.secret && (
        <Badge
          label="secret"
          cls="bg-status-offline/15 text-status-offline"
          title="declared sensitive — the real value never reaches this browser"
        />
      )}
      {prov.locked && (
        <Badge
          label="pinned"
          cls="bg-status-warning/15 text-status-warning"
          title={prov.lockReason ?? 'held by an environment variable'}
        />
      )}
      <span className={`font-mono normal-case ${SOURCE_CLASS[prov.source.kind]}`} title={prov.source.title}>
        {prov.source.label}
      </span>
    </span>
  );
}
