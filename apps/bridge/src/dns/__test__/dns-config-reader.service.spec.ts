import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

vi.mock('../../device-record/atom/atom-fetcher', () => {
  async function readAtom<T>(
    cache: { get(key: string, jobId?: string): Promise<string | null> },
    key: string,
    valueSchema: z.ZodType<T>,
    options: { jobId?: string } = {},
  ): Promise<T | null> {
    const raw = await cache.get(key, options.jobId ?? '');
    if (raw === null) return null;
    const parsed = JSON.parse(raw);
    if (parsed.status !== 'ok' || parsed.value === undefined) return null;
    const result = valueSchema.safeParse(parsed.value);
    if (!result.success) return null;
    return result.data;
  }
  return { readAtom };
});

import type { AtomReaderRedis } from '../../dhcp/dhcp-config-reader.service';
import type { DnsPrefixOverrideReadResult, DnsZoneConfigReadResult } from '../dns-config-reader.service';
import { DnsConfigReaderService } from '../dns-config-reader.service';

function wrapEnvelope(value: unknown): string {
  return JSON.stringify({ status: 'ok', value, written_at: Date.now(), request_id: null });
}

function makeRedis(overrides: Partial<AtomReaderRedis> = {}): AtomReaderRedis {
  return {
    get: vi.fn(async () => null),
    delete: vi.fn(async () => 0),
    scan: vi.fn(async () => []),
    ...overrides,
  };
}

function makeLogger() {
  return {
    log: vi.fn(async () => {}),
    debug: vi.fn(async () => {}),
    info: vi.fn(async () => {}),
    warning: vi.fn(async () => {}),
    error: vi.fn(async () => {}),
    getJobId: vi.fn(() => ''),
    shouldSkipMonitoringLog: vi.fn(() => false),
  };
}

describe('DnsConfigReaderService.readZoneConfig', () => {
  it('returns ok with config when the atom is present and valid', async () => {
    const atomValue = {
      enabled: true,
      upstreamResolvers: ['1.1.1.1'],
      ttlSeconds: 60,
      cacheSize: 500,
      ownedDomain: 'lan',
      hostnames: ['bridge-1'],
      tcpEnabled: true,
    };
    const redis = makeRedis({
      get: vi.fn(async () => wrapEnvelope(atomValue)),
    });
    const service = new DnsConfigReaderService(redis, makeLogger() as never);

    const result: DnsZoneConfigReadResult = await service.readZoneConfig('job-1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.enabled).toBe(true);
      expect(result.config.ownedDomain).toBe('lan');
      expect(result.config.upstreamResolvers).toEqual(['1.1.1.1']);
      expect(result.config.ttlSeconds).toBe(60);
    }
  });

  it('returns ok:false with reason missing when the atom key is missing (null)', async () => {
    const redis = makeRedis({
      get: vi.fn(async () => null),
    });
    const service = new DnsConfigReaderService(redis, makeLogger() as never);

    const result = await service.readZoneConfig('job-1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing');
    }
  });

  it('returns ok:false with reason error when Redis throws an error', async () => {
    const redis = makeRedis({
      get: vi.fn(async () => {
        throw new Error('REDIS_CONNECTION_ERROR');
      }),
    });
    const logger = makeLogger();
    const service = new DnsConfigReaderService(redis, logger as never);

    const result = await service.readZoneConfig('job-1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('error');
    }
    expect(logger.warning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to read DNS zone config atom'),
      expect.objectContaining({ jobId: 'job-1' }),
    );
  });

  it('uses default jobId when none is provided', async () => {
    const redis = makeRedis();
    const service = new DnsConfigReaderService(redis, makeLogger() as never);

    const result = await service.readZoneConfig();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing');
    }
    expect(redis.get).toHaveBeenCalledWith('config:dns', '');
  });
});

