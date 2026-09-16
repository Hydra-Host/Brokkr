import { describe, expect, it } from 'vitest';

import type {
  BareMetalConfig,
  BareMetalNode,
  FleetNodeEffective,
  Machine,
  Zone,
  ZoneRuntime,
  ZonesConfig,
} from '@/contract';

import { buildTopology, type Source, type TopologyInput } from './fleet-topology';

const ready = <T>(value: T): Source<T> => ({ state: 'ready', value });

const zoneRow = (over: Partial<Zone> = {}): Zone => ({
  name: 'sim-zone',
  index: 0,
  bridges: 1,
  baseDeclared: true,
  derived: {
    uuid: '00000000-0000-0000-0000-111111111111',
    ordinals: [0],
    bridges: [{ proc: 'spoke', port: 8000, grpc: 9082 }],
    nodeCount: 1,
  },
  ...over,
});

const zonesConfig = (over: Partial<ZonesConfig> = {}): ZonesConfig => ({
  seeded: true,
  zones: [zoneRow()],
  capacity: { used: 1, total: 47 },
  reservedNames: ['sim-zone-maintenance'],
  reconcile: [],
  hubReadError: null,
  ...over,
});

const node = (over: Partial<FleetNodeEffective> = {}): FleetNodeEffective => ({
  name: 'cpu-1',
  zone: 'sim-zone',
  cpus: 4,
  memory_mb: 8192,
  disk_gb: 40,
  arch: 'amd64',
  network_type: null,
  ip: null,
  bmc_ip: null,
  bmc: null,
  disks: [],
  passthrough: [],
  nics: [],
  data_mtu: null,
  ipmi_mac: '52:54:00:00:00:01',
  data_mac: '52:54:00:00:01:01',
  effective_ip: '192.168.105.10',
  effective_bmc_ip: '192.168.200.10',
  effective_cpus: 4,
  effective_memory_mb: 8192,
  effective_disk_gb: 40,
  ...over,
});

const bareMetalNode = (over: Partial<BareMetalNode> = {}): BareMetalNode => ({
  name: 'metal-1',
  bmc_ip: '192.168.1.50',
  bmc_mac: '3c:ec:ef:00:00:01',
  pxe_mac: '3c:ec:ef:00:00:02',
  arch: null,
  zone: 'sim-zone',
  system_id: null,
  network_type: null,
  ...over,
});

const baremetalConfig = (nodes: BareMetalNode[] = []): BareMetalConfig => ({ nics: ['enp0'], arch: 'amd64', nodes });

const machine = (over: Partial<Machine> = {}): Machine => ({
  name: 'cpu-1',
  kind: 'vm',
  power: 'on',
  configured: true,
  deviceId: 'device-1',
  bmc: null,
  ...over,
});

const bridgeRow = (over: Record<string, unknown> = {}) => ({
  instanceId: 'spoke',
  expected: true,
  registered: true,
  isLeader: true,
  online: true,
  registeredAtMs: 1_700_000_000_000,
  workerVersion: null,
  liveVersion: null,
  interfaces: null,
  plugins: null,
  port: 8000,
  grpcPort: 9082,
  http: null,
  readError: null,
  ...over,
});

const runtime = (over: Partial<ZoneRuntime> = {}): ZoneRuntime => ({
  zoneId: '00000000-0000-0000-0000-111111111111',
  zoneName: 'sim-zone',
  leader: { holder: 'spoke', ttlSeconds: 28, readError: null },
  bridges: { rows: [bridgeRow()], readError: null },
  vrrp: { observability: 'shim', vips: [], readError: null },
  zoneCrypto: { state: 'enrolled', bootstrapLockTtlSeconds: null, readError: null },
  agentWork: { dispatchesInFlight: 0, lastActivityAtMs: null, scanCapped: false, readError: null },
  readError: null,
  ...over,
});

const input = (over: Partial<TopologyInput> = {}): TopologyInput => ({
  zones: ready(zonesConfig()),
  fleet: ready({ nodes: [node()], baremetal: baremetalConfig() }),
  machines: ready([machine()]),
  runtime: ready([runtime()]),
  ...over,
});

