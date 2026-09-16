import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DhcpEngine } from '../../dhcp-server.js';
import type { SubnetConfig } from '../../subnet.js';
import { RedisLeaseStore } from '../redis-lease-store.js';

function fakeRedis(store: Record<string, string>) {
  return {
    get: vi.fn(async (key: string) => store[key] ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store[key] = value;
      return 'OK';
    }),
    delete: vi.fn(async (key: string) => (key in store ? (delete store[key], 1) : 0)),
    scan: vi.fn(async (pattern: string) => {
      const prefix = pattern.replace(/\*$/, '');
      return Object.keys(store).filter((k) => k.startsWith(prefix));
    }),
  };
}

const logger = { warn: vi.fn() };

describe('RedisLeaseStore.takeRevocations', () => {
  it('returns queued IPs and clears the markers so a replay cannot evict a re-issued lease', async () => {
    const store: Record<string, string> = {
      'dhcp:lease-revoke:10.0.1.5': '1',
      'dhcp:lease-revoke:10.0.1.9': '1',
    };
    const redis = fakeRedis(store);
    const subject = new RedisLeaseStore(() => redis, () => 1000, logger);

    expect((await subject.takeRevocations()).sort()).toEqual(['10.0.1.5', '10.0.1.9']);
    expect(await subject.takeRevocations()).toEqual([]);
    expect(Object.keys(store)).toEqual([]);
  });

  it('does not confuse lease keys with revocation markers', async () => {
    const store: Record<string, string> = {
      'dhcp:lease:10.0.1.5': JSON.stringify({ ip: '10.0.1.5', mac: 'aa:bb:cc:dd:ee:01', expiresAt: 9_999_999_999 }),
      'dhcp:lease-revoke:10.0.1.9': '1',
    };
    const redis = fakeRedis(store);
    const subject = new RedisLeaseStore(() => redis, () => 1000, logger);

    expect(await subject.takeRevocations()).toEqual(['10.0.1.9']);
    expect(store['dhcp:lease:10.0.1.5']).toBeDefined();
  });
});

function engineWithLease(ip: string, mac: string) {
  const subnetConfig: SubnetConfig = {
    serverId: '10.0.1.1',
    rangeStart: '10.0.1.10',
    rangeEnd: '10.0.1.60',
    subnetMask: '255.255.255.0',
    routers: ['10.0.1.1'],
    dnsServers: ['10.0.1.1'],
    dnsSelf: false,
    leaseTtlSeconds: 3600,
    reservations: [],
    excludeIps: [],
    tftpServer: '',
    bootfile: '',
    bootfileByArch: new Map(),
    bootBootfile: '',
    bootServerName: '',
    bootServerAddress: '',
    declineBackoffSeconds: 600,
    dhcpOptions: [],
  };
  const deletes: string[] = [];
  const leaseStore = {
    loadAll: async () => [{ ip, mac, hostname: null, expiresAt: 9_999_999_999 }],
    put: async () => {},
    delete: async (lease: { ip: string }) => {
      deletes.push(lease.ip);
    },
    pruneExpired: async () => 0,
    takeRevocations: async () => [],
  };
  const engine = DhcpEngine.fromSubnets(
    { mode: 'AUTHORITATIVE', networks: [{ interfaceKey: 'eth0', subnets: [subnetConfig] }] },
    () => 1000,
    leaseStore,
  );
  return { engine, deletes };
}

describe('DhcpEngine.revokeLease', () => {
  let subject: ReturnType<typeof engineWithLease>;

  beforeEach(async () => {
    subject = engineWithLease('10.0.1.50', 'aa:bb:cc:dd:ee:01');
    await subject.engine.hydrate();
    subject.engine.setWritesEnabled(true);
  });

  it('frees the address for reallocation, not just the store record', () => {
    expect(subject.engine.leases().map((l) => l.ip)).toContain('10.0.1.50');
    expect(subject.engine.revokeLease('10.0.1.50')).toBe(true);
    expect(subject.engine.leases().map((l) => l.ip)).not.toContain('10.0.1.50');
  });

  it('deletes the store record so a later hydrate cannot resurrect the lease', () => {
    subject.engine.revokeLease('10.0.1.50');
    expect(subject.deletes).toContain('10.0.1.50');
  });

  it('reports false for an address nobody holds', () => {
    expect(subject.engine.revokeLease('10.0.1.77')).toBe(false);
  });
});
