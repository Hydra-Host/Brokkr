import type { VerifyFinding, VerifyFindingKind } from '@/contract';
import { groupFindingsByNode } from '@/features/config/baremetal-status';

export const VERIFY_CARD_ID = 'fleet-verify';

const REMEDY_SUFFIX: Record<VerifyFindingKind, string> = {
  'no-manifest': '',
  'domain-undefined': ' (needs apply)',
  'domain-not-running': '',
  'ipmi-sim-down': '',
  'sushy-down': '',
  'lo-alias-missing': '',
  'vmnet-socket-missing': '',
  'bootptab-missing': '',
  'orphan-domain': ' (needs apply)',
  'bmc-unreachable': ' (check cabling and credentials)',
  'bmc-auth-failed': ' (check credentials)',
  'no-hub-device': ' (re-seed the hub device)',
  'identity-split': ' (re-seed the hub device)',
  'boot-readiness': '',
};

function FindingLine({ f }: { f: VerifyFinding }) {
  const showCode = f.code != null && !f.detail.startsWith(f.code);
  return (
    <li className="text-text-dim text-[11px]">
      {showCode && <span className="text-text-label mr-1 font-mono">{f.code}</span>}
      {f.detail}
      {REMEDY_SUFFIX[f.kind] && <span className="text-status-warning/70">{REMEDY_SUFFIX[f.kind]}</span>}
    </li>
  );
}

function FindingGroup({ label, findings }: { label: string; findings: VerifyFinding[] }) {
  return (
    <div>
      <div className="text-text-label font-mono text-[11px]">{label}</div>
      <ul className="space-y-1">
        {findings.map((f, i) => (
          <FindingLine key={`${f.kind}-${i}`} f={f} />
        ))}
      </ul>
    </div>
  );
}

/** Every verify + boot-readiness finding behind one collapsed disclosure: fleet-level first, then per node. */
export function VerifyFindingsCard({
  findings,
  open,
  onOpenChange,
  anyHealable,
  healing,
  onHeal,
}: {
  findings: VerifyFinding[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anyHealable: boolean;
  healing: boolean;
  onHeal: () => void;
}) {
  const fleetLevel = findings.filter((f) => f.node === null);
  const byNode = groupFindingsByNode(findings);
  const total = findings.length;
  return (
    <div
      id={VERIFY_CARD_ID}
      className="border-status-warning/30 bg-status-warning/5 rounded-md border px-3 py-2 text-sm"
    >
      <div className="flex items-start justify-between gap-2">
        <details open={open} onToggle={(e) => onOpenChange(e.currentTarget.open)} className="min-w-0 flex-1">
          <summary className="text-status-warning/90 cursor-pointer list-none text-xs font-medium">
            {open ? '▾' : '▸'} Fleet verify: {total} finding{total === 1 ? '' : 's'}
          </summary>
          <div className="mt-2 space-y-2">
            {fleetLevel.length > 0 && <FindingGroup label="fleet" findings={fleetLevel} />}
            {[...byNode].map(([node, list]) => (
              <FindingGroup key={node} label={node} findings={list} />
            ))}
          </div>
        </details>
        {/* a sibling of the disclosure, not a child, so heal stays reachable while the card is collapsed */}
        {anyHealable && (
          <button
            type="button"
            onClick={onHeal}
            disabled={healing}
            className="border-accent/30 text-accent hover:bg-accent/10 rounded border px-2 py-1 text-[11px] disabled:opacity-50"
          >
            {healing ? 'healing…' : 'heal'}
          </button>
        )}
      </div>
    </div>
  );
}
