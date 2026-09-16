import { describe, expect, it, vi } from 'vitest';
import { DhcpLeaseReaderService } from '../dhcp-lease-reader.service';

const ZONE = 'zone-1';
const CIDR = '10.0.1.0/24';

function lease(ip: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ip, mac: 'aa:bb:cc:dd:ee:ff', hostname: 'host', expiresAt: 9_999_999_999, ...extra });
}

function build(store: Record<string, string>) {
  const redis = {
    set: vi.fn(async (key: string, value: string, ..._mode: unknown[]) => {
      store[key] = value;
      return 'OK';
    }),
    del: vi.fn(async (key: string) => (key in store ? (delete store[key], 1) : 0)),
    // scanKeys calls redis.scan(cursor, 'MATCH', pattern, 'COUNT', count); pattern is the 3rd arg.
    scan: vi.fn(async (_cursor: string, _match: string, pattern: string) => {
      const prefix = pattern.replace(/\*$/, '');
      return ['0', Object.keys(store).filter((k) => k.startsWith(prefix))];
    }),
    get: vi.fn(async (key: string) => store[key] ?? null),
    mget: vi.fn(async (...keys: string[]) => keys.map((k) => store[k] ?? null)),
  };
  const logger = { warn: vi.fn(), error: vi.fn(), log: vi.fn(), debug: vi.fn() };
  const service = new DhcpLeaseReaderService(redis as never, logger as never);
  return { service, redis, logger };
}

