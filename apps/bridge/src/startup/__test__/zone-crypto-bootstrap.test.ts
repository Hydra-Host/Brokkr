import { createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { RedisEncryptionError } from '../../common/redis/redis-client/redis.errors.js';
import { KEY_SIZE } from '../../zone-crypto/auth-dh.types.js';
import { zoneCryptoFromCacheBlob, zoneCryptoToCacheBlob } from '../../zone-crypto/zone-crypto.service.js';
import {
  BOOTSTRAP_LOCK_KEY,
  ZoneCryptoBootstrapService,
  type FetchLike,
  type ZoneCryptoBootstrapOptions,
  type ZoneCryptoCache,
  type ZoneCryptoCodec,
  type ZoneCryptoConfig,
  type ZoneCryptoSnapshot,
} from '../zone-crypto-bootstrap.js';

const ZONE_ID = '00000000-0000-4000-8000-000000000001';
const HUB_URL = 'https://hub.test';
const TOKEN = 'tok-abc123';
const CACHE_KEY = 'zone_crypto:state';
const SAMPLE_HUB_PUB = Buffer.from(Array.from({ length: KEY_SIZE }, (_, b) => (b * 7) % 256));

function hmacHex(key: Buffer | string, ...parts: (string | Buffer)[]): string {
  const mac = createHmac('sha256', typeof key === 'string' ? Buffer.from(key, 'utf8') : key);
  for (const part of parts) {
    mac.update(typeof part === 'string' ? Buffer.from(part, 'utf8') : part);
  }
  return mac.digest('hex');
}

function fastConfig(overrides: Partial<ZoneCryptoConfig> = {}): ZoneCryptoConfig {
  return {
    hubUrl: HUB_URL,
    cacheKey: CACHE_KEY,
    markerPath: '/tmp/zone-crypto-test/zone-crypto.lock',
    registrationToken: TOKEN,
    httpTimeoutSeconds: 5,
    pollTotalTimeoutSeconds: 0.1,
    pollInitialBackoffSeconds: 0.01,
    pollMaxBackoffSeconds: 0.02,
    ...overrides,
  };
}

interface CacheMockOptions {
  initialGet?: string | null;
  lockToken?: string | null;
  setOk?: boolean;
}

function makeCacheMock(opts: CacheMockOptions = {}): ZoneCryptoCache & {
  secretGet: Mock<(...args: any[]) => any>;
  secretSet: Mock<(...args: any[]) => any>;
  acquireLock: Mock<(...args: any[]) => any>;
  releaseLock: Mock<(...args: any[]) => any>;
} {
  const initialGet = opts.initialGet ?? null;
  const lockToken = opts.lockToken === undefined ? 'lock-token-abc' : opts.lockToken;
  const setOk = opts.setOk ?? true;
  return {
    secretGet: vi.fn(async () => initialGet),
    secretSet: vi.fn(async () => setOk),
    acquireLock: vi.fn(async () => lockToken),
    releaseLock: vi.fn(async () => true),
  };
}

interface MarkerStore {
  exists(path: string): boolean;
  write(path: string, body: string): Promise<void>;
  contents(path: string): string | undefined;
}

function makeMarkerStore(initial: Set<string> = new Set<string>()): MarkerStore {
  const files = new Map<string, string>();
  for (const p of initial) files.set(p, 'preexisting');
  return {
    exists: (path) => files.has(path),
    write: async (path, body) => {
      files.set(path, body);
    },
    contents: (path) => files.get(path),
  };
}

interface CodecRecorder {
  codec: ZoneCryptoCodec;
  active: ZoneCryptoSnapshot | null;
}

function makeCodec(): CodecRecorder {
  const rec: CodecRecorder = { codec: null as unknown as ZoneCryptoCodec, active: null };
  rec.codec = {
    fromCacheBlob: (blob) => zoneCryptoFromCacheBlob(blob),
    toCacheBlob: (state) => zoneCryptoToCacheBlob(state),
    setActive: (state) => {
      rec.active = state;
    },
  };
  return rec;
}

interface FetchSpec {
  status?: number;
  payload?: unknown;
  body?: string;
  contentType?: string;
  exception?: Error;
  callback?: (
    url: string,
    body: { registration_token: string; zone_pub: string; mac: string },
  ) => {
    status: number;
    payload?: unknown;
    body?: string;
    contentType?: string;
  };
}

function makeFetch(spec: FetchSpec): FetchLike {
  return async (input, init) => {
    if (spec.exception) throw spec.exception;
    const requestBody = init?.body
      ? (JSON.parse(init.body as string) as { registration_token: string; zone_pub: string; mac: string })
      : { registration_token: '', zone_pub: '', mac: '' };
    let status = spec.status ?? 200;
    let payload = spec.payload;
    let body = spec.body;
    let contentType = spec.contentType ?? 'application/json';
    if (spec.callback) {
      const r = spec.callback(input as string, requestBody);
      status = r.status;
      payload = r.payload;
      body = r.body;
      if (r.contentType) contentType = r.contentType;
    }
    const responseBody = body !== undefined ? body : JSON.stringify(payload ?? {});
    return new Response(responseBody, {
      status,
      headers: { 'content-type': contentType },
    });
  };
}

function buildService(
  cache: ZoneCryptoCache,
  fetchImpl: FetchLike | undefined,
  marker: MarkerStore,
  configOverrides: Partial<ZoneCryptoConfig> = {},
  codecOverride?: ZoneCryptoCodec,
  exitOverride?: (code: number) => never,
): { service: ZoneCryptoBootstrapService; codec: CodecRecorder; config: ZoneCryptoConfig } {
  const rec = makeCodec();
  const config = fastConfig(configOverrides);
  const options: ZoneCryptoBootstrapOptions = {
    cache,
    config,
    zoneId: ZONE_ID,
    codec: codecOverride ?? rec.codec,
    fetchImpl,
    markerWriter: marker.write,
    markerExists: marker.exists,
    sleep: async () => {},
    ...(exitOverride ? { exit: exitOverride } : {}),
  };
  const service = new ZoneCryptoBootstrapService('', options);
  return { service, codec: rec, config };
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ZoneCryptoBootstrapService — dormancy and identity', () => {
  it('returns false when hub URL is empty (master switch off)', async () => {
    const cache = makeCacheMock();
    const marker = makeMarkerStore();
    const { service, codec } = buildService(cache, undefined, marker, { hubUrl: '' });
    expect(await service.run()).toBe(false);
    expect(codec.active).toBeNull();
    expect(cache.secretGet).not.toHaveBeenCalled();
  });

  it('returns false when BROKKR_ZONE_ID is unset', async () => {
    const cache = makeCacheMock();
    const marker = makeMarkerStore();
    const rec = makeCodec();
    const service = new ZoneCryptoBootstrapService('', {
      cache,
      config: fastConfig(),
      zoneId: '',
      codec: rec.codec,
      markerWriter: marker.write,
      markerExists: marker.exists,
      sleep: async () => {},
    });
    expect(await service.run()).toBe(false);
    expect(rec.active).toBeNull();
    expect(cache.secretGet).not.toHaveBeenCalled();
    expect(cache.acquireLock).not.toHaveBeenCalled();
  });
});

