import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRedisTransportConnectionConfig } from '../redis.config';

describe('createRedisTransportConnectionConfig', () => {
  it('omits db when the URL has no path segment', () => {
    const config = createRedisTransportConnectionConfig({ redisUrl: 'redis://localhost:6379' });
    expect(config.db).toBeUndefined();
    expect(config.host).toBe('localhost');
    expect(config.port).toBe(6379);
    expect(config.maxRetriesPerRequest).toBeNull();
  });

  it('parses the logical db index from the URL path', () => {
    const config = createRedisTransportConnectionConfig({ redisUrl: 'redis://localhost:6379/1' });
    expect(config.db).toBe(1);
  });

  it('parses credentials and db alongside tls', () => {
    const config = createRedisTransportConnectionConfig({ redisUrl: 'rediss://user:pass@redis.example.com:6380/3' });
    expect(config).toMatchObject({
      host: 'redis.example.com',
      port: 6380,
      username: 'user',
      password: 'pass',
      db: 3,
      tls: { rejectUnauthorized: true },
    });
  });

  it('omits tls for redis:// URLs', () => {
    const config = createRedisTransportConnectionConfig({ redisUrl: 'redis://localhost:6379' });
    expect(config.tls).toBeUndefined();
  });

  it('loads the CA cert from the file path and carries rejectUnauthorized into tls options', () => {
    const caPath = join(mkdtempSync(join(tmpdir(), 'redis-ca-')), 'ca.pem');
    writeFileSync(caPath, 'PEM');
    const config = createRedisTransportConnectionConfig({
      redisUrl: 'rediss://user:pass@redis.example.com:6380',
      redisCaCert: caPath,
      nodeTlsRejectUnauthorized: '0',
    });
    expect(config.tls).toEqual({ ca: 'PEM', rejectUnauthorized: false });
  });

  it('omits ca when no CA cert path is set', () => {
    const config = createRedisTransportConnectionConfig({
      redisUrl: 'rediss://user:pass@redis.example.com:6380',
    });
    expect(config.tls).toEqual({ rejectUnauthorized: true });
  });
});