describe('DhcpLeaseReaderService.listLeasesForPrefix', () => {
  it('returns leases within the prefix CIDR, sorted by IP ascending', async () => {
    const { service } = build({
      'zone-1:dhcp:lease:10.0.1.20': lease('10.0.1.20'),
      'zone-1:dhcp:lease:10.0.1.5': lease('10.0.1.5'),
    });
    const result = await service.listLeasesForPrefix(ZONE, CIDR);
    expect(result.map((l) => l.ip)).toEqual(['10.0.1.5', '10.0.1.20']);
  });

  it('excludes leases outside the prefix CIDR (another prefix in the same zone)', async () => {
    const { service } = build({
      'zone-1:dhcp:lease:10.0.1.5': lease('10.0.1.5'),
      'zone-1:dhcp:lease:10.0.2.5': lease('10.0.2.5'),
    });
    const result = await service.listLeasesForPrefix(ZONE, CIDR);
    expect(result.map((l) => l.ip)).toEqual(['10.0.1.5']);
  });

  it('skips malformed JSON and schema-invalid entries (best-effort)', async () => {
    const { service, logger } = build({
      'zone-1:dhcp:lease:10.0.1.5': lease('10.0.1.5'),
      'zone-1:dhcp:lease:10.0.1.6': 'not-json',
      'zone-1:dhcp:lease:10.0.1.7': JSON.stringify({ ip: '10.0.1.7' }), // missing mac + expiresAt
    });
    const result = await service.listLeasesForPrefix(ZONE, CIDR);
    expect(result.map((l) => l.ip)).toEqual(['10.0.1.5']);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('skips a lease whose payload IP does not match the key suffix', async () => {
    const { service, logger } = build({
      'zone-1:dhcp:lease:10.0.1.5': lease('10.0.1.9'), // payload IP != key suffix
    });
    const result = await service.listLeasesForPrefix(ZONE, CIDR);
    expect(result).toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('skips expired leases whose TTL has not yet been evicted', async () => {
    const { service } = build({
      'zone-1:dhcp:lease:10.0.1.5': lease('10.0.1.5', { expiresAt: 1 }), // far in the past
      'zone-1:dhcp:lease:10.0.1.6': lease('10.0.1.6'), // default far-future expiry
    });
    const result = await service.listLeasesForPrefix(ZONE, CIDR);
    expect(result.map((l) => l.ip)).toEqual(['10.0.1.6']);
  });

  it('returns [] and issues no reads when the zone has no lease keys', async () => {
    const { service, redis } = build({});
    const result = await service.listLeasesForPrefix(ZONE, CIDR);
    expect(result).toEqual([]);
    expect(redis.mget).not.toHaveBeenCalled();
  });
});

describe('DhcpLeaseReaderService.listLeasesForZone', () => {
  it('spans every prefix in the zone — the reason the zone rollup exists at all', async () => {
    const { service } = build({
      'zone-1:dhcp:lease:10.0.2.5': lease('10.0.2.5'),
      'zone-1:dhcp:lease:10.0.1.5': lease('10.0.1.5'),
    });
    const result = await service.listLeasesForZone(ZONE);
    expect(result.map((l) => l.ip)).toEqual(['10.0.1.5', '10.0.2.5']);
  });

  it('still drops expired leases, so callers without a prefix cannot act on dead records', async () => {
    const { service } = build({
      'zone-1:dhcp:lease:10.0.1.5': lease('10.0.1.5'),
      'zone-1:dhcp:lease:10.0.2.5': lease('10.0.2.5', { expiresAt: 1 }),
    });
    const result = await service.listLeasesForZone(ZONE);
    expect(result.map((l) => l.ip)).toEqual(['10.0.1.5']);
  });

  it('does not leak another zone’s leases', async () => {
    const { service } = build({
      'zone-1:dhcp:lease:10.0.1.5': lease('10.0.1.5'),
      'zone-2:dhcp:lease:10.0.1.6': lease('10.0.1.6'),
    });
    const result = await service.listLeasesForZone(ZONE);
    expect(result.map((l) => l.ip)).toEqual(['10.0.1.5']);
  });
});

describe('DhcpLeaseReaderService.revokeLease', () => {
  it('removes the lease key and queues a revocation the bridge can act on', async () => {
    const store: Record<string, string> = { 'zone-1:dhcp:lease:10.0.1.5': lease('10.0.1.5') };
    const { service } = build(store);

    const removed = await service.revokeLease(ZONE, '10.0.1.5');

    expect(removed?.ip).toBe('10.0.1.5');
    expect(store['zone-1:dhcp:lease:10.0.1.5']).toBeUndefined();
    expect(store['zone-1:dhcp:lease-revoke:10.0.1.5']).toBe('1');
  });

  it('returns null for an address nobody holds, and queues nothing', async () => {
    const store: Record<string, string> = {};
    const { service } = build(store);

    expect(await service.revokeLease(ZONE, '10.0.1.5')).toBeNull();
    expect(Object.keys(store)).toEqual([]);
  });

  it('does not touch another zone', async () => {
    const store: Record<string, string> = { 'zone-2:dhcp:lease:10.0.1.5': lease('10.0.1.5') };
    const { service } = build(store);

    expect(await service.revokeLease(ZONE, '10.0.1.5')).toBeNull();
    expect(store['zone-2:dhcp:lease:10.0.1.5']).toBeDefined();
  });

  it('caps the marker with a TTL so an undrained revocation cannot evict a later tenant of the address', async () => {
    const { service, redis } = build({ 'zone-1:dhcp:lease:10.0.1.5': lease('10.0.1.5') });

    await service.revokeLease(ZONE, '10.0.1.5');

    expect(redis.set).toHaveBeenCalledWith('zone-1:dhcp:lease-revoke:10.0.1.5', '1', 'EX', 300);
  });

  it('writes the marker before deleting the key, so a renewal racing the two writes is still revoked', async () => {
    const { service, redis } = build({ 'zone-1:dhcp:lease:10.0.1.5': lease('10.0.1.5') });

    await service.revokeLease(ZONE, '10.0.1.5');

    expect(redis.set.mock.invocationCallOrder[0]!).toBeLessThan(redis.del.mock.invocationCallOrder[0]!);
  });

  it('warns instead of failing silently when the held record is unreadable', async () => {
    const store: Record<string, string> = { 'zone-1:dhcp:lease:10.0.1.5': 'not-json' };
    const { service, logger } = build(store);

    expect(await service.revokeLease(ZONE, '10.0.1.5')).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
    expect(store['zone-1:dhcp:lease:10.0.1.5']).toBeDefined();
  });
});