describe('ZoneCryptoBootstrapService — cache load', () => {
  it('loads existing state from cache and skips lock acquisition', async () => {
    const existing: ZoneCryptoSnapshot = {
      zonePriv: Buffer.from(Array.from({ length: KEY_SIZE }, (_, i) => i)),
      zonePub: Buffer.from(Array.from({ length: KEY_SIZE }, (_, i) => KEY_SIZE - 1 - i)),
      hubPub: SAMPLE_HUB_PUB,
      enrolledAt: 1_730_000_000_000,
    };
    const blob = zoneCryptoToCacheBlob(existing).toString('utf8');
    const cache = makeCacheMock({ initialGet: blob });
    const marker = makeMarkerStore();
    const { service, codec } = buildService(cache, undefined, marker);
    expect(await service.run()).toBe(true);
    expect(codec.active).toEqual(existing);
    expect(cache.acquireLock).not.toHaveBeenCalled();
  });

  it('falls through to follower poll on Redis error during cache read', async () => {
    const cache = makeCacheMock({ lockToken: null });
    cache.secretGet = vi.fn().mockRejectedValueOnce(new Error('redis down')).mockResolvedValue(null);
    const marker = makeMarkerStore();
    const { service } = buildService(cache, undefined, marker);
    expect(await service.run()).toBe(false);
    expect(cache.acquireLock).toHaveBeenCalledOnce();
  });

  it('falls through when the cache blob is schema-invalid (no marker)', async () => {
    const cache = makeCacheMock({ lockToken: null });
    cache.secretGet = vi.fn().mockResolvedValueOnce('{"not": "a valid blob"}').mockResolvedValue(null);
    const marker = makeMarkerStore();
    const { service } = buildService(cache, undefined, marker);
    expect(await service.run()).toBe(false);
    expect(cache.acquireLock).toHaveBeenCalledOnce();
  });
});

