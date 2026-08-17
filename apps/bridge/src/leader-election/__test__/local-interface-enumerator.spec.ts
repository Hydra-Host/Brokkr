import type { NetworkInterfaceInfoIPv4, NetworkInterfaceInfoIPv6 } from 'node:os';

import { describe, expect, it, vi } from 'vitest';

import { subnetMatchEntries } from '../../bridge-network/bridge-registry-reader';
import {
  OsNetworkInterfaceEnumerator,
  defaultGatewaysFromProc,
  ipv4Network,
  netmaskToPrefix,
  routedEntriesFromProc,
} from '../local-interface-enumerator';

describe('netmaskToPrefix', () => {
  it.each([
    ['255.255.255.0', 24],
    ['255.255.0.0', 16],
    ['255.0.0.0', 8],
    ['255.255.255.255', 32],
    ['0.0.0.0', 0],
    ['255.255.255.128', 25],
  ])('converts contiguous mask %s -> /%i', (mask, prefix) => {
    expect(netmaskToPrefix(mask)).toBe(prefix);
  });

  it.each([['255.0.255.0'], ['255.255.0.255'], ['255.255.255'], ['255.255.255.256'], ['abc']])(
    'rejects invalid mask %s',
    (mask) => {
      expect(netmaskToPrefix(mask)).toBeNull();
    },
  );
});

describe('ipv4Network', () => {
  it('masks the host bits to the network address (not the input host address)', () => {
    expect(ipv4Network('10.0.0.5', 24)).toBe('10.0.0.0/24');
    expect(ipv4Network('10.0.0.5', 24)).not.toBe('10.0.0.5/24');
  });

  it.each([
    ['192.168.1.130', 25, '192.168.1.128/25'],
    ['172.16.5.9', 16, '172.16.0.0/16'],
    ['10.1.2.3', 32, '10.1.2.3/32'],
    ['10.1.2.3', 0, '0.0.0.0/0'],
  ])('ipv4Network(%s, %i) -> %s', (ip, prefix, expected) => {
    expect(ipv4Network(ip, prefix)).toBe(expected);
  });

  it('rejects out-of-range prefixes and malformed ips', () => {
    expect(ipv4Network('10.0.0.1', 33)).toBeNull();
    expect(ipv4Network('10.0.0.1', -1)).toBeNull();
    expect(ipv4Network('10.0.0', 24)).toBeNull();
  });
});

const ipv4 = (over: Partial<NetworkInterfaceInfoIPv4> = {}): NetworkInterfaceInfoIPv4 => ({
  address: '10.0.0.5',
  netmask: '255.255.255.0',
  family: 'IPv4',
  mac: 'aa:bb:cc:dd:ee:ff',
  internal: false,
  cidr: '10.0.0.5/24',
  ...over,
});

const ipv6 = (over: Partial<NetworkInterfaceInfoIPv6> = {}): NetworkInterfaceInfoIPv6 => ({
  address: 'fe80::1',
  netmask: 'ffff:ffff:ffff:ffff::',
  family: 'IPv6',
  mac: 'aa:bb:cc:dd:ee:ff',
  internal: false,
  cidr: 'fe80::1/64',
  scopeid: 0,
  ...over,
});

describe('OsNetworkInterfaceEnumerator.enumerate', () => {
  it('emits the wire-locked network address (not the host ip) for a real interface', async () => {
    const enumerator = new OsNetworkInterfaceEnumerator(() => ({
      eth0: [ipv4({ address: '10.0.0.5', netmask: '255.255.255.0' })],
    }));

    const entries = await enumerator.enumerate();

    expect(entries).toEqual([{ iface: 'eth0', mac: 'aa:bb:cc:dd:ee:ff', subnet: '10.0.0.0/24', ip: '10.0.0.5' }]);
  });

  it('filters lo/docker/br-/veth and skips IPv6 deterministically', async () => {
    const enumerator = new OsNetworkInterfaceEnumerator(() => ({
      lo: [ipv4({ address: '127.0.0.1', netmask: '255.0.0.0', internal: true })],
      docker0: [ipv4({ address: '172.17.0.1', netmask: '255.255.0.0' })],
      'br-abc123': [ipv4({ address: '172.18.0.1', netmask: '255.255.0.0' })],
      veth9f: [ipv4({ address: '169.254.0.1', netmask: '255.255.0.0' })],
      eth0: [ipv6(), ipv4({ address: '192.168.1.50', netmask: '255.255.255.0' })],
    }));

    const entries = await enumerator.enumerate();

    expect(entries).toEqual([
      { iface: 'eth0', mac: 'aa:bb:cc:dd:ee:ff', subnet: '192.168.1.0/24', ip: '192.168.1.50' },
    ]);
  });

  it('drops addresses whose netmask is non-contiguous', async () => {
    const enumerator = new OsNetworkInterfaceEnumerator(() => ({
      eth0: [ipv4({ address: '10.0.0.5', netmask: '255.0.255.0' })],
    }));

    expect(await enumerator.enumerate()).toEqual([]);
  });
});

