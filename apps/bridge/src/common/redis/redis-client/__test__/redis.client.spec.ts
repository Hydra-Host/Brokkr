import { describe, expect, it } from 'vitest';

import { RedisClient } from '../redis.client';
import type { RedisConfig } from '../redis.config';
import { RedisEncryptionError, RedisOperationError } from '../redis.errors';

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
  prefix: '',
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

function makeClient(): { client: RedisClient; backend: FakeCasRedis } {
  const backend = new FakeCasRedis();
  const client = new RedisClient(CONFIG, async () => backend);
  return { client, backend };
}

describe('RedisClient — distributed locks', () => {
  it('acquireLock grants a token, denies a second holder, and frees it on releaseLock', async () => {
    const { client } = makeClient();
    const token = await client.acquireLock('device:1', 60);
    expect(token).not.toBeNull();

    expect(await client.acquireLock('device:1', 60)).toBeNull();

    expect(await client.releaseLock('device:1', token as string)).toBe(true);
    expect(await client.acquireLock('device:1', 60)).not.toBeNull();
  });

  it('releaseLock by a non-owner token does not free the lock', async () => {
    const { client } = makeClient();
    await client.acquireLock('device:2', 60);
    expect(await client.releaseLock('device:2', 'not-the-token')).toBe(false);
    expect(await client.acquireLock('device:2', 60)).toBeNull();
  });

  it('a lock auto-expires after its TTL', async () => {
    const { client, backend } = makeClient();
    await client.acquireLock('device:3', 30);
    backend.advance(31);
    expect(await client.acquireLock('device:3', 30)).not.toBeNull();
  });

  it('renewLockIfOwner extends the TTL only for the owner', async () => {
    const { client, backend } = makeClient();
    const token = (await client.acquireLock('device:4', 100)) as string;

    backend.advance(60);
    expect(await client.renewLockIfOwner('device:4', token, 100)).toBe(true);
    expect(await client.renewLockIfOwner('device:4', 'wrong', 100)).toBe(false);

    backend.advance(60);
    expect(await client.acquireLock('device:4', 100)).toBeNull();
  });
});

describe('RedisClient — owner-gated CAS', () => {
  it('deleteIfOwner only deletes when the token matches', async () => {
    const { client } = makeClient();
    await client.setNx('k', 'tokenA', 60);

    expect(await client.deleteIfOwner('k', 'wrong')).toBe(false);
    expect(await client.get('k')).toBe('tokenA');

    expect(await client.deleteIfOwner('k', 'tokenA')).toBe(true);
    expect(await client.get('k')).toBeNull();
  });

  it('setNx honors NX and TTL expiry', async () => {
    const { client, backend } = makeClient();
    expect(await client.setNx('s', 'v1', 30)).toBe(true);
    expect(await client.setNx('s', 'v2', 30)).toBe(false);

    backend.advance(31);
    expect(await client.setNx('s', 'v3', 30)).toBe(true);
  });
});

describe('RedisClient — encrypted secrets', () => {
  it('secretSet/secretGet round-trips plaintext; the stored value is ciphertext', async () => {
    const { client } = makeClient();
    await client.secretSet('cred', 'super-secret');

    expect(await client.secretGet('cred')).toBe('super-secret');
    const stored = await client.get('cred');
    expect(stored).not.toBeNull();
    expect(stored).not.toBe('super-secret');
  });

  it('secretGet of a non-ciphertext value throws RedisEncryptionError unwrapped (not RedisOperationError)', async () => {
    const { client } = makeClient();
    await client.set('plain', 'not-encrypted');

    const error = await client.secretGet('plain').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RedisEncryptionError);
    expect(error).not.toBeInstanceOf(RedisOperationError);
  });
});

describe('RedisClient — reconnect & error wrapping', () => {
  it('reconnects and retries once after a connection error, returning the value', async () => {
    const { client, backend } = makeClient();
    await client.set('x', 'value');

    backend.failNextCommand = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    expect(await client.get('x')).toBe('value');
  });

  it('wraps a non-connection Redis error as RedisOperationError', async () => {
    const { client, backend } = makeClient();
    backend.failNextCommand = Object.assign(new Error('weird'), { name: 'RedisWeirdError' });

    await expect(client.get('y')).rejects.toBeInstanceOf(RedisOperationError);
  });

  it('propagates a non-Redis error unwrapped', async () => {
    const { client, backend } = makeClient();
    backend.failNextCommand = new Error('totally-unrelated');

    const error = await client.get('z').catch((e: unknown) => e);
    if (!(error instanceof Error)) throw new Error('expected get() to reject with an Error');
    expect(error.message).toBe('totally-unrelated');
    expect(error).not.toBeInstanceOf(RedisOperationError);
  });
});
