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

  it('derives a vm-only plane set and a null baremetal block when the key is absent', () => {
    writeFleet(
      JSON.stringify({
        network: { name: 'brokkr-net', cidr: '192.168.200.0/24', domain: 'sim', bmc_cidr: '192.168.105.0/24' },
        nodes: [{ name: 'cpu-1', ipmi_mac: 'aa', data_mac: 'bb' }],
      }),
    );
    const fleet = loadFleet();
    expect(fleet.planes).toEqual({ vm: true, baremetal: false });
    expect(fleet.baremetal).toBeNull();
  });

  it('derives both planes off when both rosters are empty', () => {
    writeFleet(
      JSON.stringify({
        network: { name: 'brokkr-net', cidr: '192.168.200.0/24', domain: 'sim', bmc_cidr: '192.168.105.0/24' },
        nodes: [],
        baremetal: { arch: 'amd64', iface: 'enp35s0', iface_ip: '192.168.88.31', nodes: [] },
      }),
    );
    expect(loadFleet().planes).toEqual({ vm: false, baremetal: false });
  });

  it('derives both planes on when a machine sits beside the vm roster and drops a stale mode key', () => {
    writeFleet(
      JSON.stringify({
        mode: 'baremetal',
        network: { name: 'brokkr-net', cidr: '192.168.200.0/24', domain: 'sim', bmc_cidr: '192.168.105.0/24' },
        nodes: [{ name: 'cpu-1', ipmi_mac: 'aa', data_mac: 'bb' }],
        baremetal: {
          arch: 'amd64',
          iface: 'enp35s0',
          iface_ip: '192.168.88.31',
          nodes: [
            { name: 'metal-1', pxe_mac: '9c:6b:00:8d:e8:b4', bmc_ip: '192.168.88.250', bmc_mac: '9c:6b:00:8d:f0:32' },
          ],
        },
      }),
    );
    const fleet = loadFleet();
    expect(fleet.planes).toEqual({ vm: true, baremetal: true });
    expect(fleet).not.toHaveProperty('mode');
  });

  it('parses a bare-metal-only fleet with an empty vm roster and a populated baremetal block', () => {
    writeFleet(
      JSON.stringify({
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
    expect(fleet.planes).toEqual({ vm: false, baremetal: true });
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
