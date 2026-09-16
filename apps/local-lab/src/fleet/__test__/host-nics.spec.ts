import { describe, expect, it, vi } from 'vitest';

import { FleetTopologyService } from '../fleet-topology.service';

const { nics } = vi.hoisted(() => ({
  nics: {
    lo: [
      {
        family: 'IPv4',
        address: '127.0.0.1',
        cidr: '127.0.0.1/8',
        internal: true,
        mac: '00:00:00:00:00:00',
        netmask: '255.0.0.0',
        scopeid: undefined,
      },
    ],
    ens2: [
      {
        family: 'IPv4',
        address: '172.16.12.60',
        cidr: '172.16.12.60/22',
        internal: false,
        mac: 'aa:bb:cc:dd:ee:02',
        netmask: '255.255.252.0',
        scopeid: undefined,
      },
    ],
    wt0: [
      {
        family: 'IPv4',
        address: '100.110.97.148',
        cidr: '100.110.97.148/16',
        internal: false,
        mac: 'aa:bb:cc:dd:ee:03',
        netmask: '255.255.0.0',
        scopeid: undefined,
      },
    ],
    wg0: [
      {
        family: 'IPv4',
        address: '10.100.0.2',
        cidr: '10.100.0.2/24',
        internal: false,
        mac: 'aa:bb:cc:dd:ee:04',
        netmask: '255.255.255.0',
        scopeid: undefined,
      },
    ],
    tailscale0: [
      {
        family: 'IPv4',
        address: '100.64.0.9',
        cidr: '100.64.0.9/32',
        internal: false,
        mac: 'aa:bb:cc:dd:ee:05',
        netmask: '255.255.255.255',
        scopeid: undefined,
      },
    ],
  },
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, platform: () => 'linux', networkInterfaces: () => nics };
});

const makeService = () => new FleetTopologyService({} as never, {} as never, {} as never);

describe('FleetTopologyService.hostNics', () => {
  it('excludes wireguard and netbird interfaces from the uplink picker', () => {
    const names = makeService()
      .hostNics()
      .map((n) => n.name);
    expect(names).toEqual(['ens2']);
    expect(names).not.toContain('wt0');
    expect(names).not.toContain('wg0');
  });

  it('keeps a physical nic with its cidr and mac', () => {
    expect(makeService().hostNics()).toEqual([
      { name: 'ens2', mac: 'aa:bb:cc:dd:ee:02', ipv4: '172.16.12.60/22', up: true },
    ]);
  });
});
