import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { RedisClient } from '../../../common/redis/redis-client/index.js';
import { detectCipher, getCipherForDevice, resolveCipher } from '../cipher.js';
import { createIpmiDevice } from '../device.js';
import { getIpmiConfig } from '../ipmi.config.js';
import type { IPMIResult } from '../result.js';
import { run } from '../transport.js';

vi.mock('../transport.js', () => ({
  run: vi.fn(),
}));

const mockedRun = vi.mocked(run);

function transportResult(ok: boolean, overrides: Partial<IPMIResult> = {}): IPMIResult {
  return {
    ok,
    stdout: ok ? 'Chassis Power is on' : '',
    stderr: ok ? '' : 'Unable to establish IPMI v2 / RMCP+ session',
    returncode: ok ? 0 : 1,
    command: [],
    cipherUsed: null,
    durationMs: 5,
    timedOut: false,
    ...overrides,
  };
}

interface FakeRedis {
  secretHget: Mock<(...args: any[]) => any>;
  get: Mock<(...args: any[]) => any>;
  secretHset: Mock<(...args: any[]) => any>;
  set: Mock<(...args: any[]) => any>;
}

function fakeRedis(): { fake: FakeRedis; redis: RedisClient } {
  const fake: FakeRedis = {
    secretHget: vi.fn().mockResolvedValue(null),
    get: vi.fn().mockResolvedValue(null),
    secretHset: vi.fn().mockResolvedValue(1),
    set: vi.fn().mockResolvedValue(true),
  };
  return { fake, redis: fake as unknown as RedisClient };
}

const device = createIpmiDevice({ ip: '10.1.2.3', username: 'admin', password: 'pw', jobId: 'job-1' });

beforeEach(() => {
  mockedRun.mockReset();
});