describe('ZoneCryptoBootstrapService — enrollment as leader', () => {
  it('logs and returns false when registration token is missing', async () => {
    const cache = makeCacheMock({ initialGet: null });
    const marker = makeMarkerStore();
    const { service, codec } = buildService(cache, undefined, marker, { registrationToken: '' });
    expect(await service.run()).toBe(false);
    expect(codec.active).toBeNull();
    expect(cache.acquireLock).toHaveBeenCalledOnce();
    expect(cache.releaseLock).toHaveBeenCalledOnce();
    expect(cache.secretSet).not.toHaveBeenCalled();
  });

  it('completes enrollment, persists the blob and releases the lock', async () => {
    const cache = makeCacheMock({ initialGet: null });
    const marker = makeMarkerStore();
    let capturedBody: { registration_token: string; zone_pub: string; mac: string } | null = null;
    const fetchImpl = makeFetch({
      callback: (_url, body) => {
        capturedBody = body;
        const zonePub = Buffer.from(body.zone_pub, 'hex');
        return {
          status: 200,
          payload: {
            hub_pub: SAMPLE_HUB_PUB.toString('hex'),
            mac: hmacHex(TOKEN, ZONE_ID, zonePub, SAMPLE_HUB_PUB),
          },
        };
      },
    });
    const { service, codec } = buildService(cache, fetchImpl, marker);

    expect(await service.run()).toBe(true);
    expect(codec.active).not.toBeNull();
    expect(codec.active?.hubPub.equals(SAMPLE_HUB_PUB)).toBe(true);
    expect(codec.active?.zonePriv.length).toBe(KEY_SIZE);
    expect(codec.active?.zonePub.length).toBe(KEY_SIZE);
    expect(codec.active?.enrolledAt).toBeGreaterThan(0);

    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.registration_token).toBe(TOKEN);
    const zonePub = Buffer.from(capturedBody!.zone_pub, 'hex');
    expect(capturedBody!.mac).toBe(hmacHex(TOKEN, ZONE_ID, zonePub));

    expect(cache.secretSet).toHaveBeenCalledOnce();
    const writtenBlob = cache.secretSet.mock.calls[0][1] as string;
    expect(writtenBlob.includes('zone_priv')).toBe(true);
    expect(writtenBlob.includes('hub_pub')).toBe(true);

    expect(cache.releaseLock).toHaveBeenCalledWith(BOOTSTRAP_LOCK_KEY, 'lock-token-abc', '');
  });

  it('treats 409 as token_consumed_no_cache and releases the lock', async () => {
    const cache = makeCacheMock({ initialGet: null });
    const marker = makeMarkerStore();
    const fetchImpl = makeFetch({ status: 409, body: 'token already consumed' });
    const { service, codec } = buildService(cache, fetchImpl, marker);
    expect(await service.run()).toBe(false);
    expect(codec.active).toBeNull();
    expect(cache.secretSet).not.toHaveBeenCalled();
    expect(cache.releaseLock).toHaveBeenCalledOnce();
  });

  it('treats non-409 4xx as hub_rejected_token', async () => {
    const cache = makeCacheMock({ initialGet: null });
    const marker = makeMarkerStore();
    const fetchImpl = makeFetch({ status: 400, body: 'bad request' });
    const { service } = buildService(cache, fetchImpl, marker);
    expect(await service.run()).toBe(false);
    expect(cache.secretSet).not.toHaveBeenCalled();
    expect(cache.releaseLock).toHaveBeenCalledOnce();
  });

  it('treats fetch rejection as network_error', async () => {
    const cache = makeCacheMock({ initialGet: null });
    const marker = makeMarkerStore();
    const fetchImpl = makeFetch({ exception: new Error('connection refused') });
    const { service } = buildService(cache, fetchImpl, marker);
    expect(await service.run()).toBe(false);
    expect(cache.secretSet).not.toHaveBeenCalled();
    expect(cache.releaseLock).toHaveBeenCalledOnce();
  });

  it('treats AbortSignal timeout as network_error', async () => {
    const cache = makeCacheMock({ initialGet: null });
    const marker = makeMarkerStore();
    const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    const fetchImpl = makeFetch({ exception: timeout });
    const { service } = buildService(cache, fetchImpl, marker);
    expect(await service.run()).toBe(false);
    expect(cache.secretSet).not.toHaveBeenCalled();
    expect(cache.releaseLock).toHaveBeenCalledOnce();
  });

  it('rejects malformed JSON bodies as hub_response_invalid', async () => {
    const cache = makeCacheMock({ initialGet: null });
    const marker = makeMarkerStore();
    const fetchImpl = makeFetch({ status: 200, body: 'this is not json', contentType: 'application/json' });
    const { service, codec } = buildService(cache, fetchImpl, marker);
    expect(await service.run()).toBe(false);
    expect(codec.active).toBeNull();
    expect(cache.secretSet).not.toHaveBeenCalled();
    expect(cache.releaseLock).toHaveBeenCalledOnce();
  });

  it('rejects unexpected content-types as hub_response_invalid', async () => {
    const cache = makeCacheMock({ initialGet: null });
    const marker = makeMarkerStore();
    const fetchImpl = makeFetch({ status: 200, body: '<html>oops</html>', contentType: 'text/html' });
    const { service, codec } = buildService(cache, fetchImpl, marker);
    expect(await service.run()).toBe(false);
    expect(codec.active).toBeNull();
    expect(cache.secretSet).not.toHaveBeenCalled();
    expect(cache.releaseLock).toHaveBeenCalledOnce();
  });

  it('rejects responses with an invalid MAC', async () => {
    const cache = makeCacheMock({ initialGet: null });
    const marker = makeMarkerStore();
    const fetchImpl = makeFetch({
      callback: (_url, _body) => ({
        status: 200,
        payload: { hub_pub: SAMPLE_HUB_PUB.toString('hex'), mac: '0'.repeat(64) },
      }),
    });
    const { service, codec } = buildService(cache, fetchImpl, marker);
    expect(await service.run()).toBe(false);
    expect(codec.active).toBeNull();
    expect(cache.secretSet).not.toHaveBeenCalled();
    expect(cache.releaseLock).toHaveBeenCalledOnce();
  });

  it('rejects responses missing hub_pub', async () => {
    const cache = makeCacheMock({ initialGet: null });
    const marker = makeMarkerStore();
    const fetchImpl = makeFetch({ status: 200, payload: { mac: '0'.repeat(64) } });
    const { service } = buildService(cache, fetchImpl, marker);
    expect(await service.run()).toBe(false);
    expect(cache.secretSet).not.toHaveBeenCalled();
    expect(cache.releaseLock).toHaveBeenCalledOnce();
  });

  it('rejects hub_pub with the wrong length', async () => {
    const cache = makeCacheMock({ initialGet: null });
    const marker = makeMarkerStore();
    const fetchImpl = makeFetch({
      status: 200,
      payload: { hub_pub: '00'.repeat(16), mac: '0'.repeat(64) },
    });
    const { service } = buildService(cache, fetchImpl, marker);
    expect(await service.run()).toBe(false);
    expect(cache.secretSet).not.toHaveBeenCalled();
    expect(cache.releaseLock).toHaveBeenCalledOnce();
  });

  it('returns false when the cache write reports failure', async () => {
    const cache = makeCacheMock({ initialGet: null, setOk: false });
    const marker = makeMarkerStore();
    const fetchImpl = makeFetch({
      callback: (_url, body) => {
        const zonePub = Buffer.from(body.zone_pub, 'hex');
        return {
          status: 200,
          payload: {
            hub_pub: SAMPLE_HUB_PUB.toString('hex'),
            mac: hmacHex(TOKEN, ZONE_ID, zonePub, SAMPLE_HUB_PUB),
          },
        };
      },
    });
    const { service, codec } = buildService(cache, fetchImpl, marker);
    expect(await service.run()).toBe(false);
    expect(codec.active).toBeNull();
    expect(cache.secretSet).toHaveBeenCalledOnce();
    expect(cache.releaseLock).toHaveBeenCalledOnce();
  });
});

