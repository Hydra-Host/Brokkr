import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BadRequestException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FleetTopologyService } from '../fleet-topology.service';

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'lab-state-'));
  vi.stubEnv('DEVENV_STATE', stateDir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

const vmNode = (over: Record<string, unknown> = {}) => ({
  name: 'vm-1',
  zone: 'sim-zone',
  ipmi_mac: 'aa:bb:cc:00:00:01',
  data_mac: 'aa:bb:cc:00:00:02',
  cpus: 2,
  memory_mb: 2048,
  disk_gb: 20,
  disks: [],
  passthrough: [],
  nics: [],
  data_mtu: null,
  arch: null,
  network_type: null,
  ip: null,
  bmc_ip: null,
  bmc: null,
  ...over,
});

const putBody = (nodes: ReturnType<typeof vmNode>[]) => ({
  mode: 'vm' as const,
  nodes,
  bmcDefaults: undefined,
  baremetal: { nics: [], arch: 'amd64' as const, bmcDefaults: { username: '', password: '' }, nodes: [] },
});

const putSvc = (cidr: string, bmcCidr = '192.168.105.0/24') => {
  const overlay = {
    fleetConfig: () => ({ network: { cidr, bmc_cidr: bmcCidr }, defaults: {}, nodes: {} }),
    setFleetConfig: vi.fn().mockReturnValue([]),
    fleetMode: () => 'vm',
    fleetZones: () => ['sim-zone'],
    fleetTombstones: () => [],
    fleetCustomized: () => true,
  };
  return new FleetTopologyService({} as never, overlay as never, {} as never);
};

describe('FleetTopologyService.putConfig — masked gateway check', () => {
  it('rejects the masked network gateway even when the cidr host part is non-canonical', () => {
    const svc = putSvc('192.168.200.77/24');
    expect(() => svc.putConfig(putBody([vmNode({ ip: '192.168.200.1' })]))).toThrow(/is the gateway/);
  });

  it('accepts the old-code false-positive (base + 1 of the raw host part) on a non-canonical cidr', () => {
    const svc = putSvc('192.168.200.77/24');
    expect(() => svc.putConfig(putBody([vmNode({ ip: '192.168.200.78' })]))).not.toThrow();
  });

  it('still rejects the gateway on a canonical cidr', () => {
    const svc = putSvc('192.168.200.0/24');
    expect(() => svc.putConfig(putBody([vmNode({ ip: '192.168.200.1' })]))).toThrow(/is the gateway/);
  });

  it('throws a BadRequestException type for the gateway rejection', () => {
    const svc = putSvc('192.168.200.77/24');
    expect(() => svc.putConfig(putBody([vmNode({ ip: '192.168.200.1' })]))).toThrow(BadRequestException);
  });
});

const getConfigSvc = (network: Record<string, unknown>, nodes: Record<string, Record<string, unknown>>) => {
  const overlay = {
    fleetConfig: () => ({ network, defaults: {}, nodes }),
    baremetalConfig: () => null,
    fleetZones: () => ['sim-zone'],
    fleetTombstones: () => [],
    fleetCustomized: () => false,
    fleetMode: () => 'vm',
  };
  const rendered = { renderDesiredFleetYaml: () => Promise.resolve(null) };
  return new FleetTopologyService({ repoRoot: '/repo' } as never, overlay as never, rendered as never);
};

describe('FleetTopologyService.getConfig — effective IPs', () => {
  it('derives effective_ip / effective_bmc_ip index-derived for a no-override node', async () => {
    const svc = getConfigSvc(
      { cidr: '192.168.200.0/24', bmc_cidr: '192.168.105.0/24' },
      { 'gpu-1': { index: 0, ipmi_mac: 'aa:bb:cc:00:00:01', data_mac: 'aa:bb:cc:00:00:02' } },
    );
    const cfg = await svc.getConfig();
    expect(cfg.nodes[0].effective_ip).toBe('192.168.200.10');
    expect(cfg.nodes[0].effective_bmc_ip).toBe('192.168.105.10');
  });

  it('lets the static override win over the derived IP', async () => {
    const svc = getConfigSvc(
      { cidr: '192.168.200.0/24', bmc_cidr: '192.168.105.0/24' },
      {
        'gpu-1': {
          index: 0,
          ipmi_mac: 'aa:bb:cc:00:00:01',
          data_mac: 'aa:bb:cc:00:00:02',
          ip: '192.168.200.50',
          bmc_ip: '192.168.105.50',
        },
      },
    );
    const cfg = await svc.getConfig();
    expect(cfg.nodes[0].effective_ip).toBe('192.168.200.50');
    expect(cfg.nodes[0].effective_bmc_ip).toBe('192.168.105.50');
  });

  it('returns null effective IPs when the respective cidr is missing', async () => {
    const svc = getConfigSvc(
      {},
      { 'gpu-1': { index: 0, ipmi_mac: 'aa:bb:cc:00:00:01', data_mac: 'aa:bb:cc:00:00:02' } },
    );
    const cfg = await svc.getConfig();
    expect(cfg.nodes[0].effective_ip).toBeNull();
    expect(cfg.nodes[0].effective_bmc_ip).toBeNull();
  });
});

describe('FleetTopologyService.addCommissioningNodesConfig — no derived-field leak', () => {
  it('never persists effective_ip / effective_bmc_ip into the overlay', async () => {
    const setFleetConfig = vi.fn().mockReturnValue([]);
    const overlay = {
      fleetConfig: () => ({
        network: { cidr: '192.168.200.0/24', bmc_cidr: '192.168.105.0/24' },
        defaults: {},
        nodes: { 'gpu-1': { index: 0, ipmi_mac: 'aa:bb:cc:00:00:01', data_mac: 'aa:bb:cc:00:00:02' } },
      }),
      setFleetConfig,
      baremetalConfig: () => null,
      fleetZones: () => ['sim-zone'],
      fleetTombstones: () => [],
      fleetCustomized: () => false,
      fleetMode: () => 'vm',
    };
    const rendered = { renderDesiredFleetYaml: () => Promise.resolve(null) };
    const svc = new FleetTopologyService({ repoRoot: '/repo' } as never, overlay as never, rendered as never);

    await svc.addCommissioningNodesConfig(2);

    expect(setFleetConfig).toHaveBeenCalledTimes(1);
    for (const node of setFleetConfig.mock.calls[0][0].nodes) {
      expect(node.spec).not.toHaveProperty('effective_ip');
      expect(node.spec).not.toHaveProperty('effective_bmc_ip');
    }
  });
});

describe('FleetTopologyService.rawFleet — malformed LOCAL_FLEET_PATH yaml', () => {
  it('throws a fleet-config-invalid error so status surfaces it instead of masking an empty fleet', () => {
    const fleetPath = join(stateDir, 'fleet.yml');
    writeFileSync(fleetPath, 'nodes: nope\n');
    vi.stubEnv('LOCAL_FLEET_PATH', fleetPath);
    const overlay = {
      fleetConfig: () => null,
      baremetalConfig: () => null,
      fleetZones: () => ['sim-zone'],
      fleetTombstones: () => [],
      fleetCustomized: () => false,
      fleetMode: () => 'vm',
    };
    const rendered = { renderDesiredFleetYaml: () => Promise.resolve(null) };
    const svc = new FleetTopologyService({ repoRoot: '/repo' } as never, overlay as never, rendered as never);

    expect(() => svc.nodeNames()).toThrow(/^fleet config invalid/);
  });
});
