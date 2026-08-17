import { describe, expect, it, vi } from 'vitest';

import { PrefixedBridgePluginKv } from '../bridge-plugin-kv.js';

function makeRedis() {
  return {
    get: vi.fn().mockResolvedValue('value'),
    set: vi.fn().mockResolvedValue('OK'),
    delete: vi.fn().mockResolvedValue(1),
    scan: vi.fn().mockResolvedValue(['plugin:demo:a', 'plugin:demo:b', 'unrelated:key']),
  };
}

function makeKv(redis: ReturnType<typeof makeRedis>): PrefixedBridgePluginKv {
  return new PrefixedBridgePluginKv(redis, 'demo');
}

describe('PrefixedBridgePluginKv', () => {
  it('prefixes get, set, and delete with the plugin namespace', async () => {
    const redis = makeRedis();
    const kv = makeKv(redis);

    await kv.get('a');
    await kv.set('a', '1', 60);
    const deleted = await kv.delete('a');

    expect(redis.get).toHaveBeenCalledWith('plugin:demo:a');
    expect(redis.set).toHaveBeenCalledWith('plugin:demo:a', '1', 60);
    expect(redis.delete).toHaveBeenCalledWith('plugin:demo:a');
    expect(deleted).toBe(true);
  });

  it('scans within the namespace and strips the prefix from results', async () => {
    const redis = makeRedis();
    const kv = makeKv(redis);

    const keys = await kv.scan('*');

    expect(redis.scan).toHaveBeenCalledWith('plugin:demo:*');
    expect(keys).toEqual(['a', 'b']);
  });
});
