import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadRedisConfig } from '../../common/redis/redis-client/redis.config.js';
import { RedisLeaseStore } from '../../dhcp/lease-store/redis-lease-store.js';
import * as holder from '../dhcp-lease-cache-holder.js';
import { buildLeaseStore } from '../dhcp-server-factory.js';

function withZoneId<T>(zoneId: string | undefined, fn: () => T): T {
  const prior = process.env.BROKKR_ZONE_ID;
  if (zoneId === undefined) delete process.env.BROKKR_ZONE_ID;
  else process.env.BROKKR_ZONE_ID = zoneId;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.BROKKR_ZONE_ID;
    else process.env.BROKKR_ZONE_ID = prior;
  }
}

const ZONE_UUID = '11111111-2222-3333-4444-555555555555';

describe('DHCP lease store wiring', () => {
  afterEach(() => {
    holder.resetDhcpLeaseCacheForTests();
    vi.restoreAllMocks();
  });

  it('builds a RedisLeaseStore', () => {
    withZoneId(ZONE_UUID, () => {
      expect(buildLeaseStore(process.env)).toBeInstanceOf(RedisLeaseStore);
    });
  });

  it('throws when BROKKR_ZONE_ID (zone UUID) is empty', () => {
    withZoneId('', () => {
      expect(() => buildLeaseStore(process.env)).toThrow(/non-empty BROKKR_ZONE_ID/);
    });
  });

  it('does not eagerly read the holder when building the redis store', () => {
    const holderSpy = vi.spyOn(holder, 'getDhcpLeaseCacheOrThrow');
    withZoneId(ZONE_UUID, () => buildLeaseStore(process.env));
    expect(holderSpy).not.toHaveBeenCalled();
  });

  it('carries a non-empty prefix when BROKKR_ZONE_ID (zone UUID) is set', () => {
    withZoneId(ZONE_UUID, () => {
      expect(loadRedisConfig().prefix).toBe(ZONE_UUID);
    });
  });
});