describe('ZoneCryptoBootstrapService — follower path', () => {
  it('returns true when the cache appears on a subsequent poll', async () => {
    const existing: ZoneCryptoSnapshot = {
      zonePriv: Buffer.from(Array.from({ length: KEY_SIZE }, (_, i) => i)),
      zonePub: Buffer.from(Array.from({ length: KEY_SIZE }, (_, i) => KEY_SIZE - 1 - i)),
      hubPub: SAMPLE_HUB_PUB,
      enrolledAt: 1_730_000_000_000,
    };
    const appearingBlob = zoneCryptoToCacheBlob(existing).toString('utf8');
    const cache = makeCacheMock({ lockToken: null });
    cache.secretGet = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(appearingBlob);
    const marker = makeMarkerStore();
    const { service, codec } = buildService(cache, undefined, marker);
    expect(await service.run()).toBe(true);
    expect(codec.active).toEqual(existing);
  });

  it('times out cleanly when the cache never appears', async () => {
    const cache = makeCacheMock({ lockToken: null });
    cache.secretGet = vi.fn(async () => null);
    const marker = makeMarkerStore();
    const { service, codec } = buildService(cache, undefined, marker);
    expect(await service.run()).toBe(false);
    expect(codec.active).toBeNull();
  });

  it('clamps poll sleep so it never overshoots the total deadline', async () => {
    let fakeNow = 0;
    const realPerfNow = performance.now;
    performance.now = () => fakeNow;
    try {
      const sleepDurations: number[] = [];
      const cache = makeCacheMock({ lockToken: null });
      cache.secretGet = vi.fn(async () => null);
      const marker = makeMarkerStore();
      const rec = makeCodec();
      const config = fastConfig({
        pollInitialBackoffSeconds: 300,
        pollMaxBackoffSeconds: 300,
        pollTotalTimeoutSeconds: 10,
      });
      const service = new ZoneCryptoBootstrapService('', {
        cache,
        config,
        zoneId: ZONE_ID,
        codec: rec.codec,
        markerWriter: marker.write,
        markerExists: marker.exists,
        sleep: async (ms: number) => {
          sleepDurations.push(ms);
          fakeNow += ms;
        },
      });
      expect(await service.run()).toBe(false);
      const totalMs = sleepDurations.reduce((a, b) => a + b, 0);
      expect(totalMs).toBeLessThanOrEqual(10_000);
      expect(Math.max(...sleepDurations)).toBeLessThanOrEqual(10_000);
    } finally {
      performance.now = realPerfNow;
    }
  });
});