describe('buildTopology — the healthy shape', () => {
  it('puts a node under the zone it names, with its live power', () => {
    const model = buildTopology(input());

    expect(model.zones).toHaveLength(1);
    expect(model.zones[0].nodes.map((n) => n.name)).toEqual(['cpu-1']);
    expect(model.zones[0].nodes[0].power).toBe('on');
  });

  it('joins a declared bridge to its live presence by process name', () => {
    const model = buildTopology(input());

    expect(model.zones[0].bridges).toEqual([{ proc: 'spoke', port: 8000, grpc: 9082, online: true, leader: true }]);
  });

  it('reports the zone healthy and names the leader', () => {
    const model = buildTopology(input());

    expect(model.zones[0].health).toBe('ok');
    expect(model.zones[0].healthReason).toMatch(/leader spoke/);
    expect(model.trustworthy).toBe(true);
  });
});

describe('buildTopology — the states that cause the confusion', () => {
  it('lists a node whose zone nothing declares, rather than dropping it', () => {
    const model = buildTopology(
      input({ fleet: ready({ nodes: [node({ zone: 'sim-zone0' })], baremetal: baremetalConfig() }) }),
    );

    expect(model.zones[0].nodes).toEqual([]);
    expect(model.orphanNodes.map((n) => n.name)).toEqual(['cpu-1']);
  });

  it('lists a running domain the config does not carry', () => {
    const model = buildTopology(input({ machines: ready([machine(), machine({ name: 'stray', configured: false })]) }));

    expect(model.adoptable).toEqual(['stray']);
  });

  it('lists a hub row no declared zone matches, and ignores the seeded fixture', () => {
    const model = buildTopology(
      input({
        zones: ready(
          zonesConfig({
            reconcile: [
              { name: 'gone-zone', zoneId: 'z-9', side: 'hub-only', fixture: false },
              { name: 'sim-zone-maintenance', zoneId: 'z-0', side: 'hub-only', fixture: true },
            ],
          }),
        ),
      }),
    );

    expect(model.hubOnly).toEqual(['gone-zone']);
  });
});

describe('buildTopology — the bare-metal plane', () => {
  it('puts a saved bare-metal machine under the zone it names, after the vm nodes', () => {
    const model = buildTopology(
      input({ fleet: ready({ nodes: [node()], baremetal: baremetalConfig([bareMetalNode()]) }) }),
    );

    expect(model.zones[0].nodes.map((n) => [n.kind, n.name])).toEqual([
      ['vm', 'cpu-1'],
      ['baremetal', 'metal-1'],
    ]);
  });

  it('lands a bare-metal machine with no zone in the first declared zone', () => {
    const model = buildTopology(
      input({
        zones: ready(zonesConfig({ zones: [zoneRow(), zoneRow({ name: 'edge', index: 1 })] })),
        fleet: ready({ nodes: [], baremetal: baremetalConfig([bareMetalNode({ zone: null })]) }),
      }),
    );

    expect(model.zones[0].nodes.map((n) => n.name)).toEqual(['metal-1']);
    expect(model.zones[1].nodes).toEqual([]);
    expect(model.orphanNodes).toEqual([]);
  });

  it('orphans a bare-metal machine with no zone when nothing declares a zone', () => {
    const model = buildTopology(
      input({
        zones: ready(zonesConfig({ zones: [] })),
        fleet: ready({ nodes: [], baremetal: baremetalConfig([bareMetalNode({ zone: null })]) }),
      }),
    );

    expect(model.zones).toEqual([]);
    expect(model.orphanNodes.map((n) => [n.name, n.zone])).toEqual([['metal-1', '']]);
  });

  it('takes a bare-metal power state and device id from its live machine row', () => {
    const model = buildTopology(
      input({
        fleet: ready({ nodes: [], baremetal: baremetalConfig([bareMetalNode()]) }),
        machines: ready([machine({ name: 'metal-1', kind: 'baremetal', power: 'off', deviceId: 'device-9' })]),
      }),
    );

    expect(model.zones[0].nodes[0]).toMatchObject({ kind: 'baremetal', power: 'off', deviceId: 'device-9' });
  });

  it('inherits the fleet arch when the machine declares none', () => {
    const model = buildTopology(
      input({
        fleet: ready({
          nodes: [],
          baremetal: baremetalConfig([
            bareMetalNode({ arch: null }),
            bareMetalNode({ name: 'metal-2', arch: 'arm64' }),
          ]),
        }),
      }),
    );

    expect(model.zones[0].nodes.map((n) => n.arch)).toEqual(['amd64', 'arm64']);
  });

  it('reads an empty bmc address as unset', () => {
    const model = buildTopology(
      input({ fleet: ready({ nodes: [], baremetal: baremetalConfig([bareMetalNode({ bmc_ip: '' })]) }) }),
    );

    expect(model.zones[0].nodes[0]).toMatchObject({ kind: 'baremetal', bmcIp: null });
  });

  it('lists a bare-metal machine whose zone nothing declares, rather than dropping it', () => {
    const model = buildTopology(
      input({ fleet: ready({ nodes: [node()], baremetal: baremetalConfig([bareMetalNode({ zone: 'gone-zone' })]) }) }),
    );

    expect(model.zones[0].nodes.map((n) => n.name)).toEqual(['cpu-1']);
    expect(model.orphanNodes.map((n) => [n.name, n.zone])).toEqual([['metal-1', 'gone-zone']]);
  });

  it('leaves bare-metal power unknown when no live answer covered it', () => {
    const model = buildTopology(
      input({ fleet: ready({ nodes: [], baremetal: baremetalConfig([bareMetalNode()]) }), machines: ready([]) }),
    );

    expect(model.zones[0].nodes[0]).toMatchObject({ power: null, deviceId: null });
    expect(model.trustworthy).toBe(true);
  });
});

