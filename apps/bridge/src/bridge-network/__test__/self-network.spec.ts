import { type NetworkInterfaceInfoIPv4 } from 'node:os';

import { describe, expect, it } from 'vitest';

import {
  deriveDefaultPool,
  discoverIpv4Interfaces,
  resolveServiceInterfaces,
  selfInterfaces,
  selfPrimary,
} from '../self-network';

function ipv4(address: string, netmask: string): NetworkInterfaceInfoIPv4 {
  return {
    address,
    netmask,
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: null,
  };
}

function fakeEnumerate(
  table: Record<string, NetworkInterfaceInfoIPv4[]>,
): () => NodeJS.Dict<NetworkInterfaceInfoIPv4[]> {
  return () => table;
}

describe('discoverIpv4Interfaces', () => {
  it('surfaces netmask, prefix, network and skips loopback/link-local by address', () => {
    const result = discoverIpv4Interfaces(
      fakeEnumerate({
        eth0: [ipv4('192.168.1.50', '255.255.255.0')],
        lo: [ipv4('127.0.0.1', '255.0.0.0')],
        eth1: [ipv4('169.254.10.1', '255.255.0.0')],
      }),
    );
    expect(result).toEqual([
      {
        name: 'eth0',
        ip: '192.168.1.50',
        netmask: '255.255.255.0',
        prefix: 24,
        network: '192.168.1.0/24',
        isPrimary: true,
        interfaceType: 'physical',
      },
    ]);
  });

  it('computes prefix correctly for non-/24 masks', () => {
    const [iface] = discoverIpv4Interfaces(fakeEnumerate({ eth0: [ipv4('10.0.4.7', '255.255.252.0')] }));
    expect(iface.prefix).toBe(22);
    expect(iface.network).toBe('10.0.4.0/22');
  });

  it('excludes IPv6 addresses, keeping only the IPv4 entry on a dual-stack interface', () => {
    const result = discoverIpv4Interfaces(() => ({
      eth0: [
        ipv4('192.168.1.5', '255.255.255.0'),
        {
          address: 'fe80::1',
          netmask: 'ffff:ffff:ffff:ffff::',
          family: 'IPv6',
          mac: '00:00:00:00:00:00',
          internal: false,
          cidr: 'fe80::1/64',
          scopeid: 0,
        },
      ],
    }));
    expect(result.map((i) => ({ name: i.name, ip: i.ip }))).toEqual([{ name: 'eth0', ip: '192.168.1.5' }]);
  });

  it('silently skips an interface with no IPv4 address', () => {
    const result = discoverIpv4Interfaces(fakeEnumerate({ eth0: [ipv4('10.0.0.1', '255.255.255.0')], eth1: [] }));
    expect(result.map((i) => i.name)).toEqual(['eth0']);
  });
});

describe('selfInterfaces clientFacingOnly', () => {
  it('returns the wider unfiltered set by default (docker/wt/IPMI retained)', () => {
    const result = selfInterfaces({}, () =>
      discoverIpv4Interfaces(
        fakeEnumerate({
          docker0: [ipv4('172.17.0.1', '255.255.0.0')],
          eth0: [ipv4('192.168.1.50', '255.255.255.0')],
        }),
      ),
    );
    expect(result.map((i) => i.name)).toEqual(['docker0', 'eth0']);
  });

  it('excludes management/plumbing prefixes when clientFacingOnly', () => {
    const result = selfInterfaces({ clientFacingOnly: true }, () =>
      discoverIpv4Interfaces(
        fakeEnumerate({
          docker0: [ipv4('172.17.0.1', '255.255.0.0')],
          wt0: [ipv4('100.64.0.2', '255.255.255.0')],
          IPMI: [ipv4('10.99.0.5', '255.255.255.0')],
          'br-abc': [ipv4('172.20.0.1', '255.255.255.0')],
          eth0: [ipv4('192.168.1.50', '255.255.255.0')],
        }),
      ),
    );
    expect(result.map((i) => i.name)).toEqual(['eth0']);
  });

  it('excludes lowercase ipmi0/IPMI0 BMC NICs case-insensitively (F1: management-NIC exclusion)', () => {
    const result = selfInterfaces({ clientFacingOnly: true }, () =>
      discoverIpv4Interfaces(
        fakeEnumerate({
          ipmi0: [ipv4('10.99.0.5', '255.255.255.0')],
          IPMI0: [ipv4('10.99.0.6', '255.255.255.0')],
          eth0: [ipv4('192.168.1.50', '255.255.255.0')],
        }),
      ),
    );
    expect(result.map((i) => i.name)).toEqual(['eth0']);
  });

  it('re-stamps isPrimary onto the first client-facing iface when docker/wt/IPMI enumerate FIRST', () => {
    const result = selfInterfaces({ clientFacingOnly: true }, () =>
      discoverIpv4Interfaces(
        fakeEnumerate({
          docker0: [ipv4('172.17.0.1', '255.255.0.0')],
          wt0: [ipv4('100.64.0.2', '255.255.255.0')],
          IPMI: [ipv4('10.99.0.5', '255.255.255.0')],
          eth0: [ipv4('192.168.1.50', '255.255.255.0')],
          eth1: [ipv4('10.0.0.5', '255.255.255.0')],
        }),
      ),
    );
    const primary = result.find((i) => i.isPrimary);
    expect(primary?.name).toBe('eth0');
    expect(result.filter((i) => i.isPrimary)).toHaveLength(1);
  });
});

