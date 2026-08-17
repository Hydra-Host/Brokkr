import { useState } from 'react';

import { NodeChips, useFleetNodes } from '@/components/ui/node-chips';
import { PickerModal } from '@/components/ui/picker-modal';
import { tsr } from '@/lib/api';

// Markers must match the cloud-init test's per-section checks; the bridge doesn't merge seeded keys into customer-defined users, so the UI injects the pubkey.
const STATIC_MODULES: { key: string; label: string; snippet: string }[] = [
  {
    key: 'write_files',
    label: 'write_files',
    snippet: 'write_files:\n  - path: /etc/brokkr-e2e.txt\n    content: "hydra-host cloud-init e2e"',
  },
  { key: 'packages', label: 'packages', snippet: 'packages:\n  - sl' },
  {
    key: 'runcmd',
    label: 'runcmd',
    snippet: 'runcmd:\n  - [ sh, -c, "echo cloud-init-ran > /var/log/brokkr-e2e.log" ]',
  },
];

// Name must match test_cloud_init.py's E2E_USER ("brokkre2e"); its sudo checks require NOPASSWD.
function usersSnippet(pubkey: string | null): string {
  const keyLine = pubkey ? `\n    ssh_authorized_keys:\n      - ${pubkey}` : '';
  return `users:\n  - name: brokkre2e\n    sudo: ALL=(ALL) NOPASSWD:ALL\n    lock_passwd: true${keyLine}`;
}

export function CloudInitPicker({
  initialNode,
  onClose,
  onRun,
}: {
  initialNode: number;
  onClose: () => void;
  onRun: (p: { nodeIndex: number; cloudInit: string }) => void;
}) {
  const nodes = useFleetNodes();
  const devPubkey = tsr.getDevPubkey.useQuery({ queryKey: ['dev-pubkey'] });
  const pubkey = devPubkey.data?.status === 200 ? devPubkey.data.body.pubkey : null;
  const [node, setNode] = useState(initialNode);
  const [on, setOn] = useState<Record<string, boolean>>({
    write_files: true,
    users: true,
    packages: false,
    runcmd: true,
  });

  const modules: { key: string; label: string; snippet: string }[] = [
    STATIC_MODULES[0]!,
    { key: 'users', label: 'users', snippet: usersSnippet(pubkey) },
    ...STATIC_MODULES.slice(1),
  ];
  const selected = modules.filter((m) => on[m.key]);
  const yaml = ['#cloud-config', ...selected.map((m) => m.snippet)].join('\n');
  const pubkeyLoading = devPubkey.isLoading;
  const pubkeyError = devPubkey.isError;
  const usersNeedKey = !!on.users && !pubkey;

  return (
    <PickerModal
      title="Cloud-init — compose user-data"
      onClose={onClose}
      width="w-[600px]"
      footerNote={
        <span className="text-text-dim text-[11px]">
          {selected.length} module(s) — the test verifies each on the booted OS.
        </span>
      }
      confirmLabel="Provision + verify"
      onConfirm={() => onRun({ nodeIndex: node, cloudInit: yaml })}
      confirmDisabled={selected.length === 0 || usersNeedKey}
    >
      <div className="space-y-1">
        <label className="text-text-muted text-[11px] tracking-wide uppercase">Node</label>
        <NodeChips nodes={nodes} isSelected={(i) => node === i} onToggle={setNode} />
      </div>

      <div className="space-y-1.5">
        <label className="text-text-muted text-[11px] tracking-wide uppercase">Modules</label>
        <div className="flex flex-wrap gap-2">
          {modules.map((m) => (
            <label key={m.key} className="text-text-muted flex cursor-pointer items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={!!on[m.key]}
                onChange={() => setOn((s) => ({ ...s, [m.key]: !s[m.key] }))}
              />
              {m.label}
            </label>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="text-text-muted text-[11px] tracking-wide uppercase">Generated user-data (live)</label>
        <pre className="border-border-dim bg-bg-secondary text-text-primary max-h-56 overflow-auto rounded-lg border p-3 font-mono text-xs whitespace-pre">
          {yaml}
        </pre>
      </div>

      {usersNeedKey && (
        <p className="text-status-warning/80 text-[11px]">
          {pubkeyLoading
            ? 'users module is on but the dev pubkey is still loading — wait for it or disable users.'
            : pubkeyError
              ? 'users module is on but the dev pubkey fetch failed — is the lab API running?'
              : 'users module is on but no .pub file was found on disk — the SSH e2e gate would fail. Disable users or add a pubkey file.'}
        </p>
      )}
    </PickerModal>
  );
}
