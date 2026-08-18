import { describe, expect, it, vi } from 'vitest';

import { createNamespacedRedisClient } from '../host-plugin-redis-client';

function makeRaw() {
  return {
    get: vi.fn().mockResolvedValue('value'),
    set: vi.fn().mockResolvedValue('OK'),
  };
}

describe('createNamespacedRedisClient', () => {
  it('prefixes get and set with the plugin namespace', async () => {
    const raw = makeRaw();
    const client = createNamespacedRedisClient(raw, 'device-monitoring');

    await client.get('api-key-identity:abc');
    await client.set('api-key-identity:abc', '{}', 300);

    expect(raw.get).toHaveBeenCalledWith('plugin:device-monitoring:api-key-identity:abc');
    expect(raw.set).toHaveBeenCalledWith('plugin:device-monitoring:api-key-identity:abc', '{}', 'EX', 300);
  });

  it('exposes only get and set', () => {
    const client = createNamespacedRedisClient(makeRaw(), 'demo');
    expect(Object.keys(client).sort()).toEqual(['get', 'set']);
  });
});
