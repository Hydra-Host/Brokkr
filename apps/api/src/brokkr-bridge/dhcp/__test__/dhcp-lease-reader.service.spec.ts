import { describe, expect, it, vi } from 'vitest';
import { DhcpLeaseReaderService } from '../dhcp-lease-reader.service';

const ZONE = 'zone-1';
const CIDR = '10.0.1.0/24';

function lease(ip: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ip, mac: 'aa:bb:cc:dd:ee:ff', hostname: 'host', expiresAt: 9_999_999_999, ...extra });
}

function build(store: Record<string, string>) {
  const redis = {
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
