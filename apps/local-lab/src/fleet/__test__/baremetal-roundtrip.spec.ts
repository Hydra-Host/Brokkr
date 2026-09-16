import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BareMetalConfigSchema } from '@repo/local-lab-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FleetTopologyService } from '../fleet-topology.service';

type WithHost = { hostFacts: () => { os: string } };
type Mirror = { nics: string[]; arch: string; nodes: Record<string, Record<string, unknown>> };

function makeService() {
  const mirror: { val: Mirror | null } = { val: null };
  const setFleetConfig = vi.fn().mockReturnValue([]);
  const overlay = {
    setFleetConfig,
    fleetMode: () => 'baremetal',
    baremetalConfig: () => mirror.val,
    fleetConfig: () => null,
    fleetZones: () => ['sim-zone'],
    fleetCustomized: () => true,
  };
  const svc = new FleetTopologyService({} as never, overlay as never, {} as never);
  vi.spyOn(svc as unknown as WithHost, 'hostFacts').mockReturnValue({ os: 'linux' });
  return { svc, setFleetConfig, mirror };
}

const node = (over: Record<string, unknown> = {}) => ({
  name: 'metal-1',
  bmc_ip: '192.168.1.50',
  bmc_mac: 'aa:bb:cc:dd:ee:01',
  pxe_mac: 'aa:bb:cc:dd:ee:02',
  arch: null,
  system_id: null,
  zone: null,
  network_type: null,
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

function saveAndReload(nodes: ReturnType<typeof node>[]) {
  vi.stubEnv('DEVENV_STATE', mkdtempSync(join(tmpdir(), 'lab-state-')));
  const { svc, setFleetConfig, mirror } = makeService();
  svc.putConfig(body(nodes));
  const arg = setFleetConfig.mock.calls[0][0];
  mirror.val = {
    nics: arg.baremetal.nics,
    arch: arg.baremetal.arch,
    nodes: Object.fromEntries(
      arg.baremetal.nodes.map((n: { name: string; spec: Record<string, unknown> }) => [n.name, n.spec]),
    ),
  };
  return svc.baremetalView();
}

afterEach(() => vi.unstubAllEnvs());

describe('bare-metal zone and network_type round-trip', () => {
  it('reads back both fields a save carried', () => {
    const view = saveAndReload([node({ zone: 'sim-zone2', network_type: 'nat' })]);
    expect(view.nodes[0]).toMatchObject({ name: 'metal-1', zone: 'sim-zone2', network_type: 'nat' });
  });

  it('reads back null for both when the save omitted them', () => {
    const view = saveAndReload([node()]);
    expect(view.nodes[0]).toMatchObject({ zone: null, network_type: null });
  });

  it('parses an overlay written before either field existed', () => {
    const { svc, mirror } = makeService();
    mirror.val = {
      nics: ['enp35s0'],
      arch: 'amd64',
      nodes: {
        'metal-1': { bmc_ip: '192.168.1.50', bmc_mac: 'aa:bb:cc:dd:ee:01', pxe_mac: 'aa:bb:cc:dd:ee:02' },
      },
    };
    const view = BareMetalConfigSchema.parse(svc.baremetalView());
    expect(view.nodes[0]).toMatchObject({ name: 'metal-1', zone: null, network_type: null });
  });

  it('reads back null for an unknown network_type string in the overlay', () => {
    const { svc, mirror } = makeService();
    mirror.val = {
      nics: ['enp35s0'],
      arch: 'amd64',
      nodes: {
        'metal-1': {
          bmc_ip: '192.168.1.50',
          bmc_mac: 'aa:bb:cc:dd:ee:01',
          pxe_mac: 'aa:bb:cc:dd:ee:02',
          network_type: 'bridged',
        },
      },
    };
    const view = BareMetalConfigSchema.parse(svc.baremetalView());
    expect(view.nodes[0]).toMatchObject({ name: 'metal-1', network_type: null });
  });
});
