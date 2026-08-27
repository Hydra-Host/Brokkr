import type { FleetNetwork, FleetNode, FleetTombstone, RejectedEntry } from '@repo/local-lab-contract';
import { describe, expect, it, vi } from 'vitest';

import { FleetTopologyService } from '../fleet-topology.service';

const node = (over: Partial<FleetNode> = {}): FleetNode => ({
  name: 'cpu-1',
  zone: 'sim-zone',
  ipmi_mac: '52:54:00:bc:00:01',
  data_mac: '52:54:00:da:00:01',
  cpus: null,
  memory_mb: null,
  disk_gb: null,
  arch: null,
  disks: [],
  passthrough: [],
  nics: [],
  data_mtu: null,
  network_type: null,
  ip: null,
  bmc_ip: null,
  bmc: null,
  console_port: null,
  ...over,
});

const network = (over: Partial<FleetNetwork> = {}): FleetNetwork => ({
  name: 'brokkr-net',
  cidr: '192.168.200.0/24',
  bmcCidr: '192.168.105.0/24',
  domain: 'sim.local',
  dhcp: false,
  renderedNetplan: false,
  ...over,
});

const svcFor = (tombstones: FleetTombstone[] = [], rejections: RejectedEntry[] = []) => {
  const setFleetConfig = vi.fn().mockReturnValue(rejections);
  const overlay = {
    fleetConfig: () => ({
      network: { cidr: '192.168.200.0/24', bmc_cidr: '192.168.105.0/24' },
      defaults: {},
      nodes: {
        'cpu-1': {
          name: 'cpu-1',
          ipmi_mac: '52:54:00:bc:00:01',
          data_mac: '52:54:00:da:00:01',
          zone: 'sim-zone',
          index: 0,
        },
      },
    }),
    setFleetConfig,
    baremetalConfig: () => null,
    fleetZones: () => ['sim-zone'],
    fleetTombstones: () => tombstones,
    fleetCustomized: () => true,
    fleetMode: () => 'vm',
  };
  const rendered = { renderDesiredFleetYaml: () => Promise.resolve(null) };
  const svc = new FleetTopologyService({ repoRoot: '/repo' } as never, overlay as never, rendered as never);
  return { svc, setFleetConfig };
};

const emptyBaremetal = { nics: [], arch: 'amd64' as const, bmcDefaults: { username: '', password: '' }, nodes: [] };

const put = (
  svc: FleetTopologyService,
  over: { nodes?: FleetNode[]; network?: FleetNetwork; prune?: string[] } = {},
) =>
  svc.putConfig({
    mode: 'vm',
    nodes: over.nodes ?? [node()],
    network: over.network,
    prune: over.prune,
    baremetal: emptyBaremetal,
  });

describe('putConfig — rendered_netplan', () => {
  it('refuses a multi-zone fleet, naming the cidr the zones share', () => {
    const { svc, setFleetConfig } = svcFor();
    const nodes = [
      node(),
      node({ name: 'cpu-2', zone: 'edge', data_mac: '52:54:00:da:00:02', ipmi_mac: '52:54:00:bc:00:02' }),
    ];
    expect(() => put(svc, { nodes, network: network({ renderedNetplan: true }) })).toThrow(/single-zone/);
    expect(() => put(svc, { nodes, network: network({ renderedNetplan: true }) })).toThrow(/192\.168\.200\.0\/24/);
    expect(setFleetConfig).not.toHaveBeenCalled();
  });

  it('refuses it alongside dhcp', () => {
    const { svc, setFleetConfig } = svcFor();
    expect(() => put(svc, { network: network({ renderedNetplan: true, dhcp: true }) })).toThrow(/mutually exclusive/);
    expect(setFleetConfig).not.toHaveBeenCalled();
  });

  it('allows it on a single-zone fleet with dhcp off', () => {
    const { svc, setFleetConfig } = svcFor();
    put(svc, { network: network({ renderedNetplan: true }) });
    expect(setFleetConfig).toHaveBeenCalledOnce();
    expect(setFleetConfig.mock.calls[0][0].network).toMatchObject({
      rendered_netplan: true,
      bmc_cidr: '192.168.105.0/24',
    });
  });

  it('checks nothing when rendered_netplan is off', () => {
    const { svc, setFleetConfig } = svcFor();
    put(svc, { network: network({ dhcp: true }) });
    expect(setFleetConfig).toHaveBeenCalledOnce();
  });
});

describe('putConfig — pruning a tombstone', () => {
  it('refuses a node another file still declares', () => {
    const { svc, setFleetConfig } = svcFor([{ name: 'cpu-3', zone: 'sim-zone', baseDeclared: true }]);
    expect(() => put(svc, { prune: ['cpu-3'] })).toThrow(/declared outside this overlay/);
    expect(setFleetConfig).not.toHaveBeenCalled();
  });

  it('refuses a name that is not a tombstone at all', () => {
    const { svc } = svcFor([{ name: 'cpu-3', zone: 'sim-zone', baseDeclared: false }]);
    expect(() => put(svc, { prune: ['cpu-9'] })).toThrow(/not a removed node/);
  });

  it('passes a prune of an overlay-only node through to the writer', () => {
    const { svc, setFleetConfig } = svcFor([{ name: 'cpu-3', zone: 'sim-zone', baseDeclared: false }]);
    put(svc, { prune: ['cpu-3'] });
    expect(setFleetConfig.mock.calls[0][0].prune).toEqual(['cpu-3']);
  });
});

describe('putConfig — arch and network_type', () => {
  it('omits both when the node inherits, rather than pinning what it resolved to', () => {
    const { svc, setFleetConfig } = svcFor();
    put(svc);
    const spec = setFleetConfig.mock.calls[0][0].nodes[0].spec;
    expect(spec).not.toHaveProperty('arch');
    expect(spec).not.toHaveProperty('network_type');
  });

  it('writes both when the node pins them', () => {
    const { svc, setFleetConfig } = svcFor();
    put(svc, { nodes: [node({ arch: 'arm64', network_type: 'public' })] });
    expect(setFleetConfig.mock.calls[0][0].nodes[0].spec).toMatchObject({ arch: 'arm64', network_type: 'public' });
  });
});

describe('putConfig — the rejected channel', () => {
  it('returns the entries the overlay writer refused to write', () => {
    const entry: RejectedEntry = { path: 'fleet.mode', reason: 'pinned', detail: 'FLEET_MODE' };
    const { svc } = svcFor([], [entry]);

    expect(put(svc)).toEqual([entry]);
  });

  it('returns an empty list when the overlay writer accepted every key', () => {
    const { svc } = svcFor();

    expect(put(svc)).toEqual([]);
  });
});