describe('buildTopology — a failed read is never healthy', () => {
  it('reports unknown when the whole-zone read failed', () => {
    const model = buildTopology(input({ runtime: ready([runtime({ readError: 'redis refused' })]) }));

    expect(model.zones[0].health).toBe('unknown');
    expect(model.zones[0].healthReason).toMatch(/redis refused/);
  });

  it('reports unknown when the bridge presence read failed, not offline', () => {
    const model = buildTopology(
      input({ runtime: ready([runtime({ bridges: { rows: [], readError: 'scan failed' } })]) }),
    );

    expect(model.zones[0].health).toBe('unknown');
    expect(model.zones[0].bridges[0].online).toBeNull();
  });

  it('reports unknown for a zone the runtime never covered', () => {
    const model = buildTopology(input({ runtime: ready([]) }));

    expect(model.zones[0].health).toBe('unknown');
    expect(model.zones[0].seeded).toBe(false);
  });

  it('refuses to call an empty reconcile agreement when the hub rows went unread', () => {
    const model = buildTopology(input({ zones: ready(zonesConfig({ hubReadError: 'hub unreachable' })) }));

    expect(model.hubOnly).toEqual([]);
    expect(model.trustworthy).toBe(false);
    expect(model.readErrors.join(' ')).toMatch(/hub unreachable/);
  });

  it('refuses to trust the model when the seed failed', () => {
    const model = buildTopology(input({ zones: ready(zonesConfig({ seeded: false })) }));

    expect(model.trustworthy).toBe(false);
    expect(model.readErrors.join(' ')).toMatch(/bare defaults/);
  });

  it('leaves power unknown rather than off when no live answer covered the node', () => {
    const model = buildTopology(input({ machines: ready([]) }));

    expect(model.zones[0].nodes[0].power).toBeNull();
    expect(model.trustworthy).toBe(true);
  });

  it('degrades rather than fails when a declared bridge is offline', () => {
    const model = buildTopology(
      input({ runtime: ready([runtime({ bridges: { rows: [bridgeRow({ online: false })], readError: null } })]) }),
    );

    expect(model.zones[0].health).toBe('degraded');
    expect(model.zones[0].healthReason).toMatch(/offline: spoke/);
  });

  it('degrades when no bridge holds the leader lease', () => {
    const model = buildTopology(
      input({ runtime: ready([runtime({ leader: { holder: null, ttlSeconds: null, readError: null } })]) }),
    );

    expect(model.zones[0].health).toBe('degraded');
    expect(model.zones[0].healthReason).toMatch(/leader lease/);
  });
});

describe('buildTopology — a source that has not answered is not a source that failed', () => {
  it('reports loading without inventing a read error', () => {
    const model = buildTopology(input({ machines: { state: 'loading' } }));

    expect(model.loading).toBe(true);
    expect(model.readErrors).toEqual([]);
    expect(model.trustworthy).toBe(true);
  });

  it('names a source that actually failed, and stops trusting the model', () => {
    const model = buildTopology(input({ machines: { state: 'failed', error: 'the machine list request failed' } }));

    expect(model.loading).toBe(false);
    expect(model.readErrors.join(' ')).toMatch(/machine list could not be read/);
    expect(model.trustworthy).toBe(false);
  });

  it('reports unknown when the leader key itself went unread, not an unheld lease', () => {
    const model = buildTopology(
      input({ runtime: ready([runtime({ leader: { holder: null, ttlSeconds: null, readError: 'timeout' } })]) }),
    );

    expect(model.zones[0].health).toBe('unknown');
    expect(model.zones[0].healthReason).toMatch(/leader lease unread — timeout/);
  });
});
