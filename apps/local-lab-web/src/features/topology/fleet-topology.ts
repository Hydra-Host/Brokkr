import type { BareMetalConfig, BareMetalNode, FleetNodeEffective, Machine, ZoneRuntime, ZonesConfig } from '@/contract';

export type Health = 'ok' | 'degraded' | 'unknown';

export interface TopologyBridge {
  proc: string;
  port: number;
  grpc: number;
  /** Null is unknown, not absent: a failed presence read leaves the declared bridge unjudged. */
  online: boolean | null;
  leader: boolean;
}

interface TopologyNodeBase {
  name: string;
  zone: string;
  arch: string | null;
  /** Null when no live answer covered this node, which is not the same as the domain being off. */
  power: Machine['power'] | null;
  deviceId: string | null;
}

export interface TopologyVmNode extends TopologyNodeBase {
  kind: 'vm';
  /** The effective values, which are what the node actually gets once defaults are applied. */
  cpus: number;
  memoryMb: number;
  diskGb: number;
}

export interface TopologyBareMetalNode extends TopologyNodeBase {
  kind: 'baremetal';
  /** Null when the saved row has no BMC address yet, which the probe reports as unconfigured. */
  bmcIp: string | null;
}

export type TopologyNode = TopologyVmNode | TopologyBareMetalNode;

export interface TopologyZone {
  name: string;
  index: number;
  uuid: string | null;
  ordinals: number[];
  bridges: TopologyBridge[];
  nodes: TopologyNode[];
  health: Health;
  /** Why the health is what it is, so a zone never reads as merely quiet. */
  healthReason: string;
  seeded: boolean;
}

export interface TopologyModel {
  zones: TopologyZone[];
  /** Nodes naming a zone nothing declares — what a rename leaves behind. */
  orphanNodes: TopologyNode[];
  /** Running domains the config does not carry, so a rebuild would adopt them. */
  adoptable: string[];
  /** Hub rows no declared zone matches, excluding the known seeded fixture. */
  hubOnly: string[];
  capacity: { used: number; total: number };
  /** False when any source failed, so an empty orphan or drift list is not agreement. */
  trustworthy: boolean;
  /** True while a source has not answered yet, which is not the same as untrustworthy. */
  loading: boolean;
  /** Every read that failed, for the UI to name rather than imply. */
  readErrors: string[];
}

/** Three states, not two: a query that has not answered yet is not a read that failed, and
 *  collapsing them made a first paint claim the machine list was unreadable. */
export type Source<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'failed'; error: string };

export interface TopologyInput {
  zones: Source<ZonesConfig>;
  fleet: Source<{ nodes: FleetNodeEffective[]; baremetal: BareMetalConfig }>;
  machines: Source<Machine[]>;
  runtime: Source<ZoneRuntime[]>;
}

const valueOf = <T>(source: Source<T>): T | null => (source.state === 'ready' ? source.value : null);

const nodeOf = (node: FleetNodeEffective, machine: Machine | undefined): TopologyNode => ({
  kind: 'vm',
  name: node.name,
  zone: node.zone,
  cpus: node.effective_cpus,
  memoryMb: node.effective_memory_mb,
  diskGb: node.effective_disk_gb,
  arch: node.arch ?? null,
  power: machine?.power ?? null,
  deviceId: machine?.deviceId ?? null,
});

const bareMetalNodeOf = (
  node: BareMetalNode,
  zone: string,
  defaultArch: BareMetalConfig['arch'],
  machine: Machine | undefined,
): TopologyNode => ({
  kind: 'baremetal',
  name: node.name,
  zone,
  arch: node.arch ?? defaultArch,
  bmcIp: node.bmc_ip === '' ? null : node.bmc_ip,
  power: machine?.power ?? null,
  deviceId: machine?.deviceId ?? null,
});

/** A zone is judged only when every read behind it succeeded. `rows` being empty means "none" only
 *  when its own readError is null, which is the contract the runtime schema states. */
