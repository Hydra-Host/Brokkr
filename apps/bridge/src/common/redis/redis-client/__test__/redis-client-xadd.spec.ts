import { describe, expect, it } from 'vitest';

import { RedisClient } from '../redis.client';
import type { RedisConfig } from '../redis.config';

import { FakeCasRedis } from './fake-cas-redis';

const CONFIG: RedisConfig = {
  url: 'redis://localhost:6379/0',
  host: 'localhost',
  port: 6379,
  username: '',
  password: '',
  db: 0,
  tls: false,
  tlsCaCert: '',
  prefix: 'zone-1',
  socketTimeout: 5,
  socketConnectTimeout: 5,
  retryOnError: true,
  maxConnections: 50,
  encryptionKey: 'wmjZhYLXlEQTYtwCVFNg1Q4k+5yQEQHLa87eDmf0Tmo=',
  ttls: {
    deviceNetplan: 120,
    bmcCipher: 2_592_000,
    deviceSshIp: 300,
    resolvedIp: 3600,
    deviceInitrd: 600,
    bridgeInterfaces: 300,
    syncVersion: 2_592_000,
  },
};

function makeClient(): { client: RedisClient; fake: FakeCasRedis } {
  const fake = new FakeCasRedis();
  const client = new RedisClient(CONFIG, async () => fake);
  return { client, fake };
}

describe('RedisClient.xadd', () => {
  it('writes to the prefixed stream key', async () => {
    const { client, fake } = makeClient();

    await client.xadd('job:logs:p1', { line: 'hello' });

    expect(fake.streamEntries('zone-1:job:logs:p1')).toHaveLength(1);
    expect(fake.streamEntries('job:logs:p1')).toHaveLength(0);
  });

  it('returns an increasing id per append', async () => {
    const { client } = makeClient();

    const first = await client.xadd('job:logs:p1', { line: 'a' });
    const second = await client.xadd('job:logs:p1', { line: 'b' });

    expect(first).toMatch(/^\d+-0$/);
    expect(second).toMatch(/^\d+-0$/);
    expect(parseInt(second, 10)).toBeGreaterThan(parseInt(first, 10));
  });

  it('round-trips fields', async () => {
    const { client, fake } = makeClient();

    const fields = { ts: '1724800000000', level: 'info', line: 'saga step done' };
    const id = await client.xadd('job:logs:p1', fields);

    expect(fake.streamEntries('zone-1:job:logs:p1')).toEqual([{ id, fields }]);
  });

  it('drops the oldest entries beyond maxlen', async () => {
    const { client, fake } = makeClient();

    await client.xadd('job:logs:p1', { line: 'a' }, 2);
    await client.xadd('job:logs:p1', { line: 'b' }, 2);
    await client.xadd('job:logs:p1', { line: 'c' }, 2);

    const entries = fake.streamEntries('zone-1:job:logs:p1');
    expect(entries.map((entry) => entry.fields.line)).toEqual(['b', 'c']);
  });

  it('expires the stream key like other keys', async () => {
    const { client, fake } = makeClient();

    await client.xadd('job:logs:p1', { line: 'a' });
    await client.expire('job:logs:p1', 30);

    expect(await client.exists('job:logs:p1')).toBe(true);
    fake.advance(31);
    expect(await client.exists('job:logs:p1')).toBe(false);
    expect(fake.streamEntries('zone-1:job:logs:p1')).toHaveLength(0);
  });
});