describe('ZoneCryptoBootstrapService — does-not-raise contract', () => {
  it('coerces acquireLock exceptions to false (does not release token)', async () => {
    const cache = makeCacheMock({ initialGet: null });
    cache.acquireLock = vi.fn(async () => {
      throw new Error('redis melted');
    });
    const marker = makeMarkerStore();
    const { service, codec } = buildService(cache, undefined, marker);
    expect(await service.run()).toBe(false);
    expect(codec.active).toBeNull();
    expect(cache.releaseLock).not.toHaveBeenCalled();
  });

  it('survives a releaseLock exception after successful enrollment', async () => {
    const cache = makeCacheMock({ initialGet: null });
    cache.releaseLock = vi.fn(async () => {
      throw new Error('redis blip');
    });
    const marker = makeMarkerStore();
    const fetchImpl = makeFetch({
      callback: (_url, body) => {
        const zonePub = Buffer.from(body.zone_pub, 'hex');
        return {
          status: 200,
          payload: {
            hub_pub: SAMPLE_HUB_PUB.toString('hex'),
            mac: hmacHex(TOKEN, ZONE_ID, zonePub, SAMPLE_HUB_PUB),
          },
        };
      },
    });
    const { service, codec } = buildService(cache, fetchImpl, marker);
    expect(await service.run()).toBe(true);
    expect(codec.active).not.toBeNull();
    expect(cache.secretSet).toHaveBeenCalledOnce();
    expect(cache.releaseLock).toHaveBeenCalledOnce();
  });
});

