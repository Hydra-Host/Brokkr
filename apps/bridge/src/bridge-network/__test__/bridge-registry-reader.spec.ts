import { describe, expect, it } from 'vitest';

import { getLeaderConfig } from '../../leader-election/leader-election.config';
import {
  getBridgeRegistrySnapshot,
  getPeerClientFacingIpv4,
  missingBridgeHostnames,
  subnetMatchEntries,
  type BridgeRegistrySnapshot,
  type RegistryRedis,
} from '../bridge-registry-reader';

interface RegistryHash {
  instance_id: string;
  interfaces: unknown;
}

function fakeRegistryRedis(instances: RegistryHash[]): RegistryRedis {
  return fakeRawRegistryRedis(
    instances.map((instance) => ({
      instance_id: instance.instance_id,
      interfaces_json: JSON.stringify(instance.interfaces),
    })),
  );
}

function fakeRawRegistryRedis(instances: { instance_id: string; interfaces_json: string }[]): RegistryRedis {
  const prefix = getLeaderConfig().registryKeyPrefix;
  const byKey = new Map(instances.map((i) => [`${prefix}${i.instance_id}`, i]));
  return {
    async scan(): Promise<string[]> {
      return [...byKey.keys()];
    },
    async hgetall(key: string): Promise<Record<string, string>> {
      const hit = byKey.get(key);
      if (!hit) return {};
      return { instance_id: hit.instance_id, interfaces_json: hit.interfaces_json };
    },
  };
}

describe('getBridgeRegistrySnapshot', () => {
  it('keeps a bridge with malformed interfaces JSON and uses an empty list', async () => {
    const redis = fakeRawRegistryRedis([{ instance_id: 'bridge-a', interfaces_json: '{bad' }]);

    expect(await getBridgeRegistrySnapshot(redis)).toEqual([['bridge-a', []]]);
  });

  it.each(['null', '{}', '"invalid"', '42'])(
    'uses an empty list for valid non-list interfaces JSON %s',
    async (interfacesJson) => {
      const redis = fakeRawRegistryRedis([{ instance_id: 'bridge-a', interfaces_json: interfacesJson }]);

      expect(await getBridgeRegistrySnapshot(redis)).toEqual([['bridge-a', []]]);
    },
  );
});

