import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FleetTopologyService, maskBmcPassword } from '../fleet-topology.service';

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

const putBody = (nodes: ReturnType<typeof vmNode>[], bmcDefaults?: { username: string; password: string }) => ({
  mode: 'vm' as const,
  nodes,
  bmcDefaults,
  baremetal: { nics: [], arch: 'amd64' as const, bmcDefaults: { username: '', password: '' }, nodes: [] },
});

const svcWithStored = (stored: { defaults?: object; nodes?: object }) => {
  const setFleetConfig = vi.fn().mockReturnValue([]);
  const overlay = {
    fleetConfig: () => ({
      network: { cidr: '192.168.200.0/24', bmc_cidr: '192.168.105.0/24' },
      defaults: stored.defaults ?? {},
      nodes: stored.nodes ?? {},
    }),
    setFleetConfig,
    fleetMode: () => 'vm',
    fleetZones: () => ['sim-zone'],
    fleetCustomized: () => true,
  };
  return { svc: new FleetTopologyService({} as never, overlay as never, {} as never), setFleetConfig };
};

describe('FleetTopologyService.putConfig — a masked bmc password means "leave it"', () => {
  it('stores the kept password rather than the mask when the client echoes it back', () => {
    const { svc, setFleetConfig } = svcWithStored({ defaults: { bmc: { username: 'admin', password: 'real' } } });

    svc.putConfig(putBody([vmNode()], { username: 'admin', password: '***' }));

    expect(setFleetConfig).toHaveBeenCalledWith(
      expect.objectContaining({ bmcDefaults: { username: 'admin', password: 'real' } }),
    );
  });

  it('stores a genuinely new password', () => {
    const { svc, setFleetConfig } = svcWithStored({ defaults: { bmc: { username: 'admin', password: 'real' } } });

    svc.putConfig(putBody([vmNode()], { username: 'admin', password: 'fresh' }));

    expect(setFleetConfig).toHaveBeenCalledWith(
      expect.objectContaining({ bmcDefaults: { username: 'admin', password: 'fresh' } }),
    );
  });

  it('resolves a per-node masked password against that node by name', () => {
    const { svc, setFleetConfig } = svcWithStored({
      nodes: { 'vm-1': { ...vmNode(), bmc: { username: 'admin', password: 'node-real' } } },
    });

    svc.putConfig(putBody([vmNode({ bmc: { username: 'admin', password: '***' } })]));

    const spec = setFleetConfig.mock.calls[0][0].nodes[0];
    expect(spec.bmc?.password).not.toBe('***');
  });
});

describe('maskBmcPassword — the read never hands out a bmc credential', () => {
  it('masks a stored password', () => {
    expect(maskBmcPassword('admin')).toBe('***');
  });

  it('leaves an unset password empty so "none" and "hidden" stay distinguishable', () => {
    expect(maskBmcPassword('')).toBe('');
    expect(maskBmcPassword(undefined)).toBe('');
  });
});