describe('resolveCipher redis cache', () => {
  it('returns device-keyed cached cipher without probing', async () => {
    const { fake, redis } = fakeRedis();
    fake.get.mockResolvedValue('17');

    const result = await resolveCipher(redis, device, 'dev-1');

    expect(result).toEqual({ found: true, cipher: '17' });
    expect(fake.get).toHaveBeenCalledWith('device:dev-1:bmc:cipher', 'job-1');
    expect(fake.secretHget).not.toHaveBeenCalled();
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it('decodes the __none__ sentinel from the ip-keyed cache to a null cipher', async () => {
    const { fake, redis } = fakeRedis();
    fake.get.mockResolvedValue('__none__');

    const result = await resolveCipher(redis, device);

    expect(result).toEqual({ found: true, cipher: null });
    expect(fake.get).toHaveBeenCalledWith('device:ip:10.1.2.3:bmc:cipher', 'job-1');
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it('falls through to detection when the cache read throws', async () => {
    const { fake, redis } = fakeRedis();
    fake.get.mockRejectedValue(new Error('redis down'));
    mockedRun.mockResolvedValue(transportResult(true));

    const result = await resolveCipher(redis, device);

    expect(result).toEqual({ found: true, cipher: null });
    expect(mockedRun).toHaveBeenCalledTimes(1);
  });
});

describe('detectCipher probing', () => {
  it('probes the configured cipher list in order and returns the first working one', async () => {
    mockedRun.mockResolvedValueOnce(transportResult(false)).mockResolvedValueOnce(transportResult(true));

    const result = await detectCipher(device);

    expect(result).toEqual({ found: true, cipher: '3' });
    expect(mockedRun).toHaveBeenCalledTimes(2);

    const firstArgv = mockedRun.mock.calls[0]?.[0] ?? [];
    const secondArgv = mockedRun.mock.calls[1]?.[0] ?? [];
    expect(firstArgv).not.toContain('-C3');
    expect(firstArgv.slice(-2)).toEqual(['power', 'status']);
    expect(secondArgv).toContain('-C3');
    expect(mockedRun.mock.calls[1]?.[2]).toBe(15);
    expect(mockedRun.mock.calls[1]?.[3]).toEqual({ cipherUsed: '3', jobId: 'job-1' });
  });

  it('returns found=false when every probe fails', async () => {
    mockedRun.mockResolvedValue(transportResult(false));

    const result = await detectCipher(device);

    expect(result).toEqual({ found: false, cipher: null });
    expect(mockedRun).toHaveBeenCalledTimes(3);
    expect(mockedRun.mock.calls[2]?.[0]).toContain('-C17');
  });
});

describe('resolveCipher detection and caching', () => {
  it('caches a detected cipher under the plaintext device key when deviceId is known', async () => {
    const { fake, redis } = fakeRedis();
    mockedRun.mockResolvedValueOnce(transportResult(false)).mockResolvedValueOnce(transportResult(true));

    const result = await resolveCipher(redis, device, 'dev-1');

    expect(result).toEqual({ found: true, cipher: '3' });
    expect(fake.set).toHaveBeenCalledTimes(1);
    const call = fake.set.mock.calls[0];
    expect(call?.[0]).toBe('device:dev-1:bmc:cipher');
    expect(call?.[1]).toBe('3');
    expect(fake.secretHset).not.toHaveBeenCalled();
  });

  it('caches the __none__ sentinel under the ip key when no deviceId', async () => {
    const { fake, redis } = fakeRedis();
    mockedRun.mockResolvedValue(transportResult(true));

    const result = await resolveCipher(redis, device);

    expect(result).toEqual({ found: true, cipher: null });
    const call = fake.set.mock.calls[0];
    expect(call?.[0]).toBe('device:ip:10.1.2.3:bmc:cipher');
    expect(call?.[1]).toBe('__none__');
    expect(fake.secretHset).not.toHaveBeenCalled();
  });

  it('does NOT cache when all probes fail', async () => {
    const { fake, redis } = fakeRedis();
    mockedRun.mockResolvedValue(transportResult(false));

    const result = await resolveCipher(redis, device, 'dev-1');

    expect(result).toEqual({ found: false, cipher: null });
    expect(fake.secretHset).not.toHaveBeenCalled();
    expect(fake.set).not.toHaveBeenCalled();
  });

  it('getCipherForDevice drops the found signal', async () => {
    const { redis } = fakeRedis();
    mockedRun.mockResolvedValue(transportResult(false));

    const cipher = await getCipherForDevice(redis, device);

    expect(cipher).toBeNull();
  });
});

describe('cacheValueToCipher decoding', () => {
  it('decodes the __none__ sentinel and a real cipher string via resolveCipher cache hits', async () => {
    const { fake, redis } = fakeRedis();
    fake.get.mockResolvedValueOnce('__none__');
    expect(await resolveCipher(redis, device)).toEqual({ found: true, cipher: null });

    fake.get.mockResolvedValueOnce('17');
    expect(await resolveCipher(redis, device)).toEqual({ found: true, cipher: '17' });

    fake.get.mockResolvedValueOnce('');
    mockedRun.mockResolvedValue(transportResult(true));
    expect(await resolveCipher(redis, device)).toEqual({ found: true, cipher: null });
  });
});

describe('file-cache fallback', () => {
  let tmpDir: string;
  let originalCacheDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ipmi-cipher-'));
    const cfg = getIpmiConfig();
    originalCacheDir = cfg.cipherCacheDir;
    Reflect.set(cfg, 'cipherCacheDir', tmpDir);
  });

  function restoreCacheDir(): void {
    const cfg = getIpmiConfig();
    Reflect.set(cfg, 'cipherCacheDir', originalCacheDir);
    rmSync(tmpDir, { recursive: true, force: true });
  }

  it('reads a non-empty file-cache entry and skips probing', async () => {
    const { redis } = fakeRedis();
    writeFileSync(join(tmpDir, '10_1_2_3.cipher'), '17');
    const cipher = await getCipherForDevice(redis, device);
    expect(cipher).toBe('17');
    expect(mockedRun).not.toHaveBeenCalled();
    restoreCacheDir();
  });

  it('treats an empty file-cache entry as a successful null-cipher detect', async () => {
    const { redis } = fakeRedis();
    writeFileSync(join(tmpDir, '10_1_2_3.cipher'), '');
    const cipher = await getCipherForDevice(redis, device);
    expect(cipher).toBeNull();
    expect(mockedRun).not.toHaveBeenCalled();
    restoreCacheDir();
  });
});
