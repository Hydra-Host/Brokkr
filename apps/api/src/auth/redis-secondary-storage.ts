import { Logger } from '@nestjs/common';
import type { SecondaryStorage } from '@repo/auth';
import Redis from 'ioredis';
import { createRedisConnectionConfig } from 'src/common/redis/redis.config';

export interface RedisSecondaryStorageHandle {
  storage: SecondaryStorage;
  close: () => Promise<void>;
}

export function createRedisSecondaryStorage(): RedisSecondaryStorageHandle | undefined {
  // E2E sets this (it writes session rows straight to Postgres, so the cache would serve a stale activeOrganizationId); prod-gated because a leaked flag would downgrade the rate-limit store to per-process memory.
  if (process.env.DISABLE_AUTH_SESSION_CACHE === 'true' && process.env.NODE_ENV !== 'production') {
    console.info('[auth] redis session cache disabled via DISABLE_AUTH_SESSION_CACHE');
    return undefined;
  }

  const redisConnectionConfig = createRedisConnectionConfig({
    redisUrl: process.env.REDIS_URL,
    redisCaCert: process.env.REDIS_CA_CERT,
    nodeTlsRejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED,
  });

  if (!redisConnectionConfig) return undefined;

  const logger = new Logger('RedisSecondaryStorage');
  const redis = new Redis(
    redisConnectionConfig.url,
    redisConnectionConfig.tls ? { tls: redisConnectionConfig.tls } : {},
  );

  redis.on('error', (err) => logger.error('Redis session-cache connection error', err));

  const storage: SecondaryStorage = {
    get: async (key: string) => {
      const raw = await redis.get(key);
      if (raw === null) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    },
    set: async (key: string, value: string, ttl?: number) => {
      if (ttl !== undefined) await redis.set(key, value, 'EX', ttl);
      else await redis.set(key, value);
    },
    delete: async (key: string) => {
      await redis.del(key);
    },
  };

  return {
    storage,
    close: async () => {
      await redis.quit();
    },
  };
}
