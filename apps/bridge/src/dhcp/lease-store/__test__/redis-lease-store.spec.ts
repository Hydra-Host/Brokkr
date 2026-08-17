import { describe, expect, it, vi } from 'vitest';

import { dhcpLease } from '../../../common/redis/redis-keys.js';
import type { LeaseRecord } from '../lease-record.js';
import { leaseRecordSchema } from '../lease-record.schema.js';
import { RedisLeaseStore } from '../redis-lease-store.js';

import { FakeRedisLeaseCache, RejectingRedisLeaseCache } from './fake-redis-lease-cache.js';

function record(ip: string, mac: string, expiresAt: number, hostname: string | null = null): LeaseRecord {
  return { ip, mac, hostname, expiresAt };
}

function buildStore(
  cache: FakeRedisLeaseCache,
  now = () => 1000,
): { store: RedisLeaseStore; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const store = new RedisLeaseStore(() => cache, now, { warn });
  return { store, warn };
}

describe('RedisLeaseStore', () => {
  it('put → loadAll returns the record; two MACs yield two records', async () => {
    const cache = new FakeRedisLeaseCache();
    const { store } = buildStore(cache);
    await store.put(record('10.0.0.10', 'aa:bb:cc:dd:ee:ff', 5000));
    await store.put(record('10.0.0.11', '11:22:33:44:55:66', 5000));
    const all = await store.loadAll();
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.mac).sort()).toEqual(['11:22:33:44:55:66', 'aa:bb:cc:dd:ee:ff']);
  });

  it('passes a positive per-key TTL on put', async () => {
    const cache = new FakeRedisLeaseCache();
    const { store } = buildStore(cache, () => 1000);
    await store.put(record('10.0.0.10', 'aa:bb:cc:dd:ee:ff', 5000));
    expect(cache.ttls.get(dhcpLease('10.0.0.10'))).toBe(4000);
  });

  it('floors the TTL at 1 second for a non-future expiry', async () => {
    const cache = new FakeRedisLeaseCache();
    const { store } = buildStore(cache, () => 5000);
    await store.put(record('10.0.0.10', 'aa:bb:cc:dd:ee:ff', 100));
    expect(cache.ttls.get(dhcpLease('10.0.0.10'))).toBe(1);
  });

  it('delete removes exactly the targeted key', async () => {
    const cache = new FakeRedisLeaseCache();
    const { store } = buildStore(cache);
    await store.put(record('10.0.0.10', 'aa:bb:cc:dd:ee:ff', 5000));
    await store.put(record('10.0.0.11', '11:22:33:44:55:66', 5000));
    await store.delete(record('10.0.0.10', 'aa:bb:cc:dd:ee:ff', 5000));
    expect(cache.store.has(dhcpLease('10.0.0.10'))).toBe(false);
    expect(cache.store.has(dhcpLease('10.0.0.11'))).toBe(true);
  });

  it('persists exact JSON and round-trips every field', async () => {
    const cache = new FakeRedisLeaseCache();
    const { store } = buildStore(cache);
    const rec = record('10.0.0.10', 'aa:bb:cc:dd:ee:ff', 5000, 'host');
    await store.put(rec);
    expect(JSON.parse(cache.store.get(dhcpLease('10.0.0.10'))!)).toEqual(rec);
    const [loaded] = await store.loadAll();
    expect(loaded).toEqual(rec);
  });

  it('keeps a valid non-6-octet chaddr through put → loadAll', async () => {
    const cache = new FakeRedisLeaseCache();
    const { store, warn } = buildStore(cache);
    await store.put(record('10.0.0.10', 'aa:bb:cc:dd:ee:ff:00:11', 5000));
    const all = await store.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.mac).toBe('aa:bb:cc:dd:ee:ff:00:11');
    expect(warn).not.toHaveBeenCalled();
  });

  it('prunes expired records on load and deletes their keys, keeping future ones', async () => {
    const cache = new FakeRedisLeaseCache();
    const { store } = buildStore(cache, () => 1000);
    await store.put(record('10.0.0.10', 'aa:bb:cc:dd:ee:ff', 500));
    await store.put(record('10.0.0.11', '11:22:33:44:55:66', 5000));
    const all = await store.loadAll();
    expect(all.map((r) => r.ip)).toEqual(['10.0.0.11']);
    expect(cache.store.has(dhcpLease('10.0.0.10'))).toBe(false);
    expect(cache.store.has(dhcpLease('10.0.0.11'))).toBe(true);
  });

  it('pruneExpired scans and drops expired, returning the count', async () => {
    const cache = new FakeRedisLeaseCache();
    const { store } = buildStore(cache, () => 0);
    await store.put(record('10.0.0.10', 'aa:bb:cc:dd:ee:ff', 100));
    await store.put(record('10.0.0.11', '11:22:33:44:55:66', 300));
    expect(await store.pruneExpired(200)).toBe(1);
    expect(cache.store.has(dhcpLease('10.0.0.10'))).toBe(false);
  });

  it('pruneExpired deletes the scanned key when the stored ip diverges from the key suffix', async () => {
    const cache = new FakeRedisLeaseCache();
    const { store } = buildStore(cache, () => 0);
    const scanKey = dhcpLease('10.0.0.99');
    const reDerivedKey = dhcpLease('10.0.0.7');
    cache.store.set(
      scanKey,
      JSON.stringify({ ip: '10.0.0.7', mac: 'aa:bb:cc:dd:ee:ff', hostname: null, expiresAt: 100 }),
    );

    expect(await store.pruneExpired(200)).toBe(1);
    expect(cache.store.has(scanKey)).toBe(false);
    expect(cache.store.has(reDerivedKey)).toBe(false);
  });

  it('skips and logs malformed records on load, keeping the valid ones', async () => {
    const cache = new FakeRedisLeaseCache();
    const { store, warn } = buildStore(cache, () => 0);
    cache.store.set(dhcpLease('bad-json'), '{not json');
    cache.store.set(dhcpLease('missing'), JSON.stringify({ ip: '10.0.0.5', mac: 'aa:bb:cc:dd:ee:ff' }));
    cache.store.set(
      dhcpLease('badip'),
      JSON.stringify({ ip: 'nope', mac: 'aa:bb:cc:dd:ee:ff', hostname: null, expiresAt: 9 }),
    );
    cache.store.set(dhcpLease('badmac'), JSON.stringify({ ip: '10.0.0.6', mac: 'ZZ', hostname: null, expiresAt: 9 }));
    cache.store.set(
      dhcpLease('badhost'),
      JSON.stringify({ ip: '10.0.0.7', mac: 'aa:bb:cc:dd:ee:ff', hostname: 'evil.attacker.com', expiresAt: 9 }),
    );
    cache.store.set(
      dhcpLease('crlfhost'),
      JSON.stringify({ ip: '10.0.0.8', mac: 'aa:bb:cc:dd:ee:ff', hostname: 'foo\nbar', expiresAt: 9 }),
    );
    cache.store.set(
      dhcpLease('10.0.0.10'),
      JSON.stringify({ ip: '10.0.0.10', mac: 'aa:bb:cc:dd:ee:ff', hostname: 'good', expiresAt: 9 }),
    );

    const all = await store.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.ip).toBe('10.0.0.10');
    expect(all[0]!.hostname).toBe('good');
    expect(warn).toHaveBeenCalledTimes(6);
  });

  it('skips an out-of-range IP (256.0.0.1) on load and keeps the valid record', async () => {
    const cache = new FakeRedisLeaseCache();
    const { store, warn } = buildStore(cache, () => 0);
    cache.store.set(
      dhcpLease('256.0.0.1'),
      JSON.stringify({ ip: '256.0.0.1', mac: 'aa:bb:cc:dd:ee:ff', hostname: null, expiresAt: 9 }),
    );
    cache.store.set(
      dhcpLease('10.0.0.10'),
      JSON.stringify({ ip: '10.0.0.10', mac: 'aa:bb:cc:dd:ee:ff', hostname: null, expiresAt: 9 }),
    );
    const all = await store.loadAll();
    expect(all.map((r) => r.ip)).toEqual(['10.0.0.10']);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('logs the key + zod error on a malformed record, never the raw bytes', async () => {
    const cache = new FakeRedisLeaseCache();
    const { store, warn } = buildStore(cache, () => 0);
    const poison = JSON.stringify({ ip: 'nope', mac: 'aa:bb:cc:dd:ee:ff', hostname: 'SECRET_INJECT', expiresAt: 9 });
    cache.store.set(dhcpLease('badip'), poison);
    await store.loadAll();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).not.toContain('SECRET_INJECT');
    expect(warn.mock.calls[0]![0]).toContain(dhcpLease('badip'));
  });

  it('the lease-record schema rejects a trailing-hyphen hostname and accepts valid labels', () => {
    expect(leaseRecordSchema.safeParse(record('10.0.0.10', 'aa:bb:cc:dd:ee:ff', 5000, 'foo-')).success).toBe(false);
    expect(leaseRecordSchema.safeParse(record('10.0.0.10', 'aa:bb:cc:dd:ee:ff', 5000, 'foo')).success).toBe(true);
    expect(leaseRecordSchema.safeParse(record('10.0.0.10', 'aa:bb:cc:dd:ee:ff', 5000, 'f')).success).toBe(true);
  });

  it('rejects a trailing-dash hostname on put and writes nothing (C16)', async () => {
    const cache = new FakeRedisLeaseCache();
    const { store } = buildStore(cache);
    await expect(store.put(record('10.0.0.10', 'aa:bb:cc:dd:ee:ff', 5000, 'foo-'))).rejects.toThrow();
    expect(cache.store.size).toBe(0);
  });

  it('put throws on an out-of-schema record and writes nothing', async () => {
    const cache = new FakeRedisLeaseCache();
    const { store } = buildStore(cache);
    await expect(store.put(record('not-an-ip', 'aa:bb:cc:dd:ee:ff', 5000))).rejects.toThrow();
    expect(cache.store.size).toBe(0);
  });

  it('propagates a loadAll failure so the engine can degrade to empty', async () => {
    const store = new RedisLeaseStore(
      () => new RejectingRedisLeaseCache(),
      () => 0,
      { warn: vi.fn() },
    );
    await expect(store.loadAll()).rejects.toThrow('redis down');
  });
});
