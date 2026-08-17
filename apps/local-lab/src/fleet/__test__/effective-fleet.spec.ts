import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FleetTopologyService } from '../fleet-topology.service';

type ActiveFleet = {
  network: { cidr?: string; bmc_cidr?: string };
  defaults: Record<string, unknown>;
  nodes: { name: string }[];
};
type WithActiveFleet = { activeFleet(): ActiveFleet };

const activeFleet = (fleet: unknown): ActiveFleet => {
  const svc = new FleetTopologyService({} as never, { fleetConfig: () => fleet } as never, {} as never);
  return (svc as unknown as WithActiveFleet).activeFleet();
};

describe('FleetTopologyService.activeFleet — mirror path', () => {
  it('parses mirror-shaped nodes, strips enable/index, keeps zone + unknown extra keys', () => {
    const result = activeFleet({
      network: { cidr: '192.168.200.0/24', bmc_cidr: '192.168.105.0/24' },
      defaults: { cpus: 2 },
      nodes: {
        'gpu-1': {
          enable: true,
          index: 0,
          zone: 'sim-zone',
          ipmi_mac: 'aa:bb:cc:00:00:01',
          data_mac: 'aa:bb:cc:00:00:02',
          cpus: 4,
          console_port: 9300,
        },
      },
    });
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({ name: 'gpu-1', zone: 'sim-zone', console_port: 9300 });
    expect(result.nodes[0]).not.toHaveProperty('enable');
    expect(result.nodes[0]).not.toHaveProperty('index');
    expect(result.network.cidr).toBe('192.168.200.0/24');
  });

  it('parses a node with a partial disk spec (engine defaults size/type)', () => {
    const result = activeFleet({
      network: {},
      defaults: {},
      nodes: {
        'gpu-1': {
          index: 0,
          ipmi_mac: 'aa:bb:cc:00:00:01',
          data_mac: 'aa:bb:cc:00:00:02',
          disks: [{ size_gb: 500 }],
        },
      },
    });
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({ disks: [{ size_gb: 500 }] });
  });

  it('drops enable:false nodes and sorts by index', () => {
    const result = activeFleet({
      network: {},
      defaults: {},
      nodes: {
        b: { index: 1, ipmi_mac: 'aa:bb:cc:00:00:03', data_mac: 'aa:bb:cc:00:00:04' },
        a: { index: 0, ipmi_mac: 'aa:bb:cc:00:00:01', data_mac: 'aa:bb:cc:00:00:02' },
        gone: { enable: false, index: 2, ipmi_mac: 'aa:bb:cc:00:00:05', data_mac: 'aa:bb:cc:00:00:06' },
      },
    });
    expect(result.nodes.map((n) => n.name)).toEqual(['a', 'b']);
  });

  it('throws naming the node when data_mac is missing', () => {
    const bad = { network: {}, defaults: {}, nodes: { 'gpu-1': { index: 0, ipmi_mac: 'aa:bb:cc:00:00:01' } } };
    expect(() => activeFleet(bad)).toThrow(/gpu-1/);
    expect(() => activeFleet(bad)).toThrow(/data_mac/);
  });

  it('throws naming the node when cpus is the wrong type', () => {
    const bad = {
      network: {},
      defaults: {},
      nodes: { 'gpu-1': { index: 0, ipmi_mac: 'aa:bb:cc:00:00:01', data_mac: 'aa:bb:cc:00:00:02', cpus: 'four' } },
    };
    expect(() => activeFleet(bad)).toThrow(/gpu-1/);
  });
});

describe('FleetTopologyService.activeFleet — yaml + empty paths', () => {
  const SAVED = process.env.LOCAL_FLEET_PATH;
  afterEach(() => {
    if (SAVED === undefined) delete process.env.LOCAL_FLEET_PATH;
    else process.env.LOCAL_FLEET_PATH = SAVED;
  });

  it('parses a yaml-list fleet', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'lab-fleet-')), 'fleet.yml');
    writeFileSync(
      path,
      [
        'network:',
        '  cidr: 192.168.200.0/24',
        '  bmc_cidr: 192.168.105.0/24',
        'defaults:',
        '  cpus: 2',
        'nodes:',
        '  - name: gpu-1',
        '    ipmi_mac: aa:bb:cc:00:00:01',
        '    data_mac: aa:bb:cc:00:00:02',
        '    console_port: 9300',
        '',
      ].join('\n'),
    );
    process.env.LOCAL_FLEET_PATH = path;
    const result = activeFleet(null);
    expect(result.nodes.map((n) => n.name)).toEqual(['gpu-1']);
    expect(result.nodes[0]).toMatchObject({ console_port: 9300 });
    expect(result.network.cidr).toBe('192.168.200.0/24');
  });

  it('returns empty network/defaults/nodes when there is no mirror and no yaml', () => {
    delete process.env.LOCAL_FLEET_PATH;
    const result = activeFleet(null);
    expect(result.nodes).toEqual([]);
    expect(result.network).toEqual({});
  });
});
