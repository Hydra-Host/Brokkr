import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BadRequestException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FleetNode } from '@repo/local-lab-contract';

import { FleetTopologyService } from '../fleet-topology.service';

type WithHost = { hostFacts: () => { os: string } };

function makeService(os = 'linux') {
  const setFleetConfig = vi.fn().mockReturnValue([]);
  const overlay = {
    setFleetConfig,
    baremetalConfig: () => null,
    fleetConfig: () => null,
    fleetZones: () => ['sim-zone'],
    fleetCustomized: () => true,
  };
  const svc = new FleetTopologyService({} as never, overlay as never, {} as never);
  vi.spyOn(svc as unknown as WithHost, 'hostFacts').mockReturnValue({ os });
  return { svc, setFleetConfig };
}

const node = (over: Record<string, unknown> = {}) => ({
  name: 'metal-1',
  bmc_ip: '192.168.1.50',
  bmc_mac: 'aa:bb:cc:dd:ee:01',
  pxe_mac: 'aa:bb:cc:dd:ee:02',
  arch: null,
  system_id: null,
  bmc_user: null,
  bmc_pass: null,
  ...over,
});

const body = (nodes: ReturnType<typeof node>[], nics = ['enp35s0']) => ({
  nodes: [],
  bmcDefaults: undefined,
  baremetal: { nics, arch: 'amd64' as const, bmcDefaults: { username: '', password: '' }, nodes },
});

const vmNode: FleetNode = {
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
};

const vmBody = (nodes: ReturnType<typeof node>[], nics = ['enp35s0'], vm = vmNode) => ({
  nodes: [vm],
  bmcDefaults: undefined,
  baremetal: { nics, arch: 'amd64' as const, bmcDefaults: { username: '', password: '' }, nodes },
});

const bmcNetwork = {
  name: 'brokkr-net',
  cidr: '192.168.200.0/24',
  bmcCidr: '192.168.1.0/24',
  domain: 'sim.local',
  dhcp: false,
  renderedNetplan: false,
};

const stubState = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'lab-state-'));
  vi.stubEnv('DEVENV_STATE', dir);
  return join(dir, 'baremetal', 'bmc-creds.json');
};

afterEach(() => vi.unstubAllEnvs());

describe('FleetTopologyService.putConfig — bare-metal validation', () => {
  it('rejects an invalid PXE MAC', () => {
    const { svc } = makeService();
    expect(() => svc.putConfig(body([node({ pxe_mac: 'nope' })]))).toThrow(BadRequestException);
  });

  it('rejects a duplicate BMC IP across machines', () => {
    const { svc } = makeService();
    expect(() =>
      svc.putConfig(
        body([node({ name: 'a' }), node({ name: 'b', bmc_mac: 'aa:bb:cc:dd:ee:03', pxe_mac: 'aa:bb:cc:dd:ee:04' })]),
      ),
    ).toThrow(/duplicate BMC IP/);
  });

  it('rejects a half-set per-node cred pair', () => {
    const { svc } = makeService();
    expect(() => svc.putConfig(body([node({ bmc_user: 'root', bmc_pass: null })]))).toThrow(/username and password/);
  });

  it('refuses a save with no node in either plane', () => {
    const { svc } = makeService();
    expect(() => svc.putConfig(body([]))).toThrow(/at least one node in either plane/);
  });

  it('saves a bare-metal roster with no vm node', () => {
    stubState();
    const { svc, setFleetConfig } = makeService();
    expect(() => svc.putConfig(body([node()]))).not.toThrow();
    expect(setFleetConfig.mock.calls[0][0].nodes).toEqual([]);
    expect(setFleetConfig.mock.calls[0][0].baremetal.nodes.map((n: { name: string }) => n.name)).toEqual(['metal-1']);
  });

  it('rejects an empty machine name', () => {
    const { svc } = makeService();
    expect(() => svc.putConfig(body([node({ name: '' })]))).toThrow(/name is required/);
  });

  it('refuses a bare-metal row on a macOS host', () => {
    const { svc } = makeService('darwin');
    expect(() => svc.putConfig(body([node()]))).toThrow(/need a Linux host/);
  });

  it('refuses a bare-metal row without an uplink NIC', () => {
    const { svc } = makeService();
    expect(() => svc.putConfig(body([node()], []))).toThrow(/uplink NIC/);
  });

  it('strips creds from the overlay handoff and writes them 0600, merged', () => {
    const credsPath = stubState();
    const { svc, setFleetConfig } = makeService();
    svc.putConfig(body([node({ bmc_user: 'root', bmc_pass: 'secret' })]));

    const arg = setFleetConfig.mock.calls[0][0];
    expect(arg.baremetal.nodes[0].spec).toMatchObject({ bmc_ip: '192.168.1.50' });
    expect(JSON.stringify(arg.baremetal)).not.toContain('secret');

    const creds = JSON.parse(readFileSync(credsPath, 'utf8'));
    expect(creds['metal-1']).toEqual({ user: 'root', pass: 'secret' });
  });
});