describe('subnetMatchEntries', () => {
  it('returns subnet matched ips for both bridges', () => {
    const snapshot: BridgeRegistrySnapshot = [
      [
        'bridge-9-57-16-231',
        [
          { iface: 'eth0', mac: 'aa', subnet: '10.0.0.0/24', ip: '10.0.0.231' },
          { iface: 'eth1', mac: 'bb', subnet: '172.16.0.0/16', ip: '172.16.0.231' },
        ],
      ],
      [
        'bridge-9-57-16-232',
        [
          { iface: 'eth0', mac: 'cc', subnet: '10.0.0.0/24', ip: '10.0.0.232' },
          { iface: 'eth1', mac: 'dd', subnet: '172.16.0.0/16', ip: '172.16.0.232' },
        ],
      ],
    ];
    expect(subnetMatchEntries(snapshot, '10.0.0.50')).toEqual([
      ['10.0.0.231', 'bridge-9-57-16-231'],
      ['10.0.0.232', 'bridge-9-57-16-232'],
    ]);
  });

  it('skips bridges with no matching subnet when no fallback address is given', () => {
    const snapshot: BridgeRegistrySnapshot = [
      ['bridge-on-other-subnet', [{ iface: 'eth0', mac: 'aa', subnet: '192.168.1.0/24', ip: '192.168.1.10' }]],
      ['bridge-on-our-subnet', [{ iface: 'eth0', mac: 'bb', subnet: '10.0.0.0/24', ip: '10.0.0.232' }]],
    ];
    expect(subnetMatchEntries(snapshot, '10.0.0.50')).toEqual([['10.0.0.232', 'bridge-on-our-subnet']]);
  });

  it("gives a /30 inband-mgmt client every bridge on the serving bridge's subnet (VPC zones)", () => {
    // Real Kyndryl OH shape: the OOB LAN (eno8303) is listed first and is not routable from hosts;
    // the client reaches the serving bridge at 10.2.0.2, so peers are resolved on that subnet.
    const snapshot: BridgeRegistrySnapshot = [
      [
        'bridge-2247-334-242-3427',
        [
          { iface: 'eno8303', mac: '00', subnet: '192.168.105.0/24', ip: '192.168.105.33' },
          { iface: 'wt0', mac: '01', subnet: '100.125.0.0/16', ip: '100.125.151.144' },
          { iface: 'eth3', mac: 'aa', subnet: '10.2.0.0/16', ip: '10.2.0.2' },
          { iface: 'eth4', mac: 'bb', subnet: '10.100.0.0/16', ip: '10.100.0.1' },
        ],
      ],
      [
        'bridge-2247-334-242-3428',
        [
          { iface: 'eno8303', mac: '02', subnet: '192.168.105.0/24', ip: '192.168.105.215' },
          { iface: 'eth3', mac: 'cc', subnet: '10.2.0.0/16', ip: '10.2.0.3' },
          { iface: 'eth4', mac: 'dd', subnet: '10.100.0.0/16', ip: '10.100.0.3' },
        ],
      ],
    ];
    expect(subnetMatchEntries(snapshot, '10.9.0.210', '10.2.0.2')).toEqual([
      ['10.2.0.2', 'bridge-2247-334-242-3427'],
      ['10.2.0.3', 'bridge-2247-334-242-3428'],
    ]);
  });

  it('prefers the client-subnet interface over the fallback subnet per bridge', () => {
    const snapshot: BridgeRegistrySnapshot = [
      [
        'bridge-both',
        [
          { iface: 'eth3', mac: 'aa', subnet: '10.2.0.0/16', ip: '10.2.0.2' },
          { iface: 'eth5', mac: 'bb', subnet: '10.0.0.0/24', ip: '10.0.0.2' },
        ],
      ],
      ['bridge-fallback-only', [{ iface: 'eth3', mac: 'cc', subnet: '10.2.0.0/16', ip: '10.2.0.3' }]],
    ];
    expect(subnetMatchEntries(snapshot, '10.0.0.50', '10.2.0.2')).toEqual([
      ['10.0.0.2', 'bridge-both'],
      ['10.2.0.3', 'bridge-fallback-only'],
    ]);
  });

  it('ignores a non-routable fallback address', () => {
    const snapshot: BridgeRegistrySnapshot = [
      ['bridge-on-other-subnet', [{ iface: 'eth0', mac: 'aa', subnet: '192.168.1.0/24', ip: '192.168.1.10' }]],
    ];
    expect(subnetMatchEntries(snapshot, '10.0.0.50', '127.0.0.1')).toEqual([]);
  });

  it('picks the first matching interface per bridge', () => {
    const snapshot: BridgeRegistrySnapshot = [
      [
        'bridge-multi-nic',
        [
          { iface: 'eth0', mac: 'aa', subnet: '10.0.0.0/24', ip: '10.0.0.10' },
          { iface: 'eth1', mac: 'bb', subnet: '10.0.0.0/24', ip: '10.0.0.11' },
        ],
      ],
    ];
    expect(subnetMatchEntries(snapshot, '10.0.0.50')).toEqual([['10.0.0.10', 'bridge-multi-nic']]);
  });

  it('resolves a device behind a routed /12 to every bridge', () => {
    const snapshot: BridgeRegistrySnapshot = [
      [
        'bridge-2247-334-242-3427',
        [{ iface: 'eth3', mac: 'aa', subnet: '10.0.0.0/12', ip: '10.2.0.2', gateway: '10.2.0.1', routed: true }],
      ],
      [
        'bridge-2247-334-242-3428',
        [{ iface: 'eth3', mac: 'cc', subnet: '10.0.0.0/12', ip: '10.2.0.3', gateway: '10.2.0.1', routed: true }],
      ],
    ];
    expect(subnetMatchEntries(snapshot, '10.9.0.210')).toEqual([
      ['10.2.0.2', 'bridge-2247-334-242-3427'],
      ['10.2.0.3', 'bridge-2247-334-242-3428'],
    ]);
  });

  it('keeps a flat-L2 client on the connected entry over a wider routed prefix', () => {
    const snapshot: BridgeRegistrySnapshot = [
      [
        'bridge-a',
        [
          { iface: 'eth0', mac: 'aa', subnet: '192.168.1.0/24', ip: '192.168.1.10' },
          {
            iface: 'eth4',
            mac: 'bb',
            subnet: '192.168.0.0/16',
            ip: '10.100.0.1',
            gateway: '10.100.0.254',
            routed: true,
          },
        ],
      ],
    ];
    expect(subnetMatchEntries(snapshot, '192.168.1.50')).toEqual([['192.168.1.10', 'bridge-a']]);
  });

  it('empty snapshot returns empty list', () => {
    expect(subnetMatchEntries([], '10.0.0.50')).toEqual([]);
  });

  it('skips a non-string subnet without throwing', () => {
    const numberSubnet: BridgeRegistrySnapshot = [['bridge-a', [{ iface: 'eth0', ip: '10.0.0.231', subnet: 12345 }]]];
    const objectSubnet: BridgeRegistrySnapshot = [['bridge-a', [{ iface: 'eth0', ip: '10.0.0.231', subnet: {} }]]];
    expect(() => subnetMatchEntries(numberSubnet, '10.0.0.50')).not.toThrow();
    expect(subnetMatchEntries(numberSubnet, '10.0.0.50')).toEqual([]);
    expect(() => subnetMatchEntries(objectSubnet, '10.0.0.50')).not.toThrow();
    expect(subnetMatchEntries(objectSubnet, '10.0.0.50')).toEqual([]);
  });

  it('skips a non-string ip without throwing', () => {
    const snapshot: BridgeRegistrySnapshot = [['bridge-a', [{ iface: 'eth0', ip: 12345, subnet: '10.0.0.0/24' }]]];
    expect(() => subnetMatchEntries(snapshot, '10.0.0.50')).not.toThrow();
    expect(subnetMatchEntries(snapshot, '10.0.0.50')).toEqual([]);
  });

  it('continues past a poison entry to a valid entry in the same host', () => {
    const snapshot: BridgeRegistrySnapshot = [
      [
        'bridge-a',
        [
          { iface: 'eth0', ip: '10.0.0.231', subnet: 12345 },
          { iface: 'eth0', ip: '10.0.0.231', subnet: '10.0.0.0/24' },
        ],
      ],
    ];
    expect(subnetMatchEntries(snapshot, '10.0.0.50')).toEqual([['10.0.0.231', 'bridge-a']]);
  });

  it('matches a client-facing routable interface on the happy path', () => {
    const snapshot: BridgeRegistrySnapshot = [
      ['bridge-a', [{ iface: 'eth0', ip: '10.0.0.231', subnet: '10.0.0.0/24' }]],
    ];
    expect(subnetMatchEntries(snapshot, '10.0.0.50')).toEqual([['10.0.0.231', 'bridge-a']]);
  });

  it('accepts the readonly broadcaster snapshot shape', () => {
    const snapshot: ReadonlyArray<readonly [string, readonly unknown[]]> = [
      ['bridge-a', [{ iface: 'eth0', ip: '10.0.0.231', subnet: '10.0.0.0/24' }]],
    ];
    expect(subnetMatchEntries(snapshot, '10.0.0.50')).toEqual([['10.0.0.231', 'bridge-a']]);
  });
});

