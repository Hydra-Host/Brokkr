import { describe, expect, it, vi } from 'vitest';

import {
  DHCPACK,
  DHCPDISCOVER,
  DHCPRELEASE,
  DHCPREQUEST,
  OPT_HOSTNAME,
  OPT_REQUESTED_IP,
  OPT_SERVER_ID,
  encodeIp,
} from '../../dhcp-options.js';
import { DhcpEngine, type DhcpEngineLogger } from '../../dhcp-server.js';
import { type DhcpMessage, parsePacket } from '../../protocol.js';
import type { SubnetConfig } from '../../subnet.js';
import { InMemoryLeaseStore } from '../in-memory-lease-store.js';
import type { LeaseRecord } from '../lease-record.js';
import type { LeaseStore } from '../lease-store.js';
import { RedisLeaseStore } from '../redis-lease-store.js';

import { FakeRedisLeaseCache, RejectingRedisLeaseCache } from './fake-redis-lease-cache.js';

const SERVER_ID = '10.0.0.1';
const MAC_A = '00:0b:82:01:fc:42';
const MAC_B = '00:0b:82:01:fc:99';

function makeSubnetConfig(overrides: Partial<SubnetConfig> = {}): SubnetConfig {
  return {
    serverId: SERVER_ID,
    rangeStart: '10.0.0.10',
    rangeEnd: '10.0.0.12',
    subnetMask: '255.255.255.0',
    routers: ['10.0.0.1'],
    dnsServers: ['10.0.0.1'],
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
    ...overrides,
  };
}

function buildEngine(
  overrides: Partial<SubnetConfig> = {},
  now?: () => number,
  leaseStore?: LeaseStore,
  logger?: DhcpEngineLogger,
): DhcpEngine {
  const sc = makeSubnetConfig(overrides);
  return DhcpEngine.fromSubnets(
    { mode: 'AUTHORITATIVE', networks: [{ interfaceKey: 'eth0', subnets: [sc] }] },
    now,
    leaseStore,
    logger,
  );
}

function request(messageType: number, overrides: Partial<DhcpMessage> = {}): DhcpMessage {
  return {
    op: 1,
    htype: 1,
    hlen: 6,
    hops: 0,
    xid: 0x1234,
    secs: 0,
    flags: 0,
    broadcast: false,
    ciaddr: '0.0.0.0',
    yiaddr: '0.0.0.0',
    siaddr: '0.0.0.0',
    giaddr: '0.0.0.0',
    chaddr: MAC_A,
    messageType,
    options: new Map(),
    ...overrides,
  };
}

function decodeReply(reply: Buffer): { messageType: number; yiaddr: string } {
  const copy = Buffer.from(reply);
  copy[0] = 1;
  const parsed = parsePacket(copy);
  return { messageType: parsed.messageType!, yiaddr: parsed.yiaddr };
}