describe('routedEntriesFromProc', () => {
  const PROC_NET_ROUTE = [
    'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT',
    'enp131s0f0np0\t00000000\t0100020A\t0003\t0\t0\t101\t00000000\t0\t0\t0',
    'enp131s0f0np0\t0000020A\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0',
    'enp131s0f0np0\t0000090A\t0100020A\t0003\t0\t0\t0\t0000FFFF\t0\t0\t0',
    '',
  ].join('\n');

  it('registers a routed supernet with its egress interface IP and gateway', () => {
    const entries = routedEntriesFromProc(
      PROC_NET_ROUTE,
      { enp131s0f0np0: [{ ip: '10.2.0.4', prefix: 16 }] },
      { enp131s0f0np0: 'aa:bb:cc:dd:ee:ff' },
    );
    expect(entries).toEqual([
      {
        iface: 'enp131s0f0np0',
        mac: 'aa:bb:cc:dd:ee:ff',
        subnet: '10.9.0.0/16',
        ip: '10.2.0.4',
        gateway: '10.2.0.1',
        routed: true,
      },
    ]);
  });

  it('matches a client reachable only via the routed supernet, not a connected subnet', () => {
    const entries = routedEntriesFromProc(PROC_NET_ROUTE, { enp131s0f0np0: [{ ip: '10.2.0.4', prefix: 16 }] }, {});
    const snapshot: [string, unknown][] = [['bridge-1768-317-223-2776', entries]];
    expect(subnetMatchEntries(snapshot, '10.9.1.6')).toEqual([['10.2.0.4', 'bridge-1768-317-223-2776']]);
  });

  it('contacts a multi-homed egress NIC via the IP on the gateway’s connected subnet', () => {
    const entries = routedEntriesFromProc(
      PROC_NET_ROUTE,
      {
        enp131s0f0np0: [
          { ip: '192.168.1.5', prefix: 24 },
          { ip: '10.2.0.4', prefix: 16 },
        ],
      },
      {},
    );
    expect(entries).toEqual([
      { iface: 'enp131s0f0np0', mac: '', subnet: '10.9.0.0/16', ip: '10.2.0.4', gateway: '10.2.0.1', routed: true },
    ]);
  });

  it('skips a route when its egress interface has no assigned IP', () => {
    expect(routedEntriesFromProc(PROC_NET_ROUTE, {}, {})).toEqual([]);
  });

  it('skips default and connected routes', () => {
    const table = [
      'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT',
      'eno8303\t00000000\t117D50CE\t0003\t0\t0\t0\t00000000\t0\t0\t0',
      'enp131s0f0np0\t0000020A\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0',
      '',
    ].join('\n');
    expect(
      routedEntriesFromProc(
        table,
        { enp131s0f0np0: [{ ip: '10.2.0.4', prefix: 16 }], eno8303: [{ ip: '10.100.0.2', prefix: 24 }] },
        {},
      ),
    ).toEqual([]);
  });

  it('skips split-default routes that cover unrelated clients', () => {
    const table = [
      'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT',
      'wg0\t00000000\t0100020A\t0003\t0\t0\t0\t00000080\t0\t0\t0',
      'wg0\t00000080\t0100020A\t0003\t0\t0\t0\t00000080\t0\t0\t0',
      'enp131s0f0np0\t0000090A\t0100020A\t0003\t0\t0\t0\t0000FFFF\t0\t0\t0',
      '',
    ].join('\n');
    expect(
      routedEntriesFromProc(
        table,
        { wg0: [{ ip: '10.7.0.2', prefix: 24 }], enp131s0f0np0: [{ ip: '10.2.0.4', prefix: 16 }] },
        {},
      ),
    ).toEqual([
      { iface: 'enp131s0f0np0', mac: '', subnet: '10.9.0.0/16', ip: '10.2.0.4', gateway: '10.2.0.1', routed: true },
    ]);
  });
});

