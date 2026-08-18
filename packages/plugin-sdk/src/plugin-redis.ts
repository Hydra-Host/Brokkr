export const PLUGIN_REDIS_CLIENT = Symbol.for('@hydrahost/plugin-sdk/REDIS_CLIENT');

export interface PluginRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}