describe('FleetTopologyService.putConfig — validates the bare-metal block as soon as a row is saved', () => {
  it('refuses a malformed row (invalid PXE MAC) beside the vm roster', () => {
    const { svc } = makeService();
    expect(() => svc.putConfig(vmBody([node({ pxe_mac: 'nope' })]))).toThrow(/invalid PXE MAC/);
  });

  it('refuses a row without an uplink NIC beside the vm roster', () => {
    const { svc } = makeService();
    expect(() => svc.putConfig(vmBody([node()], []))).toThrow(/uplink NIC/);
  });

  it('saves a vm roster with no bare-metal rows and no uplink NIC', () => {
    stubState();
    const { svc, setFleetConfig } = makeService();
    expect(() => svc.putConfig(vmBody([], []))).not.toThrow();
    expect(setFleetConfig.mock.calls[0][0].baremetal.nodes).toEqual([]);
  });

  it('saves a vm roster with no bare-metal rows on a macOS host', () => {
    stubState();
    const { svc } = makeService('darwin');
    expect(() => svc.putConfig(vmBody([], []))).not.toThrow();
  });

  it('still enforces the reserved `defaults` name guard (protects the creds slot)', () => {
    stubState();
    const { svc } = makeService();
    expect(() => svc.putConfig(vmBody([node({ name: 'defaults' })]))).toThrow(/reserved/);
  });

  it('rejects an empty-name row beside the vm roster', () => {
    stubState();
    const { svc } = makeService();
    expect(() => svc.putConfig(vmBody([node({ name: '' })]))).toThrow(/name is required/);
  });

  it('refuses a bare-metal machine that reuses a vm node name', () => {
    const { svc } = makeService();
    expect(() => svc.putConfig(vmBody([node({ name: 'vm-1' })]))).toThrow(
      'bare-metal machine vm-1 reuses a vm node name',
    );
  });

  it('refuses a bare-metal machine that reuses the static bmc address of a vm node', () => {
    const { svc } = makeService();
    const vm: FleetNode = { ...vmNode, bmc_ip: '192.168.105.50' };
    expect(() => svc.putConfig(vmBody([node({ bmc_ip: '192.168.105.50' })], ['enp35s0'], vm))).toThrow(
      'bare-metal machine metal-1 reuses the bmc address of vm node vm-1',
    );
  });

  it('refuses a bare-metal machine that reuses the index-derived bmc address of a vm node', () => {
    const { svc } = makeService();
    expect(() => svc.putConfig({ ...vmBody([node({ bmc_ip: '192.168.1.10' })]), network: bmcNetwork })).toThrow(
      'bare-metal machine metal-1 reuses the bmc address of vm node vm-1',
    );
  });

  it('saves a bare-metal machine whose name and bmc address are distinct from every vm node', () => {
    stubState();
    const { svc, setFleetConfig } = makeService();
    expect(() => svc.putConfig({ ...vmBody([node()]), network: bmcNetwork })).not.toThrow();
    expect(setFleetConfig.mock.calls[0][0].baremetal.nodes.map((n: { name: string }) => n.name)).toEqual(['metal-1']);
  });

  it('purges stored creds to the request roster after a save with no rows', () => {
    const credsPath = stubState();
    const { svc } = makeService();
    svc.putConfig(vmBody([node({ bmc_user: 'root', bmc_pass: 'secret' })]));
    expect(JSON.parse(readFileSync(credsPath, 'utf8'))['metal-1']).toEqual({ user: 'root', pass: 'secret' });

    svc.putConfig(vmBody([], []));

    expect(JSON.parse(readFileSync(credsPath, 'utf8'))['metal-1']).toBeUndefined();
  });
});
