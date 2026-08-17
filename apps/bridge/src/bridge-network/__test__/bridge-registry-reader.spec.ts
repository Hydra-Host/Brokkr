import { describe, expect, it } from 'vitest';

import { getLeaderConfig } from '../../leader-election/leader-election.config';
import {
  getBridgeRegistrySnapshot,
  getPeerClientFacingIpv4,
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
  it('returns subnet-matched ips for both bridges', () => {
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

  it('skips bridges with no matching subnet', () => {
    const snapshot: BridgeRegistrySnapshot = [
      ['bridge-on-other-subnet', [{ iface: 'eth0', mac: 'aa', subnet: '192.168.1.0/24', ip: '192.168.1.10' }]],
      ['bridge-on-our-subnet', [{ iface: 'eth0', mac: 'bb', subnet: '10.0.0.0/24', ip: '10.0.0.232' }]],
    ];
    expect(subnetMatchEntries(snapshot, '10.0.0.50')).toEqual([['10.0.0.232', 'bridge-on-our-subnet']]);
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

  it('empty snapshot returns empty list', () => {
    expect(subnetMatchEntries([], '10.0.0.50')).toEqual([]);
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

  it('picks a later subnet-matching peer over an earlier off-subnet client-facing peer', async () => {
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
