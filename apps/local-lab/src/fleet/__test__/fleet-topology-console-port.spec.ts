import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FleetNodeEffectiveSchema,
  FleetNodeSchema,
  type FleetNode,
  type FleetNodeEffective,
} from '@repo/local-lab-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FleetTopologyService } from '../fleet-topology.service';

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'lab-console-port-'));
  vi.stubEnv('DEVENV_STATE', stateDir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

const svcFor = (nodes: Record<string, Record<string, unknown>>) => {
  const setFleetConfig = vi.fn().mockReturnValue([]);
  const overlay = {
    fleetConfig: () => ({
      network: { cidr: '192.168.201.0/24', bmc_cidr: '192.168.106.0/24' },
      defaults: {},
      nodes,
    }),
    setFleetConfig,
    baremetalConfig: () => null,
    fleetZones: () => ['sim-zone'],
    fleetTombstones: () => [],
    fleetCustomized: () => true,
    fleetMode: () => 'vm',
  };
  const rendered = { renderDesiredFleetYaml: () => Promise.resolve(null) };
  const svc = new FleetTopologyService({ repoRoot: '/repo' } as never, overlay as never, rendered as never);
  return { svc, setFleetConfig };
};

const toWireNode = ({ effective_ip, effective_bmc_ip, ...node }: FleetNodeEffective): FleetNode => {
  void effective_ip;
  void effective_bmc_ip;
  return node;
};

const savedSpec = (setFleetConfig: ReturnType<typeof vi.fn>, name: string): Record<string, unknown> => {
  const entries: { name: string; spec: Record<string, unknown> }[] = setFleetConfig.mock.calls[0][0].nodes;
  const match = entries.find((e) => e.name === name);
  if (!match) throw new Error(`no saved spec for ${name}`);
  return match.spec;
};

const roundTrip = async (nodes: Record<string, Record<string, unknown>>) => {
  const { svc, setFleetConfig } = svcFor(nodes);
  const cfg = await svc.getConfig();
  svc.putConfig({
    mode: cfg.mode,
    nodes: cfg.nodes.map(toWireNode),
    bmcDefaults: cfg.bmcDefaults,
    baremetal: {
      nics: cfg.baremetal.nics,
      arch: cfg.baremetal.arch,
      bmcDefaults: { username: '', password: '' },
      nodes: [],
    },
  });
  return { cfg, setFleetConfig };
};

describe('FleetTopologyService console_port round-trip', () => {
  it('surfaces the slot-derived console_port on the contract-validated read path', async () => {
    const { svc } = svcFor({
      's1-cpu-1': { index: 0, ipmi_mac: '52:54:00:bc:01:01', data_mac: '52:54:00:da:01:01', console_port: 20560 },
    });
    const cfg = await svc.getConfig();
    expect(FleetNodeEffectiveSchema.parse(cfg.nodes[0]).console_port).toBe(20560);
  });

  it('preserves console_port through a get -> put save', async () => {
    const { setFleetConfig } = await roundTrip({
      's1-cpu-1': { index: 0, ipmi_mac: '52:54:00:bc:01:01', data_mac: '52:54:00:da:01:01', console_port: 20560 },
      's1-cpu-2': { index: 1, ipmi_mac: '52:54:00:bc:01:02', data_mac: '52:54:00:da:01:02', console_port: 20561 },
    });
    expect(savedSpec(setFleetConfig, 's1-cpu-1').console_port).toBe(20560);
    expect(savedSpec(setFleetConfig, 's1-cpu-2').console_port).toBe(20561);
  });

  it('leaves a node without a stamp absent rather than backfilling a slot-0 value', async () => {
    const { cfg, setFleetConfig } = await roundTrip({
      'cpu-1': { index: 0, ipmi_mac: '52:54:00:bc:00:01', data_mac: '52:54:00:da:00:01' },
    });
    expect(cfg.nodes[0].console_port).toBeNull();
    expect(savedSpec(setFleetConfig, 'cpu-1')).not.toHaveProperty('console_port');
  });
});

describe('FleetNodeSchema console_port bounds', () => {
  const wireNodeWith = async (console_port: number | null): Promise<FleetNode> => {
    const { svc } = svcFor({
      'cpu-1': { index: 0, ipmi_mac: '52:54:00:bc:00:01', data_mac: '52:54:00:da:00:01' },
    });
    const cfg = await svc.getConfig();
    return { ...toWireNode(cfg.nodes[0]), console_port };
  };

  it('rejects a console_port below 1024', async () => {
    const node = await wireNodeWith(80);
    expect(() => FleetNodeSchema.parse(node)).toThrow();
  });

  it('rejects a console_port above 65535', async () => {
    const node = await wireNodeWith(100000);
    expect(() => FleetNodeSchema.parse(node)).toThrow();
  });

  it('accepts the range endpoints and a null stamp', async () => {
    for (const port of [1024, 65535, null]) {
      const node = await wireNodeWith(port);
      expect(FleetNodeSchema.parse(node).console_port).toBe(port);
    }
  });
});

describe('FleetTopologyService effective console_port collisions', () => {
  it('rejects two nodes sharing an explicit console_port', async () => {
    await expect(
      roundTrip({
        'cpu-1': { index: 0, ipmi_mac: '52:54:00:bc:00:01', data_mac: '52:54:00:da:00:01', console_port: 20560 },
        'cpu-2': { index: 1, ipmi_mac: '52:54:00:bc:00:02', data_mac: '52:54:00:da:00:02', console_port: 20560 },
      }),
    ).rejects.toThrow('cpu-2: console_port 20560 collides with node cpu-1');
  });

  it('rejects an explicit console_port that collides with another node index-derived default', async () => {
    await expect(
      roundTrip({
        'cpu-1': { index: 0, ipmi_mac: '52:54:00:bc:00:01', data_mac: '52:54:00:da:00:01' },
        'cpu-2': { index: 1, ipmi_mac: '52:54:00:bc:00:02', data_mac: '52:54:00:da:00:02', console_port: 9300 },
      }),
    ).rejects.toThrow('cpu-2: console_port 9300 collides with node cpu-1');
  });

  it('accepts stamps that resolve clear of every derived default', async () => {
    const { setFleetConfig } = await roundTrip({
      'cpu-1': { index: 0, ipmi_mac: '52:54:00:bc:00:01', data_mac: '52:54:00:da:00:01' },
      'cpu-2': { index: 1, ipmi_mac: '52:54:00:bc:00:02', data_mac: '52:54:00:da:00:02', console_port: 20561 },
    });
    expect(savedSpec(setFleetConfig, 'cpu-2').console_port).toBe(20561);
  });
});
