import type { PluginRedisClient } from '@hydrahost/plugin-sdk';

type RawRedis = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, expiryMode: 'EX', ttlSeconds: number): Promise<unknown>;
};

export function createNamespacedRedisClient(raw: RawRedis, pluginId: string): PluginRedisClient {
  const prefix = `plugin:${pluginId}:`;
  return {
    get: (key) => raw.get(`${prefix}${key}`),
    async set(key, value, ttlSeconds) {
      await raw.set(`${prefix}${key}`, value, 'EX', ttlSeconds);
    },
  };
}
