import { useState } from 'react';

import { NodeChips, useFleetNodes } from '@/components/ui/node-chips';
import { PickerModal } from '@/components/ui/picker-modal';

const IPXE_OPTIONS: { url: string; label: string; note: string }[] = [
  {
    url: 'https://boot.netboot.xyz/menu.ipxe',
    label: 'netboot.xyz menu — chainload only (manual)',
    note: 'Passes as soon as the VM chainloads the netboot.xyz menu. The VM is left sitting at the menu — click through / kill it yourself. No full OS install, no deprovision.',
  },
];

export function IpxePicker({
  initialNode,
  onClose,
  onRun,
}: {
  initialNode: number;
  onClose: () => void;
  onRun: (p: { nodeIndex: number; ipxeUrl: string }) => void;
}) {
  const nodes = useFleetNodes();
  const [node, setNode] = useState(initialNode);
  const [ipxeUrl, setIpxeUrl] = useState(IPXE_OPTIONS[0].url);
  const [customUrl, setCustomUrl] = useState('');
  const effectiveUrl = customUrl.trim() || ipxeUrl;

  return (
    <PickerModal
      title="Custom iPXE — choose boot URL"
      onClose={onClose}
      width="w-[560px]"
      footerNote={
        <span className="text-text-dim text-[11px]">
          netboot.xyz chainloads — then it’s on you to click through / kill it.
        </span>
      }
      confirmLabel="Provision + verify"
      onConfirm={() => onRun({ nodeIndex: node, ipxeUrl: effectiveUrl })}
    >
      <div className="space-y-1">
        <label className="text-text-muted text-[11px] tracking-wide uppercase">Node</label>
        <NodeChips nodes={nodes} isSelected={(i) => node === i} onToggle={setNode} />
      </div>

      <div className="space-y-1.5">
        <label className="text-text-muted text-[11px] tracking-wide uppercase">iPXE URL</label>
        <div className="space-y-1.5">
          {IPXE_OPTIONS.map((o) => (
            <label
              key={o.url}
              className={`flex cursor-pointer items-start gap-2.5 rounded-md border p-2.5 transition ${
                ipxeUrl === o.url ? 'border-accent/50 bg-accent/10' : 'border-border-dim hover:bg-hover-bg'
              }`}
            >
              <input
                type="radio"
                name="ipxe-url"
                checked={ipxeUrl === o.url}
                onChange={() => setIpxeUrl(o.url)}
                className="mt-0.5"
              />
              <span className="space-y-0.5">
                <span className="text-text-primary block text-sm">{o.label}</span>
                <span className="text-text-dim block text-[11px]">{o.note}</span>
                <span className="text-text-dim block font-mono text-[10px]">{o.url}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-text-muted text-[11px] tracking-wide uppercase">
          Custom trusted URL (full provision)
        </label>
        <input
          type="url"
          value={customUrl}
          onChange={(e) => setCustomUrl(e.target.value)}
          placeholder="https://boot.<your-domain>/rescue.ipxe"
          className="border-border-dim bg-bg-primary text-text-primary placeholder:text-text-label focus:border-accent/50 w-full rounded-md border px-2 py-1.5 font-mono text-xs focus:outline-none"
        />
        <span className="text-text-dim block text-[11px]">
          Must pass the hub’s TRUSTED_IPXE_DOMAINS check (HTTPS + an allowlisted domain). When set, this overrides the
          preset above and drives the full provision + verify.
        </span>
      </div>
    </PickerModal>
  );
}
