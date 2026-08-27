import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BadRequestException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FleetTopologyService } from '../fleet-topology.service';

type WithHost = { hostFacts: () => { os: string } };

function makeService() {
  const setFleetConfig = vi.fn().mockReturnValue([]);
  const overlay = {
    setFleetConfig,
    fleetMode: () => 'baremetal',
    baremetalConfig: () => null,
    fleetConfig: () => null,
    fleetZones: () => ['sim-zone'],
    fleetCustomized: () => true,
  };
  const svc = new FleetTopologyService({} as never, overlay as never, {} as never);
  vi.spyOn(svc as unknown as WithHost, 'hostFacts').mockReturnValue({ os: 'linux' });
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

const body = (nodes: ReturnType<typeof node>[]) => ({
  mode: 'baremetal' as const,
  nodes: [],
  bmcDefaults: undefined,
  baremetal: { nics: ['enp35s0'], arch: 'amd64' as const, bmcDefaults: { username: '', password: '' }, nodes },
});

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

  it('rejects an empty roster in bare-metal mode', () => {
    const { svc } = makeService();
    expect(() => svc.putConfig(body([]))).toThrow(/at least one/);
  });

  it('still rejects an empty machine name in bare-metal mode', () => {
    const { svc } = makeService();
    expect(() => svc.putConfig(body([node({ name: '' })]))).toThrow(BadRequestException);
  });

  it('strips creds from the overlay handoff and writes them 0600, merged', () => {
    vi.stubEnv('DEVENV_STATE', mkdtempSync(join(tmpdir(), 'lab-state-')));
    const { svc, setFleetConfig } = makeService();
    svc.putConfig(body([node({ bmc_user: 'root', bmc_pass: 'secret' })]));

    const arg = setFleetConfig.mock.calls[0][0];
    expect(arg.baremetal.nodes[0].spec).toMatchObject({ bmc_ip: '192.168.1.50' });
    expect(JSON.stringify(arg.baremetal)).not.toContain('secret');

    const credsPath = join(process.env.DEVENV_STATE!, 'baremetal', 'bmc-creds.json');
    const creds = JSON.parse(readFileSync(credsPath, 'utf8'));
    expect(creds['metal-1']).toEqual({ user: 'root', pass: 'secret' });
  });
});

describe('FleetTopologyService.putConfig — vm-mode skips bare-metal validation', () => {
  const vmNode = {
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
  const vmBody = (nodes: ReturnType<typeof node>[]) => ({
    mode: 'vm' as const,
    nodes: [vmNode],
    bmcDefaults: undefined,
    baremetal: { nics: [], arch: 'amd64' as const, bmcDefaults: { username: '', password: '' }, nodes },
  });

  it('persists a malformed BM draft (invalid PXE MAC, no uplink NIC) without throwing', () => {
    vi.stubEnv('DEVENV_STATE', mkdtempSync(join(tmpdir(), 'lab-state-')));
    const { svc, setFleetConfig } = makeService();
    expect(() => svc.putConfig(vmBody([node({ pxe_mac: 'nope' })]))).not.toThrow();
    const arg = setFleetConfig.mock.calls[0][0];
    expect(arg.mode).toBe('vm');
    expect(arg.baremetal.nodes[0].name).toBe('metal-1');
  });

  it('persists an empty-uplink BM draft in vm mode (bm-mode would reject it)', () => {
    vi.stubEnv('DEVENV_STATE', mkdtempSync(join(tmpdir(), 'lab-state-')));
    const { svc } = makeService();
    expect(() => svc.putConfig(vmBody([]))).not.toThrow();
  });

  it('still enforces the reserved `defaults` name guard in vm mode (protects the creds slot)', () => {
    vi.stubEnv('DEVENV_STATE', mkdtempSync(join(tmpdir(), 'lab-state-')));
    const { svc } = makeService();
    expect(() => svc.putConfig(vmBody([node({ name: 'defaults' })]))).toThrow(/reserved/);
  });

  it('persists a save whose only BM draft row has an empty name (bug: VM save rejected empty BM names)', () => {
    vi.stubEnv('DEVENV_STATE', mkdtempSync(join(tmpdir(), 'lab-state-')));
    const { svc, setFleetConfig } = makeService();
    expect(() => svc.putConfig(vmBody([node({ name: '' })]))).not.toThrow();
    const arg = setFleetConfig.mock.calls[0][0];
    expect(arg.baremetal.nodes.some((n: { name: string }) => n.name === '')).toBe(false);
  });

  it('keeps a well-formed BM draft alongside a skipped empty-name row in vm mode', () => {
    vi.stubEnv('DEVENV_STATE', mkdtempSync(join(tmpdir(), 'lab-state-')));
    const { svc, setFleetConfig } = makeService();
    expect(() =>
      svc.putConfig(
        vmBody([
          node({ name: '' }),
          node({ name: 'metal-1', bmc_mac: 'aa:bb:cc:dd:ee:03', pxe_mac: 'aa:bb:cc:dd:ee:04' }),
        ]),
      ),
    ).not.toThrow();
    const arg = setFleetConfig.mock.calls[0][0];
    expect(arg.baremetal.nodes.map((n: { name: string }) => n.name)).toEqual(['metal-1']);
  });

  it('does not purge stored bm creds when a draft row name is cleared in vm mode', () => {
    vi.stubEnv('DEVENV_STATE', mkdtempSync(join(tmpdir(), 'lab-state-')));
    const { svc } = makeService();
    const credsPath = join(process.env.DEVENV_STATE!, 'baremetal', 'bmc-creds.json');
    svc.putConfig(vmBody([node({ bmc_user: 'root', bmc_pass: 'secret' })]));
    expect(JSON.parse(readFileSync(credsPath, 'utf8'))['metal-1']).toEqual({ user: 'root', pass: 'secret' });
    svc.putConfig(vmBody([node({ name: '', bmc_user: '', bmc_pass: '' })]));
    expect(JSON.parse(readFileSync(credsPath, 'utf8'))['metal-1']).toEqual({ user: 'root', pass: 'secret' });
  });
});