describe('defaultGatewaysFromProc', () => {
  it('parses a default route gateway', () => {
    const table = [
      'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT',
      'eth0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0',
      '',
    ].join('\n');
    expect(defaultGatewaysFromProc(table)).toEqual(new Map([['eth0', '192.168.1.1']]));
  });

  it('returns different gateways per interface', () => {
    const table = [
      'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT',
      'eth0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0',
      'eth1\t00000000\t010AA8C0\t0003\t0\t0\t200\t00000000\t0\t0\t0',
      '',
    ].join('\n');
    const result = defaultGatewaysFromProc(table);
    expect(result.get('eth0')).toBe('192.168.1.1');
    expect(result.get('eth1')).toBe('192.168.10.1');
  });

  it('returns empty map when no default route exists', () => {
    const table = [
      'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT',
      'eth0\t0000020A\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0',
      '',
    ].join('\n');
    expect(defaultGatewaysFromProc(table)).toEqual(new Map());
  });

  it('skips connected routes (gateway 00000000)', () => {
    const table = [
      'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT',
      'eth0\t00000000\t00000000\t0001\t0\t0\t0\t00000000\t0\t0\t0',
      '',
    ].join('\n');
    expect(defaultGatewaysFromProc(table)).toEqual(new Map());
  });

  it('keeps the first gateway when an interface has multiple default routes', () => {
    const table = [
      'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT',
      'eth0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0',
      'eth0\t00000000\t0201A8C0\t0003\t0\t0\t200\t00000000\t0\t0\t0',
      '',
    ].join('\n');
    expect(defaultGatewaysFromProc(table)).toEqual(new Map([['eth0', '192.168.1.1']]));
  });
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn() };
});

describe('OsNetworkInterfaceEnumerator.enumerate with mocked route table', () => {
  it('attaches default gateway to the connected entry whose subnet contains it', async () => {
    const { readFile } = await import('node:fs/promises');
    const table = [
      'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT',
      'eth0\t00000000\t0100A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0',
      'eth0\t00A8C000\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0',
      '',
    ].join('\n');
    vi.mocked(readFile).mockResolvedValue(table);

    const enumerator = new OsNetworkInterfaceEnumerator(() => ({
      eth0: [ipv4({ address: '192.168.0.5', netmask: '255.255.255.0' })],
    }));

    const entries = await enumerator.enumerate();

    const connectedEntry = entries.find((e) => e.subnet === '192.168.0.0/24');
    expect(connectedEntry).toBeDefined();
    expect(connectedEntry?.gateway).toBe('192.168.0.1');
  });

  it('does not attach default gateway to a subnet that does not contain it', async () => {
    const { readFile } = await import('node:fs/promises');
    const table = [
      'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT',
      'eth0\t00000000\t0100000A\t0003\t0\t0\t100\t00000000\t0\t0\t0',
      '',
    ].join('\n');
    vi.mocked(readFile).mockResolvedValue(table);

    const enumerator = new OsNetworkInterfaceEnumerator(() => ({
      eth0: [
        ipv4({ address: '10.0.0.5', netmask: '255.255.255.0' }),
        ipv4({ address: '172.16.0.5', netmask: '255.255.0.0' }),
      ],
    }));

    const entries = await enumerator.enumerate();

    const matched = entries.find((e) => e.subnet === '10.0.0.0/24');
    expect(matched?.gateway).toBe('10.0.0.1');

    const unmatched = entries.find((e) => e.subnet === '172.16.0.0/16');
    expect(unmatched?.gateway).toBeUndefined();
  });
});