function record(ip: string, mac: string, expiresAt: number, hostname: string | null = null): LeaseRecord {
  return { ip, mac, hostname, expiresAt };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

function redisStore(cache: FakeRedisLeaseCache, now: () => number): RedisLeaseStore {
  return new RedisLeaseStore(() => cache, now, { warn: vi.fn() });
}

function spyStore(records: LeaseRecord[] = []): LeaseStore {
  return {
    loadAll: vi.fn(async () => records),
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    pruneExpired: vi.fn(async () => 0),
    takeRevocations: vi.fn(async () => []),
  };
}

describe('DhcpEngine ↔ LeaseStore integration', () => {
  it('writes a committed lease through to the store', async () => {
    const cache = new FakeRedisLeaseCache();
    const engine = buildEngine(
      {},
      () => 1000,
      redisStore(cache, () => 1000),
    );
    engine.handle(request(DHCPDISCOVER), SERVER_ID);
    engine.handle(
      request(DHCPREQUEST, {
        options: new Map([
          [OPT_SERVER_ID, encodeIp(SERVER_ID)],
          [OPT_REQUESTED_IP, encodeIp('10.0.0.10')],
        ]),
      }),
      SERVER_ID,
    );
    await flush();
    const persisted = await redisStore(cache, () => 1000).loadAll();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.ip).toBe('10.0.0.10');
    expect(persisted[0]!.mac).toBe(MAC_A);
  });

  it('hydrate makes a prior lease sticky and held against other MACs', async () => {
    const cache = new FakeRedisLeaseCache();
    await redisStore(cache, () => 1000).put(record('10.0.0.10', MAC_A, 5000));
    const engine = buildEngine(
      {},
      () => 1000,
      redisStore(cache, () => 1000),
    );
    await engine.hydrate();

    const offerA = engine.handle(request(DHCPDISCOVER, { chaddr: MAC_A }), SERVER_ID);
    expect(decodeReply(offerA!.reply).yiaddr).toBe('10.0.0.10');

    const offerB = engine.handle(request(DHCPDISCOVER, { chaddr: MAC_B }), SERVER_ID);
    expect(decodeReply(offerB!.reply).yiaddr).toBe('10.0.0.11');
  });

  it('prunes a lease that expired during downtime and frees the IP', async () => {
    const cache = new FakeRedisLeaseCache();
    await redisStore(cache, () => 0).put(record('10.0.0.10', MAC_A, 0 + 3600));
    const engine = buildEngine(
      {},
      () => 5000,
      redisStore(cache, () => 5000),
    );
    await engine.hydrate();

    expect(engine.leases()).toHaveLength(0);

    const offerB = engine.handle(request(DHCPDISCOVER, { chaddr: MAC_B }), SERVER_ID);
    expect(decodeReply(offerB!.reply).yiaddr).toBe('10.0.0.10');
  });

  it('stays silent on INIT-REBOOT after downtime expiry prunes the lease (RFC 2131 §4.3.2)', async () => {
    const cache = new FakeRedisLeaseCache();
    await redisStore(cache, () => 0).put(record('10.0.0.10', MAC_A, 0 + 3600));
    const engine = buildEngine(
      {},
      () => 5000,
      redisStore(cache, () => 5000),
    );
    await engine.hydrate();

    const reboot = engine.handle(
      request(DHCPREQUEST, { chaddr: MAC_A, options: new Map([[OPT_REQUESTED_IP, encodeIp('10.0.0.10')]]) }),
      SERVER_ID,
    );
    expect(reboot).toBeNull();
  });

  it('still ACKs and tracks the lease when the store put rejects (logged WARN)', async () => {
    const warn = vi.fn();
    const store = new RedisLeaseStore(
      () => new RejectingRedisLeaseCache(),
      () => 1000,
      { warn },
    );
    const engine = buildEngine({}, () => 1000, store, { warn, error: vi.fn() });

    engine.handle(request(DHCPDISCOVER), SERVER_ID);
    const ack = engine.handle(
      request(DHCPREQUEST, {
        options: new Map([
          [OPT_SERVER_ID, encodeIp(SERVER_ID)],
          [OPT_REQUESTED_IP, encodeIp('10.0.0.10')],
        ]),
      }),
      SERVER_ID,
    );
    expect(decodeReply(ack!.reply).messageType).toBe(DHCPACK);
    expect(engine.leases()).toHaveLength(1);
    await flush();
    expect(warn).toHaveBeenCalled();
  });

  it('expires the lease in-RAM even when the store put rejects (logged WARN)', async () => {
    const warn = vi.fn();
    const store = new RedisLeaseStore(
      () => new RejectingRedisLeaseCache(),
      () => 1000,
      { warn },
    );
    const engine = buildEngine({}, () => 1000, store, { warn, error: vi.fn() });

    engine.handle(request(DHCPDISCOVER), SERVER_ID);
    engine.handle(
      request(DHCPREQUEST, {
        options: new Map([
          [OPT_SERVER_ID, encodeIp(SERVER_ID)],
          [OPT_REQUESTED_IP, encodeIp('10.0.0.10')],
        ]),
      }),
      SERVER_ID,
    );
    expect(engine.leases()).toHaveLength(1);

    engine.handle(
      request(DHCPRELEASE, {
        ciaddr: '10.0.0.10',
        options: new Map([[OPT_SERVER_ID, encodeIp(SERVER_ID)]]),
      }),
      SERVER_ID,
    );
    expect(engine.leases()).toHaveLength(1);
    expect(engine.leases()[0]!.expiresAt).toBe(0);
    await flush();
    expect(warn).toHaveBeenCalled();
  });

  it('hydrate degrades to empty and logs ERROR when loadAll rejects', async () => {
    const error = vi.fn();
    const store = new RedisLeaseStore(
      () => new RejectingRedisLeaseCache(),
      () => 1000,
      { warn: vi.fn() },
    );
    const engine = buildEngine({}, () => 1000, store, { warn: vi.fn(), error });

    await engine.hydrate();
    expect(error).toHaveBeenCalled();
    expect(engine.leases()).toHaveLength(0);
    const offer = engine.handle(request(DHCPDISCOVER), SERVER_ID);
    expect(decodeReply(offer!.reply).yiaddr).toBe('10.0.0.10');
  });

  it('hydrate resolves true on an all-corrupt store (corruption skipped, not thrown)', async () => {
    const warn = vi.fn();
    const cache = new FakeRedisLeaseCache();
    cache.store.set('dhcp:lease:10.0.0.10', 'not-json');
    cache.store.set('dhcp:lease:10.0.0.11', JSON.stringify({ bogus: true }));
    const store = new RedisLeaseStore(
      () => cache,
      () => 1000,
      { warn },
    );
    const engine = buildEngine({}, () => 1000, store, { warn, error: vi.fn() });

    const ok = await engine.hydrate();
    expect(ok).toBe(true);
    expect(engine.leases()).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });

  it('does not write through when writes are disabled', async () => {
    const cache = new FakeRedisLeaseCache();
    const engine = buildEngine(
      {},
      () => 1000,
      redisStore(cache, () => 1000),
    );
    engine.setWritesEnabled(false);
    engine.handle(request(DHCPDISCOVER), SERVER_ID);
    engine.handle(
      request(DHCPREQUEST, {
        options: new Map([
          [OPT_SERVER_ID, encodeIp(SERVER_ID)],
          [OPT_REQUESTED_IP, encodeIp('10.0.0.10')],
        ]),
      }),
      SERVER_ID,
    );
    await flush();
    expect(cache.store.size).toBe(0);
  });

  it('re-hydrate picks up a lease seeded by another leader', async () => {
    const cache = new FakeRedisLeaseCache();
    const engine = buildEngine(
      {},
      () => 1000,
      redisStore(cache, () => 1000),
    );
    await engine.hydrate();
    expect(engine.leases()).toHaveLength(0);

    await redisStore(cache, () => 1000).put(record('10.0.0.12', MAC_B, 5000));
    await engine.hydrate();
    expect(engine.leases().map((l) => l.ip)).toContain('10.0.0.12');
  });

  it('treats an expired lease as free on lookup without any store call', async () => {
    const store = spyStore([{ ip: '10.0.0.10', mac: MAC_A, hostname: null, expiresAt: 100 }]);
    const engine = buildEngine({}, () => 5000, store);
    await engine.hydrate();

    const loadAllCallsAfterHydrate = vi.mocked(store.loadAll).mock.calls.length;

    const offer = engine.handle(request(DHCPDISCOVER, { chaddr: MAC_B }), SERVER_ID);
    expect(decodeReply(offer!.reply).yiaddr).toBe('10.0.0.10');

    expect(vi.mocked(store.loadAll).mock.calls.length).toBe(loadAllCallsAfterHydrate);
    expect(store.delete).not.toHaveBeenCalled();
    expect(store.pruneExpired).not.toHaveBeenCalled();
  });

  it('persists a committed hostname and round-trips a null hostname on hydrate', async () => {
    const cache = new FakeRedisLeaseCache();
    const engine = buildEngine(
      {},
      () => 1000,
      redisStore(cache, () => 1000),
    );

    engine.handle(
      request(DHCPDISCOVER, { options: new Map([[OPT_HOSTNAME, Buffer.from('foo', 'ascii')]]) }),
      SERVER_ID,
    );
    engine.handle(
      request(DHCPREQUEST, {
        options: new Map([
          [OPT_SERVER_ID, encodeIp(SERVER_ID)],
          [OPT_REQUESTED_IP, encodeIp('10.0.0.10')],
          [OPT_HOSTNAME, Buffer.from('foo', 'ascii')],
        ]),
      }),
      SERVER_ID,
    );
    await flush();
    const persisted = await redisStore(cache, () => 1000).loadAll();
    expect(persisted[0]!.hostname).toBe('foo');

    const cache2 = new FakeRedisLeaseCache();
    await redisStore(cache2, () => 1000).put(record('10.0.0.11', MAC_B, 5000, null));
    const engine2 = buildEngine(
      {},
      () => 1000,
      redisStore(cache2, () => 1000),
    );
    await engine2.hydrate();
    expect(engine2.leases().map((l) => l.ip)).toEqual(['10.0.0.11']);
  });

  it('persists and round-trips a lease under the default fractional clock (no schema throw)', async () => {
    const warn = vi.fn();
    const cache = new FakeRedisLeaseCache();
    const fractionalNow = (): number => Date.now() / 1000;
    const store = new RedisLeaseStore(() => cache, fractionalNow, { warn });
    const engine = buildEngine({}, undefined, store, { warn, error: vi.fn() });

    engine.handle(request(DHCPDISCOVER), SERVER_ID);
    engine.handle(
      request(DHCPREQUEST, {
        options: new Map([
          [OPT_SERVER_ID, encodeIp(SERVER_ID)],
          [OPT_REQUESTED_IP, encodeIp('10.0.0.10')],
        ]),
      }),
      SERVER_ID,
    );
    await flush();

    expect(cache.store.size).toBe(1);
    expect(warn).not.toHaveBeenCalled();

    const persisted = await store.loadAll();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.ip).toBe('10.0.0.10');
    expect(persisted[0]!.mac).toBe(MAC_A);
    expect(Number.isInteger(persisted[0]!.expiresAt)).toBe(true);
  });

  it('defaults to an in-memory store; hydrate on a fresh engine is a no-op', async () => {
    const engine = buildEngine();
    await engine.hydrate();
    expect(engine.leases()).toHaveLength(0);
    const offer = engine.handle(request(DHCPDISCOVER), SERVER_ID);
    expect(decodeReply(offer!.reply).yiaddr).toBe('10.0.0.10');
    expect(new InMemoryLeaseStore()).toBeInstanceOf(InMemoryLeaseStore);
  });
});