describe('ZoneCryptoBootstrapService — sticky marker / fail-closed', () => {
  it('does not fail closed on AEAD failure when no marker exists', async () => {
    const cache = makeCacheMock({ lockToken: null });
    cache.secretGet = vi.fn().mockRejectedValueOnce(new RedisEncryptionError('InvalidTag')).mockResolvedValue(null);
    const marker = makeMarkerStore();
    const { service, codec } = buildService(cache, undefined, marker);
    expect(await service.run()).toBe(false);
    expect(codec.active).toBeNull();
    expect(marker.exists('/tmp/zone-crypto-test/zone-crypto.lock')).toBe(false);
  });

  it('fails closed via exit(1) when AEAD fails AND the marker is present', async () => {
    class SystemExit extends Error {
      constructor(public code: number) {
        super(`exit ${code}`);
      }
    }
    const markerPath = '/tmp/zone-crypto-test/zone-crypto.lock';
    const marker = makeMarkerStore(new Set([markerPath]));
    const cache = makeCacheMock();
    cache.secretGet = vi.fn(async () => {
      throw new RedisEncryptionError('InvalidTag');
    });

    const exit = vi.fn((code: number) => {
      throw new SystemExit(code);
    }) as unknown as (code: number) => never;
    const { service, codec } = buildService(cache, undefined, marker, { markerPath }, undefined, exit);
    await expect(service.run()).rejects.toBeInstanceOf(SystemExit);
    expect(exit).toHaveBeenCalledWith(1);
    expect(codec.active).toBeNull();
    expect(cache.acquireLock).not.toHaveBeenCalled();
  });

  it('fails closed via exit(1) on schema-invalid blob + marker present', async () => {
    class SystemExit extends Error {
      constructor(public code: number) {
        super(`exit ${code}`);
      }
    }
    const markerPath = '/tmp/zone-crypto-test/zone-crypto.lock';
    const marker = makeMarkerStore(new Set([markerPath]));
    const cache = makeCacheMock({ initialGet: '{"not": "a valid blob"}' });

    const exit = vi.fn((code: number) => {
      throw new SystemExit(code);
    }) as unknown as (code: number) => never;
    const { service, codec } = buildService(cache, undefined, marker, { markerPath }, undefined, exit);
    await expect(service.run()).rejects.toBeInstanceOf(SystemExit);
    expect(exit).toHaveBeenCalledWith(1);
    expect(codec.active).toBeNull();
    expect(cache.acquireLock).not.toHaveBeenCalled();
  });

  it('does NOT fail closed on transient Redis errors with marker present', async () => {
    const markerPath = '/tmp/zone-crypto-test/zone-crypto.lock';
    const marker = makeMarkerStore(new Set([markerPath]));
    const cache = makeCacheMock({ lockToken: null });
    cache.secretGet = vi.fn().mockRejectedValueOnce(new Error('redis down')).mockResolvedValue(null);

    const { service } = buildService(cache, undefined, marker, { markerPath });
    expect(await service.run()).toBe(false);
    expect(cache.acquireLock).toHaveBeenCalledOnce();
  });
});

