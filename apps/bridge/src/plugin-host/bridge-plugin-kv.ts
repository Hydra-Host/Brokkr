import type { BridgePluginKv } from '@hydrahost/plugin-sdk';

export interface BridgePluginKvRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttl?: number): Promise<unknown>;
  delete(key: string): Promise<number>;
  scan(pattern: string): Promise<string[]>;
}

export class PrefixedBridgePluginKv implements BridgePluginKv {
  private readonly prefix: string;

  constructor(
    private readonly redis: BridgePluginKvRedis,
    pluginId: string,
  ) {
    this.prefix = `plugin:${pluginId}:`;
  }

  async get(key: string): Promise<string | null> {
    return this.redis.get(`${this.prefix}${key}`);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    await this.redis.set(`${this.prefix}${key}`, value, ttlSeconds);
  }

  async delete(key: string): Promise<boolean> {
    return (await this.redis.delete(`${this.prefix}${key}`)) > 0;
  }

  async scan(pattern: string): Promise<string[]> {
    const keys = await this.redis.scan(`${this.prefix}${pattern}`);
    return keys.filter((key) => key.startsWith(this.prefix)).map((key) => key.slice(this.prefix.length));
  }
}
