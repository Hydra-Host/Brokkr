import { Pill } from '@/components/ui/pill';
import {
  PREFIX_FINDING_CODES,
  type AppLink,
  type BmcProbe,
  type BootCode,
  type Machine,
  type VerifyFinding,
} from '@/contract';
import { BootTrailLine } from '@/features/fleet/boot-trail-line';
import { bmcPill, hubPill } from '@/features/fleet/machine-pills';

export type BakeState = 'ok' | 'missing' | 'stale';

export type NextStep = {
  id: 'bake' | 'prefix-dhcp' | 'hub-device' | 'bmc' | 'boot';
  label: string;
  state: 'done' | 'todo' | 'unknown';
  href: string | null;
};

export type DeriveInput = {
  machine: Machine | undefined;
  findings: VerifyFinding[];
  bake: BakeState;
  hubWeb: string | null;
  pxeMac: string;
  /** the uplink NIC's address with its mask; null while no NIC is picked or it holds no IPv4 */
  uplink: string | null;
  onConfigure: (() => void) | null;
};

// the codes come from the contract, the one module the lab's uplink checks and this card both import
export const PREFIX_CODES = new Set<string>(PREFIX_FINDING_CODES);
export const IDENTITY_CODE: BootCode = 'PXE-106';

const isIdentitySplit = (findings: VerifyFinding[]) => findings.some((f) => f.code === IDENTITY_CODE);

const BAKE_LABEL: Record<BakeState, string> = {
  ok: 'iPXE is baked for this uplink',
  missing: 'Bake iPXE for this uplink (Build → iPXE)',
  stale: 'Re-bake iPXE for this uplink — the baked chain URL is out of sync (Build → iPXE)',
};

const BMC_LABEL: Record<BmcProbe['reachable'], string> = {
  ok: 'BMC answers Redfish with the saved credential',
  'auth-failed': 'BMC rejected the saved credential — fix the BMC user or password',
  unreachable: 'BMC did not answer — check the BMC address, cabling and this host route',
  unconfigured: 'Save a BMC address, user and password',
};

export function deriveNextSteps(input: DeriveInput): NextStep[] {
  const { machine, findings, bake, hubWeb, pxeMac, uplink } = input;
  const prefix = findings.filter((f) => f.code != null && PREFIX_CODES.has(f.code));
  const ref = prefix.find((f) => f.ref != null)?.ref ?? null;
  const identitySplit = isIdentitySplit(findings);
  const unknown = machine === undefined;
  const bmc = machine?.bmc ?? null;
  const prefixState: NextStep['state'] = unknown ? 'unknown' : prefix.length === 0 ? 'done' : 'todo';
  const prefixHref =
    hubWeb === null
      ? null
      : ref !== null
        ? `${hubWeb}/ipam/prefixes/${ref}/edit`
        : prefixState === 'todo'
          ? `${hubWeb}/ipam/prefixes`
          : null;
  return [
    { id: 'bake', label: BAKE_LABEL[bake], state: bake === 'ok' ? 'done' : 'todo', href: null },
    {
      id: 'prefix-dhcp',
      label: `Set the uplink prefix containing ${uplink ?? 'the uplink address'} to DHCP mode PROXY, iPXE target SNPONLY, and allow ${pxeMac} in the hub`,
      state: prefixState,
      href: prefixHref,
    },
    {
      id: 'hub-device',
      label: 'One hub device owns both the PXE MAC and the BMC address',
      state: unknown ? 'unknown' : identitySplit ? 'todo' : 'done',
      href: null,
    },
    {
      id: 'bmc',
      label: BMC_LABEL[bmc?.reachable ?? 'unconfigured'],
      state: bmc?.reachable === 'ok' ? 'done' : unknown ? 'unknown' : 'todo',
      href: null,
    },
    {
      id: 'boot',
      label: 'Power on with a network boot and watch the Fleet page findings',
      state: 'todo',
      href: null,
    },
  ];
}

export function groupFindingsByNode(findings: VerifyFinding[]): Map<string, VerifyFinding[]> {
  const byNode = new Map<string, VerifyFinding[]>();
  for (const f of findings) {
    if (f.node === null) continue;
    byNode.set(f.node, [...(byNode.get(f.node) ?? []), f]);
  }
  return byNode;
}

// same host rule as the sidebar's app links: a loopback-only UI targets localhost, the rest the browser's host
export function hubWebUrl(links: AppLink[]): string | null {
  const hub = links.find((l) => l.id === 'hub-web');
  if (!hub) return null;
  const host = hub.loopback ? 'localhost' : window.location.hostname;
  return `http://${host}:${hub.port}`;
}

const STEP_GLYPH: Record<NextStep['state'], string> = { done: '✓', todo: '○', unknown: '?' };
const STEP_TONE: Record<NextStep['state'], string> = {
  done: 'text-status-online/90',
  todo: 'text-status-warning/90',
  unknown: 'text-text-muted',
};

const POWER_TONE: Record<Machine['power'], string> = {
  on: 'text-status-online/90',
  off: 'text-status-offline/90',
  unknown: 'text-text-muted',
};

function StatusStrip({ machine, identitySplit }: { machine: Machine; identitySplit: boolean }) {
  const bmc = bmcPill(machine.bmc);
  const hub = hubPill(machine.deviceId, identitySplit);
  return (
    <div className="flex flex-wrap items-center gap-3 text-[11px]">
      <Pill label="power" value={machine.power} tone={POWER_TONE[machine.power]} />
      <Pill label="BMC" value={bmc.value} tone={bmc.tone} />
      <Pill label="hub" value={hub.value} tone={hub.tone} />
    </div>
  );
}

export function BareMetalStatus({ dirty, ...input }: DeriveInput & { dirty: boolean }) {
  // the probe reflects the saved config, so a draft row has nothing to report yet
  if (dirty) {
    return <div className="border-border-dim text-text-muted border-t pt-2 text-[11px]">save to probe</div>;
  }
  const { machine, findings, onConfigure } = input;
  const steps = deriveNextSteps(input);
  const identitySplit = isIdentitySplit(findings);
  return (
    <div className="border-border-dim space-y-2 border-t pt-2">
      {machine === undefined ? (
        <div className="text-text-muted text-[11px]">not probed yet</div>
      ) : (
        <StatusStrip machine={machine} identitySplit={identitySplit} />
      )}
      <ol className="space-y-0.5 text-[11px]">
        {steps.map((step) => (
          <li key={step.id} className="flex items-start gap-1.5">
            <span className={`w-3 shrink-0 font-mono ${STEP_TONE[step.state]}`} aria-label={step.state}>
              {STEP_GLYPH[step.state]}
            </span>
            {step.href ? (
              <a
                href={step.href}
                target="_blank"
                rel="noreferrer"
                className="text-accent/80 hover:text-accent underline"
              >
                {step.label}
              </a>
            ) : (
              <span className={step.state === 'done' ? 'text-text-muted' : 'text-text-primary'}>{step.label}</span>
            )}
            {step.id === 'prefix-dhcp' && step.state === 'todo' && onConfigure && (
              <button
                type="button"
                onClick={onConfigure}
                className="border-accent/40 text-accent/90 hover:bg-accent/10 shrink-0 rounded border px-1.5 py-0.5 text-[10px]"
              >
                Configure in hub
              </button>
            )}
          </li>
        ))}
      </ol>
      {machine !== undefined && <BootTrailLine name={machine.name} />}
    </div>
  );
}