describe('ZoneCryptoBootstrapService — sticky marker writing', () => {
  it('writes the marker after a successful enrollment', async () => {
    const markerPath = '/tmp/zone-crypto-test/zone-crypto.lock';
    const marker = makeMarkerStore();
    const cache = makeCacheMock({ initialGet: null });
    const fetchImpl = makeFetch({
      callback: (_url, body) => {
        const zonePub = Buffer.from(body.zone_pub, 'hex');
        return {
          status: 200,
          payload: {
            hub_pub: SAMPLE_HUB_PUB.toString('hex'),
            mac: hmacHex(TOKEN, ZONE_ID, zonePub, SAMPLE_HUB_PUB),
          },
        };
      },
    });
    const { service } = buildService(cache, fetchImpl, marker, { markerPath });
    expect(await service.run()).toBe(true);
    expect(marker.exists(markerPath)).toBe(true);
    const contents = marker.contents(markerPath) ?? '';
    expect(contents.includes(ZONE_ID)).toBe(true);
    expect(contents.includes('enrollment')).toBe(true);
  });

  it('writes the marker after a successful cache load', async () => {
    const existing: ZoneCryptoSnapshot = {
      zonePriv: Buffer.from(Array.from({ length: KEY_SIZE }, (_, i) => i)),
      zonePub: Buffer.from(Array.from({ length: KEY_SIZE }, (_, i) => KEY_SIZE - 1 - i)),
      hubPub: SAMPLE_HUB_PUB,
      enrolledAt: 1_730_000_000_000,
    };
    const blob = zoneCryptoToCacheBlob(existing).toString('utf8');
    const markerPath = '/tmp/zone-crypto-test/zone-crypto.lock';
    const marker = makeMarkerStore();
    const cache = makeCacheMock({ initialGet: blob });
    const { service } = buildService(cache, undefined, marker, { markerPath });
    expect(await service.run()).toBe(true);
    expect(marker.exists(markerPath)).toBe(true);
    expect(marker.contents(markerPath)?.includes('cache_load')).toBe(true);
  });

  it('boot still succeeds when marker write fails with an errno error', async () => {
    const cache = makeCacheMock({ initialGet: null });
    const markerPath = '/tmp/zone-crypto-test/blocker/zone-crypto.lock';
    const failingWriter = async () => {
      const err = Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
      throw err;
    };
    const marker: MarkerStore = {
      exists: () => false,
      write: failingWriter,
      contents: () => undefined,
    };
    const fetchImpl = makeFetch({
      callback: (_url, body) => {
        const zonePub = Buffer.from(body.zone_pub, 'hex');
        return {
          status: 200,
          payload: {
            hub_pub: SAMPLE_HUB_PUB.toString('hex'),
            mac: hmacHex(TOKEN, ZONE_ID, zonePub, SAMPLE_HUB_PUB),
          },
        };
      },
    });
    const { service, codec } = buildService(cache, fetchImpl, marker, { markerPath });
    expect(await service.run()).toBe(true);
    expect(codec.active).not.toBeNull();
  });
});