function healthOf(runtime: ZoneRuntime | undefined): { health: Health; healthReason: string } {
  if (runtime === undefined) return { health: 'unknown', healthReason: 'declared, not seeded' };
  if (runtime.readError !== null) return { health: 'unknown', healthReason: `zone read failed — ${runtime.readError}` };
  if (runtime.bridges.readError !== null) {
    return { health: 'unknown', healthReason: `bridge presence unread — ${runtime.bridges.readError}` };
  }
  if (runtime.leader.readError !== null) {
    return { health: 'unknown', healthReason: `leader lease unread — ${runtime.leader.readError}` };
  }
  const expected = runtime.bridges.rows.filter((row) => row.expected);
  const offline = expected.filter((row) => !row.online).map((row) => row.instanceId);
  if (expected.length === 0) return { health: 'degraded', healthReason: 'no bridge is declared for this zone' };
  if (offline.length > 0) return { health: 'degraded', healthReason: `offline: ${offline.join(', ')}` };
  if (runtime.leader.holder === null) return { health: 'degraded', healthReason: 'no bridge holds the leader lease' };
  return { health: 'ok', healthReason: `leader ${runtime.leader.holder}` };
}

export function buildTopology(input: TopologyInput): TopologyModel {
  const sources = [
    { label: 'the zone config', source: input.zones },
    { label: 'the fleet config', source: input.fleet },
    { label: 'the live machine list', source: input.machines },
    { label: 'the zone runtime', source: input.runtime },
  ];
  const readErrors = sources
    .filter((entry) => entry.source.state === 'failed')
    .map((entry) => `${entry.label} could not be read — ${entry.source.state === 'failed' ? entry.source.error : ''}`);
  const loading = sources.some((entry) => entry.source.state === 'loading');

  const zonesBody = valueOf(input.zones);
  if (zonesBody?.hubReadError != null) readErrors.push(`hub zone rows unread — ${zonesBody.hubReadError}`);
  if (zonesBody?.seeded === false) readErrors.push('the devenv eval seed failed, so these are bare defaults');

  const machineByName = new Map((valueOf(input.machines) ?? []).map((machine) => [machine.name, machine]));
  const runtimeByName = new Map(
    (valueOf(input.runtime) ?? [])
      .filter((zone) => zone.zoneName !== null)
      .map((zone) => [zone.zoneName as string, zone]),
  );
  for (const zone of valueOf(input.runtime) ?? []) {
    if (zone.readError !== null) readErrors.push(`zone ${zone.zoneName ?? zone.zoneId} — ${zone.readError}`);
  }

  const declared = zonesBody?.zones ?? [];
  const declaredNames = new Set(declared.map((zone) => zone.name));
  const fleetBody = valueOf(input.fleet);
  const firstZone = declared[0]?.name;
  const vmNodes = (fleetBody?.nodes ?? []).map((node) => nodeOf(node, machineByName.get(node.name)));
  // tiles come from the saved roster, not the probe, so a failed BMC read cannot blink a machine out
  const bareMetalNodes =
    fleetBody === null
      ? []
      : fleetBody.baremetal.nodes.map((node) =>
          bareMetalNodeOf(node, node.zone ?? firstZone ?? '', fleetBody.baremetal.arch, machineByName.get(node.name)),
        );
  const nodes = [...vmNodes, ...bareMetalNodes];

  const zones: TopologyZone[] = declared.map((zone) => {
    const runtime = runtimeByName.get(zone.name);
    const liveByProc = new Map((runtime?.bridges.rows ?? []).map((row) => [row.instanceId, row]));
    const readable = runtime !== undefined && runtime.readError === null && runtime.bridges.readError === null;
    return {
      name: zone.name,
      index: zone.index,
      uuid: zone.derived.uuid,
      ordinals: zone.derived.ordinals,
      bridges: zone.derived.bridges.map((bridge) => {
        const live = liveByProc.get(bridge.proc);
        return {
          proc: bridge.proc,
          port: bridge.port,
          grpc: bridge.grpc,
          online: readable ? (live?.online ?? false) : null,
          leader: live?.isLeader ?? false,
        };
      }),
      nodes: nodes.filter((node) => node.zone === zone.name),
      seeded: runtime !== undefined,
      ...healthOf(runtime),
    };
  });

  const adoptable = (valueOf(input.machines) ?? [])
    .filter((machine) => !machine.configured)
    .map((machine) => machine.name);
  const hubOnly = (zonesBody?.reconcile ?? [])
    .filter((row) => row.side === 'hub-only' && !row.fixture && row.name !== null)
    .map((row) => row.name as string);

  return {
    zones,
    orphanNodes: nodes.filter((node) => !declaredNames.has(node.zone)),
    adoptable,
    hubOnly,
    capacity: zonesBody?.capacity ?? { used: 0, total: 0 },
    trustworthy: readErrors.length === 0,
    loading,
    readErrors,
  };
}