describe('selfPrimary', () => {
  it('returns the first client-facing iface with mask/prefix/network/broadcast', () => {
    const primary = selfPrimary({ clientFacingOnly: true }, () =>
      discoverIpv4Interfaces(
        fakeEnumerate({
          docker0: [ipv4('172.17.0.1', '255.255.0.0')],
          eth0: [ipv4('192.168.1.50', '255.255.255.0')],
        }),
      ),
    );
    expect(primary).toEqual({
      ip: '192.168.1.50',
      netmask: '255.255.255.0',
      prefix: 24,
      network: '192.168.1.0/24',
      broadcast: '192.168.1.255',
    });
  });

  it('NEVER returns a docker/wt/IPMI iface even when enumerated first', () => {
    const primary = selfPrimary({ clientFacingOnly: true }, () =>
      discoverIpv4Interfaces(
        fakeEnumerate({
          wt0: [ipv4('100.64.0.2', '255.255.255.0')],
          docker0: [ipv4('172.17.0.1', '255.255.0.0')],
          IPMI: [ipv4('10.99.0.5', '255.255.255.0')],
          eth0: [ipv4('192.168.10.20', '255.255.255.0')],
        }),
      ),
    );
    expect(primary?.ip).toBe('192.168.10.20');
  });

  it('returns null when no client-facing interface exists', () => {
    const primary = selfPrimary({ clientFacingOnly: true }, () =>
      discoverIpv4Interfaces(fakeEnumerate({ docker0: [ipv4('172.17.0.1', '255.255.0.0')] })),
    );
    expect(primary).toBeNull();
  });

  it('computes broadcast for a /22', () => {
    const primary = selfPrimary({ clientFacingOnly: true }, () =>
      discoverIpv4Interfaces(fakeEnumerate({ eth0: [ipv4('10.0.4.7', '255.255.252.0')] })),
    );
    expect(primary?.broadcast).toBe('10.0.7.255');
  });
});

describe('deriveDefaultPool', () => {
  it('returns [N+1 .. B-1] for a /24', () => {
    const pool = deriveDefaultPool({
      ip: '192.168.1.50',
      netmask: '255.255.255.0',
      prefix: 24,
      network: '192.168.1.0/24',
      broadcast: '192.168.1.255',
    });
    expect(pool).toEqual({ rangeStart: '192.168.1.1', rangeEnd: '192.168.1.254' });
  });

  it('returns null for /22', () => {
    expect(
      deriveDefaultPool({
        ip: '10.0.4.7',
        netmask: '255.255.252.0',
        prefix: 22,
        network: '10.0.4.0/22',
        broadcast: '10.0.7.255',
      }),
    ).toBeNull();
  });

  it('returns null for /31', () => {
    expect(
      deriveDefaultPool({
        ip: '10.0.0.0',
        netmask: '255.255.255.254',
        prefix: 31,
        network: '10.0.0.0/31',
        broadcast: '10.0.0.1',
      }),
    ).toBeNull();
  });

  it('returns null for /32', () => {
    expect(
      deriveDefaultPool({
        ip: '10.0.0.5',
        netmask: '255.255.255.255',
        prefix: 32,
        network: '10.0.0.5/32',
        broadcast: '10.0.0.5',
      }),
    ).toBeNull();
  });
});

describe('resolveServiceInterfaces', () => {
  it('returns client-facing interfaces (pass-through to selfInterfaces)', () => {
    const result = resolveServiceInterfaces(() =>
      discoverIpv4Interfaces(
        fakeEnumerate({
          docker0: [ipv4('172.17.0.1', '255.255.0.0')],
          eth0: [ipv4('192.168.1.50', '255.255.255.0')],
          eth1: [ipv4('10.0.0.5', '255.255.255.0')],
        }),
      ),
    );
    expect(result.map((i) => i.name)).toEqual(['eth0', 'eth1']);
    expect(result[0].isPrimary).toBe(true);
  });

  it('returns an empty list when no client-facing interfaces exist', () => {
    const result = resolveServiceInterfaces(() =>
      discoverIpv4Interfaces(fakeEnumerate({ docker0: [ipv4('172.17.0.1', '255.255.0.0')] })),
    );
    expect(result).toEqual([]);
  });

  it('returns all client-facing interfaces (no env pinning)', () => {
    const result = resolveServiceInterfaces(() =>
      discoverIpv4Interfaces(
        fakeEnumerate({
          eth0: [ipv4('192.168.1.50', '255.255.255.0')],
          eth1: [ipv4('10.0.0.5', '255.255.255.0')],
        }),
      ),
    );
    expect(result.map((i) => i.name)).toEqual(['eth0', 'eth1']);
  });
});
