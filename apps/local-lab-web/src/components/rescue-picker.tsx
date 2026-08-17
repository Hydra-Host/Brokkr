import { useState } from 'react';

import { NodeChips, useFleetNodes } from '@/components/ui/node-chips';
import { PickerModal } from '@/components/ui/picker-modal';

// Slugs must exist in the hub's Layer catalog (seeded by sql-seed/40-os-catalog.py); both classify as a live OS, so the test assertion is the same.
const RESCUE_OPTIONS: { slug: string; label: string; note: string }[] = [
  { slug: 'ubuntu-rescue-os', label: 'Ubuntu Rescue OS', note: 'Default — Ubuntu-based live recovery environment.' },
  {
    slug: 'brokkr-discovery',
    label: 'Brokkr Live (discovery)',
    note: 'The brokkr-live discovery image used for hardware collection.',
  },
];

export function RescuePicker({
  initialNode,
  onClose,
  onRun,
}: {
  initialNode: number;
  onClose: () => void;
  onRun: (p: { nodeIndex: number; rescueOs: string }) => void;
}) {
  const nodes = useFleetNodes();
  const [node, setNode] = useState(initialNode);
  const [rescueOs, setRescueOs] = useState(RESCUE_OPTIONS[0].slug);

  return (
    <PickerModal
      title="Rescue boot — choose rescue OS"
      onClose={onClose}
      width="w-[560px]"
      footerNote={
        <span className="text-text-dim text-[11px]">Admin-only choice — the customer flow is always single-OS.</span>
      }
      confirmLabel="Rescue + verify"
      onConfirm={() => onRun({ nodeIndex: node, rescueOs })}
    >
      <div className="space-y-1">
        <label className="text-text-muted text-[11px] tracking-wide uppercase">Node</label>
        <NodeChips nodes={nodes} isSelected={(i) => node === i} onToggle={setNode} />
      </div>

      <div className="space-y-1.5">
        <label className="text-text-muted text-[11px] tracking-wide uppercase">Rescue OS</label>
        <div className="space-y-1.5">
          {RESCUE_OPTIONS.map((o) => (
            <label
              key={o.slug}
              className={`flex cursor-pointer items-start gap-2.5 rounded-md border p-2.5 transition ${
                rescueOs === o.slug ? 'border-accent/50 bg-accent/10' : 'border-border-dim hover:bg-hover-bg'
              }`}
            >
              <input
                type="radio"
                name="rescue-os"
                checked={rescueOs === o.slug}
                onChange={() => setRescueOs(o.slug)}
                className="mt-0.5"
              />
              <span className="space-y-0.5">
                <span className="text-text-primary block text-sm">{o.label}</span>
                <span className="text-text-dim block text-[11px]">{o.note}</span>
                <span className="text-text-dim block font-mono text-[10px]">{o.slug}</span>
              </span>
            </label>
          ))}
        </div>
      </div>
    </PickerModal>
  );
}