describe('missingBridgeHostnames', () => {
  it('names only eligible bridges absent from the present set', () => {
    const snapshot: BridgeRegistrySnapshot = [
      ['bridge-covered', [{ iface: 'eth3', subnet: '10.2.0.0/16', ip: '10.2.0.2' }]],
      ['bridge-missing', [{ iface: 'eth3', subnet: '10.2.0.0/16', ip: '10.2.0.3' }]],
      ['bridge-no-interfaces', []],
      ['bridge-malformed', 'not-a-list'],
      ['bridge-overlay-only', [{ iface: 'wt0', subnet: '100.64.0.0/10', ip: '100.64.0.5' }]],
      ['bridge-loopback-only', [{ iface: 'eth0', subnet: '127.0.0.0/8', ip: '127.0.0.1' }]],
      ['bridge-ip-not-string', [{ iface: 'eth0', subnet: '10.0.0.0/24', ip: 12345 }]],
    ];
    expect(missingBridgeHostnames(snapshot, ['bridge-covered'])).toEqual(['bridge-missing']);
  });

  it('returns an empty list when every eligible bridge is present', () => {
    const snapshot: BridgeRegistrySnapshot = [
      ['bridge-a', [{ iface: 'eth0', subnet: '10.0.0.0/24', ip: '10.0.0.231' }]],
      ['bridge-b', [{ iface: 'eth0', subnet: '10.0.0.0/24', ip: '10.0.0.232' }]],
    ];
    expect(missingBridgeHostnames(snapshot, ['bridge-a', 'bridge-b'])).toEqual([]);
  });
});

