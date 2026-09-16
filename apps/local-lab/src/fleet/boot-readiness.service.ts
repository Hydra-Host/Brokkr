import { Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { z } from 'zod';

import { PrefixDhcpConfigSchema } from '@repo/api-client';
import {
  BootReadinessReportSchema,
  type BootTrail,
  type FleetPlanes,
  type FleetVerifyReport,
  type NodeKind,
  type VerifyFinding,
} from '@repo/local-lab-contract';
import { BOOT_CODES, getErrorMessage, type BootCode } from '@repo/utils';
import { DiscoveryInventorySchema } from '../common/discovery-inventory';
import { hubApiFetch, hubApiSignIn } from '../common/hub-client';
import { HOSTS, URLS } from '../ports';
import { OverlayStoreService } from '../services/overlay-store';
import { UPLINK_PREFIX_OP_LABEL } from '../stack/stack-ops';
import { BootTrailReader } from './boot-trail.reader';
import { FleetPowerService } from './fleet-power.service';
import type { RosterNode } from './fleet-roster';
import {
  bootReadinessPath,
  containingPrefix,
  dhcpConfigPath,
  HubPrefixListSchema,
  networkCidr,
  PREFIXES_PATH,
  type HubPrefix,
} from './hub-prefix';
import { simNetworkCidrs } from './sim-network';

/** The lab's semantic names for the shared registry's codes; every severity is looked up, never restated. */
export const LAB_BOOT_CODES = {
  unevaluated: 'PXE-107',
  noSubnet: 'PXE-102',
  refused: 'PXE-110',
  silent: 'PXE-111',
  authoritative: 'PXE-112',
  noPeer: 'PXE-04',
  noFullImage: 'PXE-113',
} satisfies Record<
  'unevaluated' | 'noSubnet' | 'refused' | 'silent' | 'authoritative' | 'noPeer' | 'noFullImage',
  BootCode
>;

/** A simulated VM network-boots on the bridge data-plane subnet, which is the only prefix role a VIP may bind. */
const BOOTABLE_PREFIX_ROLE = 'PRIMARY';

const HubDhcpConfigSchema = PrefixDhcpConfigSchema.pick({ dhcpMode: true, dhcpProxyPeerAuthoritative: true });

const HubPrefixReadinessSchema = z.object({
  findings: z.array(
    z.object({ code: z.string(), severity: z.enum(['error', 'warn', 'info']), message: z.string().min(1) }),
  ),
});

/** A real machine boots this flavor; the bridge's inventory route names it per served tree. */
const FULL_FLAVOR = 'full';

export interface LabBridgeTarget {
  proc: string;
  port: number;
}

export interface BootReadinessSources {
  planes: FleetPlanes;
  roster: RosterNode[];
  bridges: LabBridgeTarget[];
  /** The bare-metal uplink NIC as the overlay resolves it; null while the plane is off or the NIC has no IPv4. */
  uplink: ReturnType<OverlayStoreService['bmUplink']>;
  /** First declared zone — where a missing uplink prefix is told to be created. */
  zoneLabel: string | null;
  /** The simulator's own data and BMC networks; a hub prefix equal to one of them cannot be the uplink's. */
  simCidrs: string[];
  /** Architecture per bare-metal node name, the fleet default already applied; a node absent here has none. */
  bmArch: Record<string, string>;
}

export interface HubReadinessSession {
  get: (path: string) => Promise<{ code: number; body: unknown }>;
}

/** Every dial-out is a seam: the composition is exercised without a live bridge, hub or redis. */
export interface BootReadinessTransport {
  /** Rejects when the bridge is unreachable or answers non-2xx. */
  bridge: (target: LabBridgeTarget) => Promise<unknown>;
  /** Rejects when the hub is unreachable or the sign-in fails. */
  hub: () => Promise<HubReadinessSession>;
  /** Never rejects: a bridge redis the lab cannot read comes back as `readError`. */
  trail: (mac: string) => Promise<BootTrail>;
  /** Rejects when the bridge is unreachable or answers non-2xx. */
  inventory: (target: LabBridgeTarget) => Promise<unknown>;
}

type PxeNode = RosterNode & { pxeMac: string };

// a VM boots off the simulator's own bootptab, so only a machine with a PXE MAC has a hub prefix or a bridge trail to check
const hasPxeMac = (n: RosterNode): n is PxeNode => n.pxeMac !== null && n.pxeMac.trim() !== '';

// the card renders detail alone, so the code and severity lead it; `code` and `ref` are for a UI that links
const finding = (
  node: string | null,
  code: string,
  severity: string,
  text: string,
  ref: string | null = null,
): VerifyFinding => ({
  node,
  kind: 'boot-readiness',
  healable: false,
  detail: `${code} (${severity}): ${text}`,
  code,
  ref,
});

const labFinding = (node: string | null, code: BootCode, text: string): VerifyFinding =>
  finding(node, code, BOOT_CODES[code].severity, text);

const unevaluated = (node: string | null, text: string): VerifyFinding =>
  labFinding(node, LAB_BOOT_CODES.unevaluated, text);

function readinessPath(prefixId: string, node: RosterNode, mac: string): string {
  return bootReadinessPath(prefixId, { mac, bmcAddress: node.bmcIp });
}

async function bridgeFindings(target: LabBridgeTarget, transport: BootReadinessTransport): Promise<VerifyFinding[]> {
  let report: unknown;
  try {
    report = await transport.bridge(target);
  } catch (error) {
    return [unevaluated(null, `${target.proc} readiness could not be read (${getErrorMessage(error)}).`)];
  }
  const parsed = BootReadinessReportSchema.safeParse(report);
  if (!parsed.success) return [unevaluated(null, `${target.proc} returned a readiness payload the lab cannot read.`)];
  return parsed.data.findings.map((f) =>
    finding(
      null,
      f.code,
      f.severity,
      `${target.proc} reports this check did not pass. Its readiness route serves codes only; the bridge log carries the remedy.`,
    ),
  );
}

type HubAnswer = { code: number; body: unknown } | { error: string };

// a throw here would leave the route answering 500; the contract says an unreachable hub is PXE-107
async function hubGet(session: HubReadinessSession, path: string): Promise<HubAnswer> {
  try {
    return await session.get(path);
  } catch (error) {
    return { error: getErrorMessage(error) };
  }
}

interface HubReadiness {
  findings: VerifyFinding[];
  checkedNodes: ReadonlySet<string>;
}

const NO_NODES: ReadonlySet<string> = new Set();
const NO_READINESS: HubReadiness = { findings: [], checkedNodes: NO_NODES };

/** `checkedNodes` holds the nodes the hub actually answered for, so a fleet-wide failure cannot leave
 *  unchecked nodes counting as healthy. */
async function perNodeReadiness(
  session: HubReadinessSession,
  nodes: PxeNode[],
  prefixIds: string[],
): Promise<HubReadiness> {
  const findings: VerifyFinding[] = [];
  for (const node of nodes) {
    const mac = node.pxeMac.toLowerCase();
    for (const prefixId of prefixIds) {
      const path = readinessPath(prefixId, node, mac);
      const answer = await hubGet(session, path);
      if ('error' in answer) {
        findings.push(unevaluated(node.name, `Hub readiness for ${node.name} could not be read (${answer.error}).`));
        continue;
      }
      const parsed = answer.code === 200 ? HubPrefixReadinessSchema.safeParse(answer.body) : null;
      if (!parsed?.success) {
        findings.push(unevaluated(node.name, `Hub readiness for ${node.name} returned ${answer.code}.`));
        continue;
      }
      for (const f of parsed.data.findings) findings.push(finding(node.name, f.code, f.severity, f.message, prefixId));
    }
  }
  return { findings, checkedNodes: new Set(nodes.map((n) => n.name)) };
}

type KindReadiness = (
  session: HubReadinessSession,
  nodes: PxeNode[],
  prefixes: HubPrefix[],
  sources: Pick<BootReadinessSources, 'uplink' | 'zoneLabel' | 'simCidrs'>,
) => Promise<HubReadiness>;

const primaryFindings: KindReadiness = (session, nodes, prefixes) => {
  const bootable = prefixes.filter((p) => p.role === BOOTABLE_PREFIX_ROLE).map((p) => p.id);
  if (bootable.length === 0)
    return Promise.resolve({
      findings: [
        unevaluated(null, `The hub holds no ${BOOTABLE_PREFIX_ROLE}-role prefix, so no machine has a boot segment.`),
      ],
      checkedNodes: NO_NODES,
    });
  return perNodeReadiness(session, nodes, bootable);
};

// a real machine boots off the LAN the uplink NIC sits on, so the prefix that contains that address is the one
// the spoke binds its proxy to — the sim PRIMARY prefix is a different segment
const uplinkFindings: KindReadiness = async (session, nodes, prefixes, { uplink, zoneLabel, simCidrs }) => {
  const each = (code: BootCode, text: string, ref: string | null = null): VerifyFinding[] =>
    nodes.map((n) => finding(n.name, code, BOOT_CODES[code].severity, text, ref));
  if (uplink === null)
    return {
      findings: each(
        LAB_BOOT_CODES.unevaluated,
        'The bare-metal uplink NIC has no IPv4 address, so no hub prefix can be matched against it.',
      ),
      checkedNodes: NO_NODES,
    };
  const hit = containingPrefix(prefixes, uplink.ip);
  const zone = zoneLabel ?? 'the first declared zone';
  if (hit === null) {
    const network = uplink.cidr === null ? null : networkCidr(uplink.cidr);
    return {
      findings: each(
        LAB_BOOT_CODES.noSubnet,
        `No hub prefix contains the uplink IP ${uplink.ip} (${uplink.iface}). Create ${network ?? 'its network'} in zone ${zone} under IPAM → Prefixes, or run "${UPLINK_PREFIX_OP_LABEL}".`,
      ),
      checkedNodes: NO_NODES,
    };
  }

  if (simCidrs.some((cidr) => (networkCidr(cidr) ?? cidr) === (networkCidr(hit.prefix) ?? hit.prefix)))
    return {
      findings: each(
        LAB_BOOT_CODES.noSubnet,
        `The hub prefix ${hit.prefix} containing the uplink IP ${uplink.ip} is the simulator's own network, so ${uplink.iface} is not on a real LAN. Pick an uplink NIC on the LAN the machines share.`,
        hit.id,
      ),
      checkedNodes: NO_NODES,
    };

  const lab: VerifyFinding[] = [];
  if (hit.zoneId == null)
    lab.push(
      ...each(
        LAB_BOOT_CODES.noSubnet,
        `The hub prefix ${hit.prefix} contains the uplink IP but belongs to no zone, so no bridge serves it. Assign it to zone ${zone} under IPAM → Prefixes, or run "${UPLINK_PREFIX_OP_LABEL}".`,
        hit.id,
      ),
    );
  const config = await hubGet(session, dhcpConfigPath(hit.id));
  const parsed = 'error' in config ? null : config.code === 200 ? HubDhcpConfigSchema.safeParse(config.body) : null;
  if (!parsed?.success)
    lab.push(
      ...each(
        LAB_BOOT_CODES.unevaluated,
        `The DHCP config of hub prefix ${hit.prefix} could not be read (${'error' in config ? config.error : config.code}).`,
        hit.id,
      ),
    );
  else if (parsed.data.dhcpMode === 'AUTHORITATIVE')
    lab.push(
      ...each(
        LAB_BOOT_CODES.authoritative,
        `The hub prefix ${hit.prefix} containing the uplink is AUTHORITATIVE on a LAN that already has a DHCP server. Set its DHCP mode to PROXY and tick the external authoritative DHCP server box, or run "${UPLINK_PREFIX_OP_LABEL}".`,
        hit.id,
      ),
    );
  else if (parsed.data.dhcpMode === 'PROXY' && !parsed.data.dhcpProxyPeerAuthoritative)
    lab.push(
      ...each(
        LAB_BOOT_CODES.noPeer,
        `The hub prefix ${hit.prefix} is PROXY with no declared authoritative peer. Tick the external authoritative DHCP server box, or run "${UPLINK_PREFIX_OP_LABEL}".`,
        hit.id,
      ),
    );
  const hub = await perNodeReadiness(session, nodes, [hit.id]);
  return { findings: [...lab, ...hub.findings], checkedNodes: hub.checkedNodes };
};

// the sim serves its VMs the light image, so only a real machine needs the full tree, and only for its own arch
async function fullImageFindings(
  nodes: RosterNode[],
  { bridges, bmArch }: Pick<BootReadinessSources, 'bridges' | 'bmArch'>,
  transport: BootReadinessTransport,
): Promise<VerifyFinding[]> {
  if (nodes.length === 0) return [];
  const served = new Set<string>();
  const errors: string[] = [];
  await Promise.all(
    bridges.map(async (target) => {
      let payload: unknown;
      try {
        payload = await transport.inventory(target);
      } catch (error) {
        errors.push(`${target.proc}: ${getErrorMessage(error)}`);
        return;
      }
      const parsed = DiscoveryInventorySchema.safeParse(payload);
      if (!parsed.success) {
        errors.push(`${target.proc}: returned an inventory the lab cannot read`);
        return;
      }
      for (const entry of parsed.data.architectures)
        if (entry.flavor === FULL_FLAVOR && entry.files.length > 0 && entry.files.every((f) => f.present))
          served.add(entry.arch);
    }),
  );
  if (errors.length === bridges.length)
    return nodes.map((n) =>
      unevaluated(
        n.name,
        `No bridge discovery inventory could be read (${errors.join('; ') || 'no bridge declared'}), so the full-image check did not run.`,
      ),
    );
  return nodes.flatMap((n) => {
    const arch = bmArch[n.name];
    if (arch === undefined)
      return [unevaluated(n.name, `${n.name} has no configured architecture, so no discovery image can be matched.`)];
    if (served.has(arch)) return [];
    return [
      labFinding(
        n.name,
        LAB_BOOT_CODES.noFullImage,
        `No bridge serves a complete full-flavor brokkr-live image for ${arch}, which ${n.name} boots. Enable the bare-metal plane so the spoke syncs the full tree, then re-sync from the Storage page.`,
      ),
    ];
  });
}

// keyed off the contract's node kind, so a third plane is a compile error here rather than a silent PRIMARY check
const READINESS_BY_KIND: Record<NodeKind, KindReadiness> = { vm: primaryFindings, baremetal: uplinkFindings };

async function hubFindings(
  nodes: PxeNode[],
  sources: Pick<BootReadinessSources, 'uplink' | 'zoneLabel' | 'simCidrs'>,
  transport: BootReadinessTransport,
): Promise<HubReadiness> {
  let session: HubReadinessSession;
  try {
    session = await transport.hub();
  } catch (error) {
    return {
      findings: [
        unevaluated(null, `Hub readiness could not be read (${getErrorMessage(error)}), so no prefix check ran.`),
      ],
      checkedNodes: NO_NODES,
    };
  }

  const list = await hubGet(session, PREFIXES_PATH);
  if ('error' in list)
    return {
      findings: [unevaluated(null, `The hub prefix list could not be read (${list.error}), so no prefix check ran.`)],
      checkedNodes: NO_NODES,
    };
  const prefixes = list.code === 200 ? HubPrefixListSchema.safeParse(list.body) : null;
  if (!prefixes?.success)
    return {
      findings: [unevaluated(null, `The hub prefix list could not be read (${list.code}), so no prefix check ran.`)],
      checkedNodes: NO_NODES,
    };

  const results = await Promise.all(
    Object.entries(READINESS_BY_KIND).map(([kind, check]) => {
      const group = nodes.filter((n) => n.kind === kind);
      return group.length === 0 ? Promise.resolve(NO_READINESS) : check(session, group, prefixes.data, sources);
    }),
  );
  return {
    findings: results.flatMap((r) => r.findings),
    checkedNodes: new Set(results.flatMap((r) => [...r.checkedNodes])),
  };
}

type PxeOutcome = NonNullable<BootTrail['pxe']>['outcome'];

// keyed off the contract's outcome enum, so a new bridge decision is a compile error here rather than a silent pass
const DECIDED: Record<PxeOutcome, ((node: string, at: string) => VerifyFinding) | null> = {
  offered: null,
  'refused-allowlist': (node, at) =>
    labFinding(
      node,
      LAB_BOOT_CODES.refused,
      `The bridge refused this machine's PXE request at ${at}: its MAC is not in the proxy allowlist.`,
    ),
  'no-subnet': (node, at) =>
    labFinding(
      node,
      LAB_BOOT_CODES.noSubnet,
      `The bridge had no DHCP subnet to answer this machine's PXE request at ${at}.`,
    ),
};

async function trailFinding(node: PxeNode, transport: BootReadinessTransport): Promise<VerifyFinding | null> {
  const trail = await transport.trail(node.pxeMac);
  if (trail.readError !== null)
    return unevaluated(node.name, `The PXE trail for ${node.name} could not be read (${trail.readError}).`);
  if (trail.pxe === null)
    return labFinding(node.name, LAB_BOOT_CODES.silent, 'No PXE request from this machine has reached the bridge.');
  return DECIDED[trail.pxe.outcome]?.(node.name, new Date(trail.pxe.atMs).toISOString()) ?? null;
}

export async function composeBootReadiness(
  sources: BootReadinessSources,
  transport: BootReadinessTransport,
  node?: string,
): Promise<FleetVerifyReport> {
  const selected = node === undefined ? sources.roster : sources.roster.filter((n) => n.name === node);
  const checkable = selected.filter(hasPxeMac);

  const [bridgeResults, hub, trails, images] = await Promise.all([
    Promise.all(sources.bridges.map((b) => bridgeFindings(b, transport))),
    checkable.length === 0 ? Promise.resolve(NO_READINESS) : hubFindings(checkable, sources, transport),
    Promise.all(checkable.map((n) => trailFinding(n, transport))),
    fullImageFindings(
      checkable.filter((n) => n.kind === 'baremetal'),
      sources,
      transport,
    ),
  ]);

  const nodeLevel = [
    ...hub.findings.filter((f) => f.node !== null),
    ...trails.filter((f): f is VerifyFinding => f !== null),
    ...images,
  ].sort((a, b) => (a.node ?? '').localeCompare(b.node ?? '') || a.detail.localeCompare(b.detail));
  const fleetLevel = [...hub.findings.filter((f) => f.node === null), ...bridgeResults.flat()];
  const findings = [...nodeLevel, ...fleetLevel];

  const flagged = new Set(nodeLevel.map((f) => f.node));
  // the trail can flag a node the hub never answered for, and a node the hub never probed is not ok
  const ok = [...hub.checkedNodes].filter((n) => !flagged.has(n)).length;
  return {
    status: findings.length === 0 ? 'healthy' : 'findings',
    planes: sources.planes,
    findings,
    summary: { checked: hub.checkedNodes.size, ok, findings: findings.length },
  };
}

const BRIDGE_READINESS_TIMEOUT_MS = 5_000;
const HUB_READINESS_TIMEOUT_MS = 5_000;

async function bridgeGet(target: LabBridgeTarget, path: string): Promise<unknown> {
  const res = await fetch(`http://${HOSTS.loopback}:${target.port}${path}`, {
    signal: AbortSignal.timeout(BRIDGE_READINESS_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return res.json();
}

const liveTransport: Omit<BootReadinessTransport, 'trail'> = {
  bridge: (target) => bridgeGet(target, '/api/boot-readiness'),
  inventory: (target) => bridgeGet(target, '/api/discovery/inventory'),
  hub: async () => {
    const hubBase = URLS.dial.hubApi;
    const jar = await hubApiSignIn(hubBase, AbortSignal.timeout(HUB_READINESS_TIMEOUT_MS));
    return {
      get: (path) => hubApiFetch(hubBase, jar, 'GET', path, undefined, AbortSignal.timeout(HUB_READINESS_TIMEOUT_MS)),
    };
  },
};

@Injectable()
export class BootReadinessService {
  private readonly transport: BootReadinessTransport;

  constructor(
    @Inject(FleetPowerService) private readonly fleet: Pick<FleetPowerService, 'roster'>,
    @Inject(OverlayStoreService)
    private readonly overlay: Pick<
      OverlayStoreService,
      'planes' | 'labBridges' | 'bmUplink' | 'fleetZones' | 'fleetConfig' | 'baremetalConfig'
    >,
    @Inject(BootTrailReader) trailReader: Pick<BootTrailReader, 'read'>,
    @Optional() transport?: BootReadinessTransport,
  ) {
    // the trail is the one live member that needs a provider, so it is bound here rather than at module level
    this.transport = transport ?? { ...liveTransport, trail: (mac) => trailReader.read(mac) };
  }

  getBootReadiness(node?: string): Promise<FleetVerifyReport> {
    const { planes, roster } = this.roster();
    const bridges = this.overlay.labBridges().map((b) => ({ proc: b.proc, port: b.port }));
    const uplink = this.overlay.bmUplink();
    const zoneLabel = this.overlay.fleetZones()[0] ?? null;
    const simCidrs = simNetworkCidrs(this.overlay.fleetConfig());
    return composeBootReadiness(
      { planes, roster, bridges, uplink, zoneLabel, simCidrs, bmArch: this.bmArch() },
      this.transport,
      node,
    );
  }

  // the same inheritance the topology view applies: a node's own arch, else the fleet default
  private bmArch(): Record<string, string> {
    const bm = this.overlay.baremetalConfig();
    if (bm === null) return {};
    return Object.fromEntries(
      Object.entries(bm.nodes).map(([name, spec]) => [
        name,
        typeof spec.arch === 'string' && spec.arch !== '' ? spec.arch : bm.arch,
      ]),
    );
  }

  async forMachine(name: string): Promise<BootTrail> {
    const node = this.roster().roster.find((n) => n.name === name);
    if (!node) throw new NotFoundException(`unknown node '${name}'`);
    if (!hasPxeMac(node))
      throw new NotFoundException(`'${name}' has no pxe mac, so the bridge keeps no boot trail for it`);
    return this.transport.trail(node.pxeMac);
  }

  private roster(): Pick<BootReadinessSources, 'planes' | 'roster'> {
    return { planes: this.overlay.planes(), roster: this.fleet.roster() };
  }
}