describe('DnsConfigReaderService.readPrefixOverrides', () => {
  it('returns ok with overrides for multiple prefixes', async () => {
    const override1 = { serveDns: true, upstreamOverride: ['10.0.1.1'] };
    const override2 = { serveDns: false, upstreamOverride: null };
    const redis = makeRedis({
      scan: vi.fn(async () => ['prefix:aaa-111:config:dns', 'prefix:bbb-222:config:dns']),
      get: vi.fn(async (key: string) => {
        if (key === 'prefix:aaa-111:config:dns') return wrapEnvelope(override1);
        if (key === 'prefix:bbb-222:config:dns') return wrapEnvelope(override2);
        return null;
      }),
    });
    const service = new DnsConfigReaderService(redis, makeLogger() as never);

    const result: DnsPrefixOverrideReadResult = await service.readPrefixOverrides('job-1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.overrides.size).toBe(2);
      expect(result.overrides.get('aaa-111')).toEqual(override1);
      expect(result.overrides.get('bbb-222')).toEqual(override2);
    }
  });

  it('returns ok:false when SCAN throws', async () => {
    const redis = makeRedis({
      scan: vi.fn(async () => {
        throw new Error('SCAN_FAILED');
      }),
    });
    const logger = makeLogger();
    const service = new DnsConfigReaderService(redis, logger as never);

    const result = await service.readPrefixOverrides('job-1');

    expect(result.ok).toBe(false);
    expect(logger.warning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to SCAN DNS prefix override atoms'),
      expect.objectContaining({ jobId: 'job-1' }),
    );
  });

  it('returns ok:false when an individual atom read throws', async () => {
    const redis = makeRedis({
      scan: vi.fn(async () => ['prefix:aaa:config:dns']),
      get: vi.fn(async () => {
        throw new Error('READ_FAILED');
      }),
    });
    const logger = makeLogger();
    const service = new DnsConfigReaderService(redis, logger as never);

    const result = await service.readPrefixOverrides('job-1');

    expect(result.ok).toBe(false);
    expect(logger.warning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to read DNS prefix override atoms'),
      expect.objectContaining({ jobId: 'job-1' }),
    );
  });

  it('skips null atoms without failing the overall read', async () => {
    const override = { serveDns: true, upstreamOverride: ['10.0.1.1'] };
    const redis = makeRedis({
      scan: vi.fn(async () => ['prefix:aaa:config:dns', 'prefix:bbb:config:dns']),
      get: vi.fn(async (key: string) => {
        if (key === 'prefix:aaa:config:dns') return wrapEnvelope(override);
        return null;
      }),
    });
    const service = new DnsConfigReaderService(redis, makeLogger() as never);

    const result = await service.readPrefixOverrides('job-1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.overrides.size).toBe(1);
      expect(result.overrides.has('aaa')).toBe(true);
    }
  });

  it('skips atoms whose key does not match the prefix ID pattern', async () => {
    const override = { serveDns: true, upstreamOverride: ['10.0.1.1'] };
    const redis = makeRedis({
      scan: vi.fn(async () => ['bogus-key-no-match']),
      get: vi.fn(async () => wrapEnvelope(override)),
    });
    const logger = makeLogger();
    const service = new DnsConfigReaderService(redis, logger as never);

    const result = await service.readPrefixOverrides('job-1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.overrides.size).toBe(0);
    }
    expect(logger.warning).toHaveBeenCalledWith(
      expect.stringContaining('does not match expected pattern'),
      expect.objectContaining({ jobId: 'job-1' }),
    );
  });

  it('returns an empty map when SCAN returns no keys', async () => {
    const redis = makeRedis({
      scan: vi.fn(async () => []),
    });
    const service = new DnsConfigReaderService(redis, makeLogger() as never);

    const result = await service.readPrefixOverrides('job-1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.overrides.size).toBe(0);
    }
  });

  it('extracts the prefix ID from well-formed atom keys', async () => {
    const override = { serveDns: null, upstreamOverride: ['8.8.8.8'] };
    const redis = makeRedis({
      scan: vi.fn(async () => ['prefix:uuid-abc-123:config:dns']),
      get: vi.fn(async () => wrapEnvelope(override)),
    });
    const service = new DnsConfigReaderService(redis, makeLogger() as never);

    const result = await service.readPrefixOverrides('job-1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.overrides.has('uuid-abc-123')).toBe(true);
      expect(result.overrides.get('uuid-abc-123')).toEqual(override);
    }
  });
});

