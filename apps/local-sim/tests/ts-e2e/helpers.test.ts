import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { loadFleet } from './helpers';

describe('loadFleet', () => {
  const prev = process.env.LOCAL_FLEET_PATH;
  let dir: string | null = null;

  afterEach(() => {
    if (prev === undefined) delete process.env.LOCAL_FLEET_PATH;
    else process.env.LOCAL_FLEET_PATH = prev;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function writeFleet(content: string): void {
    dir = mkdtempSync(join(tmpdir(), 'fleet-'));
    const filePath = join(dir, 'fleet.yaml');
    writeFileSync(filePath, content);
    process.env.LOCAL_FLEET_PATH = filePath;
  }

  it('parses a valid minimal fleet and strips unknown node keys', () => {
    writeFleet(
      JSON.stringify({
        network: { name: 'brokkr-net', cidr: '192.168.200.0/24', domain: 'sim', bmc_cidr: '192.168.105.0/24' },
        nodes: [{ name: 'cpu-1', ipmi_mac: 'aa', data_mac: 'bb', bogus: 'x', disks: [{ size_gb: 1 }] }],
      }),
    );
    const fleet = loadFleet();
    expect(fleet.nodes).toHaveLength(1);
    expect(fleet.nodes[0]).toEqual({ name: 'cpu-1', ipmi_mac: 'aa', data_mac: 'bb', ip: null, bmc_ip: null });
    expect(fleet.nodes[0]).not.toHaveProperty('bogus');
  });

  it('defaults mode to vm and baremetal to null when the keys are absent', () => {
    writeFleet(
      JSON.stringify({
        network: { name: 'brokkr-net', cidr: '192.168.200.0/24', domain: 'sim', bmc_cidr: '192.168.105.0/24' },
        nodes: [{ name: 'cpu-1', ipmi_mac: 'aa', data_mac: 'bb' }],
      }),
    );
    const fleet = loadFleet();
    expect(fleet.mode).toBe('vm');
    expect(fleet.baremetal).toBeNull();
  });

  it('parses a baremetal fleet with an empty vm roster and a populated baremetal block', () => {
    writeFleet(
      JSON.stringify({
        mode: 'baremetal',
        network: { name: 'brokkr-net', cidr: '192.168.200.0/24', domain: 'sim.local', bmc_cidr: '192.168.105.0/24' },
        nodes: [],
        baremetal: {
          arch: 'amd64',
          iface: 'enp35s0',
          iface_ip: '192.168.88.31',
          nodes: [
            {
              name: 'metal-1',
              pxe_mac: '9c:6b:00:8d:e8:b4',
              bmc_ip: '192.168.88.250',
              bmc_mac: '9c:6b:00:8d:f0:32',
              arch: 'amd64',
              zone: 'sim-zone',
            },
          ],
        },
      }),
    );
    const fleet = loadFleet();
    expect(fleet.mode).toBe('baremetal');
    expect(fleet.nodes).toHaveLength(0);
    expect(fleet.baremetal?.iface_ip).toBe('192.168.88.31');
    expect(fleet.baremetal?.nodes[0]).toEqual({
      name: 'metal-1',
      pxe_mac: '9c:6b:00:8d:e8:b4',
      bmc_ip: '192.168.88.250',
      bmc_mac: '9c:6b:00:8d:f0:32',
      arch: 'amd64',
      zone: 'sim-zone',
      system_id: null,
    });
  });

  it('throws a ZodError when a node is missing name', () => {
    writeFleet(
      JSON.stringify({
        network: { name: 'n', cidr: 'c', domain: 'd', bmc_cidr: 'b' },
        nodes: [{ ipmi_mac: 'aa', data_mac: 'bb' }],
      }),
    );
    expect(() => loadFleet()).toThrow(ZodError);
  });

  it('throws when LOCAL_FLEET_PATH is unset', () => {
    delete process.env.LOCAL_FLEET_PATH;
    expect(() => loadFleet()).toThrow('LOCAL_FLEET_PATH env var is required');
  });
});