describe('getPeerClientFacingIpv4', () => {
  const SELF = 'bridge-self';
  const PEER = 'bridge-peer';

  it('returns the peer client-facing IP, skipping our own instance', async () => {
    const redis = fakeRegistryRedis([
      { instance_id: SELF, interfaces: [{ iface: 'eth0', subnet: '10.0.0.0/24', ip: '10.0.0.1' }] },
      { instance_id: PEER, interfaces: [{ iface: 'eth0', subnet: '10.0.0.0/24', ip: '10.0.0.3' }] },
    ]);
    expect(await getPeerClientFacingIpv4(redis, SELF, '10.0.0.1')).toBe('10.0.0.3');
  });

  it('never returns the peer docker/wt/ipmi IP — only the client-facing one', async () => {
    const redis = fakeRegistryRedis([
      {
        instance_id: PEER,
        interfaces: [
          { iface: 'docker0', subnet: '172.17.0.0/16', ip: '172.17.0.1' },
          { iface: 'wt0', subnet: '100.64.0.0/10', ip: '100.64.0.5' },
          { iface: 'ipmi0', subnet: '10.0.0.0/24', ip: '10.0.0.9' },
          { iface: 'eth0', subnet: '10.0.0.0/24', ip: '10.0.0.3' },
        ],
      },
    ]);
    expect(await getPeerClientFacingIpv4(redis, SELF, '10.0.0.1')).toBe('10.0.0.3');
  });

  it('prefers the peer interface on the client subnet over an off-subnet client-facing one', async () => {
    const redis = fakeRegistryRedis([
      {
        instance_id: PEER,
        interfaces: [
          { iface: 'eth1', subnet: '192.168.9.0/24', ip: '192.168.9.3' },
          { iface: 'eth0', subnet: '10.0.0.0/24', ip: '10.0.0.3' },
        ],
      },
    ]);
    expect(await getPeerClientFacingIpv4(redis, SELF, '10.0.0.50')).toBe('10.0.0.3');
  });

  it('picks a later subnet matching peer over an earlier off-subnet client-facing peer', async () => {
    const redis = fakeRegistryRedis([
      { instance_id: 'bridge-a', interfaces: [{ iface: 'eth0', subnet: '192.168.9.0/24', ip: '192.168.9.3' }] },
      { instance_id: 'bridge-b', interfaces: [{ iface: 'eth0', subnet: '10.0.0.0/24', ip: '10.0.0.3' }] },
    ]);
    expect(await getPeerClientFacingIpv4(redis, SELF, '10.0.0.50')).toBe('10.0.0.3');
  });

  it('falls back to the peer first client-facing IPv4 when no subnet preference matches', async () => {
    const redis = fakeRegistryRedis([
      { instance_id: PEER, interfaces: [{ iface: 'eth0', subnet: '192.168.9.0/24', ip: '192.168.9.3' }] },
    ]);
    expect(await getPeerClientFacingIpv4(redis, SELF, '10.0.0.50')).toBe('192.168.9.3');
  });

  it('returns null when no peer is registered (solo bring-up)', async () => {
    const redis = fakeRegistryRedis([
      { instance_id: SELF, interfaces: [{ iface: 'eth0', subnet: '10.0.0.0/24', ip: '10.0.0.1' }] },
    ]);
    expect(await getPeerClientFacingIpv4(redis, SELF, '10.0.0.1')).toBeNull();
  });

  it('never advertises a non-routable (loopback/link-local) peer IP (BB-14)', async () => {
    const redis = fakeRegistryRedis([
      {
        instance_id: PEER,
        interfaces: [
          { iface: 'eth0', subnet: '127.0.0.0/8', ip: '127.0.0.1' },
          { iface: 'eth1', subnet: '169.254.0.0/16', ip: '169.254.0.5' },
        ],
      },
    ]);
    expect(await getPeerClientFacingIpv4(redis, SELF, '10.0.0.50')).toBeNull();
  });

  it('skips a non-routable peer interface and picks the routable client-facing one (BB-14)', async () => {
    const redis = fakeRegistryRedis([
      {
        instance_id: PEER,
        interfaces: [
          { iface: 'eth0', subnet: '127.0.0.0/8', ip: '127.0.0.1' },
          { iface: 'eth1', subnet: '10.0.0.0/24', ip: '10.0.0.3' },
        ],
      },
    ]);
    expect(await getPeerClientFacingIpv4(redis, SELF, '10.0.0.50')).toBe('10.0.0.3');
  });
});
