import { createHash, randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ContextLogger } from '../../logger/logger.service';
import {
  AgentTokenMintContentionError,
  AgentTokenService,
  type AgentTokenCache,
  type AuthSubject,
  type DeviceSubject,
  type DiscoverySubject,
} from '../agent-token.service';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function makeLogger(): ContextLogger {
  return new ContextLogger();
}

class FakeCache implements AgentTokenCache {
  secret = new Map<string, string>();
  secretTtl = new Map<string, number>();
  locks = new Map<string, string>();

  async delete(key: string): Promise<number> {
    const existed = this.secret.has(key);
    this.secret.delete(key);
    this.secretTtl.delete(key);
    return existed ? 1 : 0;
  }

  async secretSet(key: string, value: string, ttl?: number | null): Promise<unknown> {
    this.secret.set(key, value);
    if (ttl !== undefined && ttl !== null) this.secretTtl.set(key, ttl);
    return true;
  }

  async secretGet(key: string): Promise<string | null> {
    return this.secret.has(key) ? this.secret.get(key)! : null;
  }

  async acquireLock(lockKey: string): Promise<string | null> {
    if (this.locks.has(lockKey)) return null;
    const token = randomUUID();
    this.locks.set(lockKey, token);
    return token;
  }

  async releaseLock(lockKey: string, token: string): Promise<boolean> {
    if (this.locks.get(lockKey) === token) {
      this.locks.delete(lockKey);
      return true;
    }
    return false;
  }
}

class ScriptedLockCache extends FakeCache {
  private idx = 0;
  acquireCalls = 0;

  constructor(
    private readonly results: ReadonlyArray<string | null>,
    private readonly onAcquire?: (callCount: number) => Promise<void>,
  ) {
    super();
  }

  async acquireLock(_lockKey: string): Promise<string | null> {
    const i = Math.min(this.idx, this.results.length - 1);
    const result = this.results[i];
    this.idx += 1;
    this.acquireCalls += 1;
    if (this.onAcquire) await this.onAcquire(this.acquireCalls);
    return result;
  }
}

function hashKeyOf(token: string): string {
  return `agent-token:hash:${sha256Hex(token)}`;
}

function deviceKeyOf(deviceId: string): string {
  return `agent-token:device:${deviceId}`;
}

function discoveryKeyOf(discoveryId: string): string {
  return `agent-token:discovery:${discoveryId}`;
}

function parseJsonRecord(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined) throw new Error('expected JSON string, got undefined');
  return JSON.parse(raw) as Record<string, unknown>;
}

function isDevice(subject: AuthSubject | null): subject is DeviceSubject {
  return subject !== null && subject.kind === 'device';
}

function isDiscovery(subject: AuthSubject | null): subject is DiscoverySubject {
  return subject !== null && subject.kind === 'discovery';
}

describe('AgentTokenService — types and construction', () => {
  it('exposes device + discovery subject kinds', () => {
    const device: DeviceSubject = { kind: 'device', deviceId: '1610', issuedAt: 1 };
    const discovery: DiscoverySubject = {
      kind: 'discovery',
      discoveryId: 'aa:bb:cc:dd:ee:ff',
      issuedAt: 1,
      expiresAt: 2,
    };
    expect(device.kind).toBe('device');
    expect(discovery.kind).toBe('discovery');
  });

  it('accepts injected cache + option overrides', () => {
    const cache = new FakeCache();
    const svc = new AgentTokenService(cache, makeLogger(), { tokenBytes: 32, discoveryTtlS: 300 });
    expect(svc.deviceTtlS).toBeGreaterThan(0);
    expect(svc).toBeInstanceOf(AgentTokenService);
  });
});

describe('AgentTokenService.mintDevice', () => {
  it('writes both indices and returns the raw token', async () => {
    const cache = new FakeCache();
    const svc = new AgentTokenService(cache, makeLogger());

    const token = await svc.mintDevice('1610');

    expect(typeof token).toBe('string');
    expect(token).toHaveLength(64);
    const hashRecord = parseJsonRecord(cache.secret.get(hashKeyOf(token)));
    expect(hashRecord['kind']).toBe('device');
    expect(hashRecord['device_id']).toBe('1610');
    const deviceBlob = parseJsonRecord(cache.secret.get(deviceKeyOf('1610')));
    expect(deviceBlob['token']).toBe(token);
  });

  it('sets sliding TTL on both indices using deviceTtlS', async () => {
    const cache = new FakeCache();
    const svc = new AgentTokenService(cache, makeLogger(), { deviceTtlS: 7_776_000 });
    const token = await svc.mintDevice('1610');
    expect(cache.secretTtl.get(hashKeyOf(token))).toBe(7_776_000);
    expect(cache.secretTtl.get(deviceKeyOf('1610'))).toBe(7_776_000);
  });

  it('compensates the hash record when the device-keyed write fails', async () => {
    class FailingCache extends FakeCache {
      async secretSet(key: string, value: string, ttl?: number | null): Promise<unknown> {
        if (key.startsWith('agent-token:device:')) {
          throw new Error('redis write failed');
        }
        return super.secretSet(key, value, ttl);
      }
    }
    const failing = new FailingCache();
    const svc = new AgentTokenService(failing, makeLogger());

    await expect(svc.mintDevice('1610')).rejects.toThrow(/redis write failed/);

    expect(failing.secret.size).toBe(0);
  });
});

describe('AgentTokenService.verify', () => {
  it('returns a device subject for a freshly minted device token', async () => {
    const cache = new FakeCache();
    const svc = new AgentTokenService(cache, makeLogger());
    const token = await svc.mintDevice('1610');

    const subject = await svc.verify(token);

    expect(isDevice(subject)).toBe(true);
    if (isDevice(subject)) expect(subject.deviceId).toBe('1610');
  });

  it('returns null for an unknown token', async () => {
    const svc = new AgentTokenService(new FakeCache(), makeLogger());
    expect(await svc.verify('deadbeef'.repeat(8))).toBeNull();
  });

  it('returns null for an empty token', async () => {
    const svc = new AgentTokenService(new FakeCache(), makeLogger());
    expect(await svc.verify('')).toBeNull();
  });

  type Mutate = (payload: Record<string, unknown>) => string | Record<string, unknown>;

  const mutations: ReadonlyArray<{ name: string; mutate: Mutate }> = [
    { name: 'bad_json', mutate: () => 'not-json' },
    {
      name: 'missing_kind',
      mutate: (p) => {
        const { kind: _kind, ...rest } = p;
        return rest;
      },
    },
    { name: 'unknown_kind', mutate: (p) => ({ ...p, kind: 'alien' }) },
    {
      name: 'missing_issued_at',
      mutate: (p) => {
        const { issued_at: _i, ...rest } = p;
        return rest;
      },
    },
    { name: 'non_int_issued_at', mutate: (p) => ({ ...p, issued_at: 'not-an-int' }) },
    {
      name: 'missing_device_id',
      mutate: (p) => {
        const { device_id: _d, ...rest } = p;
        return rest;
      },
    },
  ];

  it.each(mutations)('returns null for malformed device payload: $name', async ({ mutate }) => {
    const cache = new FakeCache();
    const svc = new AgentTokenService(cache, makeLogger());
    const token = await svc.mintDevice('1610');
    const key = hashKeyOf(token);
    const payload = parseJsonRecord(cache.secret.get(key));
    const mutated = mutate(payload);
    cache.secret.set(key, typeof mutated === 'string' ? mutated : JSON.stringify(mutated));

    expect(await svc.verify(token)).toBeNull();
  });
});

describe('AgentTokenService.mintOrReuseDevice', () => {
  it('reuses an existing token for the same device', async () => {
    const svc = new AgentTokenService(new FakeCache(), makeLogger());
    const a = await svc.mintOrReuseDevice('1610');
    const b = await svc.mintOrReuseDevice('1610');
    expect(a).toBe(b);
  });

  it('mints distinct tokens for distinct devices', async () => {
    const svc = new AgentTokenService(new FakeCache(), makeLogger());
    const a = await svc.mintOrReuseDevice('1610');
    const b = await svc.mintOrReuseDevice('1611');
    expect(a).not.toBe(b);
  });

  it('serializes concurrent callers — single token, single hash record', async () => {
    const cache = new FakeCache();
    const svc = new AgentTokenService(cache, makeLogger());

    const results = await Promise.all(Array.from({ length: 8 }, () => svc.mintOrReuseDevice('1610')));

    expect(new Set(results).size).toBe(1);
    const hashKeys = [...cache.secret.keys()].filter((k) => k.startsWith('agent-token:hash:'));
    expect(hashKeys).toHaveLength(1);
  });

  it('slides TTL on the reuse path', async () => {
    const cache = new FakeCache();
    const svc = new AgentTokenService(cache, makeLogger(), { deviceTtlS: 7_776_000 });
    const token = await svc.mintOrReuseDevice('1610');

    for (const k of [...cache.secretTtl.keys()]) cache.secretTtl.set(k, 10);

    const reused = await svc.mintOrReuseDevice('1610');
    expect(reused).toBe(token);
    expect(cache.secretTtl.get(hashKeyOf(token))).toBe(7_776_000);
    expect(cache.secretTtl.get(deviceKeyOf('1610'))).toBe(7_776_000);
  });

  it('succeeds on retry after lock-TTL sleep when the peer crashed', async () => {
    const cache = new ScriptedLockCache([null, 'fresh-lock-token']);
    const svc = new AgentTokenService(cache, makeLogger(), {
      mintLockTimeoutS: 0.05,
      mintPollIntervalS: 0.005,
      mintPollIterations: 3,
    });

    const token = await svc.mintOrReuseDevice('1610');

    expect(typeof token).toBe('string');
    expect(token).toHaveLength(64);
    expect(cache.acquireCalls).toBe(2);
    const hashKeys = [...cache.secret.keys()].filter((k) => k.startsWith('agent-token:hash:'));
    expect(hashKeys).toHaveLength(1);
    expect(cache.secret.has(deviceKeyOf('1610'))).toBe(true);
  });

  it('short-circuits to the peer token if the peer finishes during TTL sleep', async () => {
    const peerToken = 'peer-minted-token-0123456789abcdef0123456789abcdef0123456789ab01';
    const peerHash = sha256Hex(peerToken);
    const devicePayload = JSON.stringify({
      token: peerToken,
      hash: peerHash,
      issued_at: Math.floor(Date.now() / 1000),
    });
    const hashPayload = JSON.stringify({
      kind: 'device',
      device_id: '1610',
      issued_at: Math.floor(Date.now() / 1000),
    });

    const onAcquire = async (callCount: number): Promise<void> => {
      if (callCount === 1) {
        cache.secret.set(deviceKeyOf('1610'), devicePayload);
        cache.secret.set(`agent-token:hash:${peerHash}`, hashPayload);
      }
    };

    const cache = new ScriptedLockCache([null, null], onAcquire);
    const svc = new AgentTokenService(cache, makeLogger(), {
      mintLockTimeoutS: 0.05,
      mintPollIntervalS: 0.005,
      mintPollIterations: 3,
    });

    const got = await svc.mintOrReuseDevice('1610');
    expect(got).toBe(peerToken);
    expect(cache.acquireCalls).toBe(1);
  });

  it('raises AgentTokenMintContentionError when the lock stays contended', async () => {
    const cache = new ScriptedLockCache([null, null]);
    const svc = new AgentTokenService(cache, makeLogger(), {
      mintLockTimeoutS: 0.05,
      mintPollIntervalS: 0.005,
      mintPollIterations: 3,
    });

    await expect(svc.mintOrReuseDevice('1610')).rejects.toBeInstanceOf(AgentTokenMintContentionError);

    const hashKeys = [...cache.secret.keys()].filter((k) => k.startsWith('agent-token:hash:'));
    expect(hashKeys).toHaveLength(0);
    expect(cache.secret.has(deviceKeyOf('1610'))).toBe(false);
  });
});

describe('AgentTokenService — discovery flow', () => {
  it('mintDiscovery writes both indices with kind=discovery', async () => {
    const cache = new FakeCache();
    const svc = new AgentTokenService(cache, makeLogger(), { discoveryTtlS: 3600 });

    const token = await svc.mintDiscovery('aa:bb:cc:dd:ee:ff');

    expect(typeof token).toBe('string');
    expect(token).toHaveLength(64);
    const hashRecord = parseJsonRecord(cache.secret.get(hashKeyOf(token)));
    expect(hashRecord['kind']).toBe('discovery');
    expect(hashRecord['discovery_id']).toBe('aa:bb:cc:dd:ee:ff');
    expect(hashRecord['expires_at'] as number).toBeGreaterThan(hashRecord['issued_at'] as number);
    const discoveryBlob = parseJsonRecord(cache.secret.get(discoveryKeyOf('aa:bb:cc:dd:ee:ff')));
    expect(discoveryBlob['token']).toBe(token);
  });

  it('verify returns a discovery subject for a freshly minted discovery token', async () => {
    const cache = new FakeCache();
    const svc = new AgentTokenService(cache, makeLogger());
    const token = await svc.mintDiscovery('aa:bb:cc:dd:ee:ff');

    const subject = await svc.verify(token);

    expect(isDiscovery(subject)).toBe(true);
    if (isDiscovery(subject)) expect(subject.discoveryId).toBe('aa:bb:cc:dd:ee:ff');
  });

  it('mintOrReuseDiscovery is per-MAC independent and idempotent', async () => {
    const svc = new AgentTokenService(new FakeCache(), makeLogger());

    const a1 = await svc.mintOrReuseDiscovery('aa:bb:cc:dd:ee:ff');
    const a2 = await svc.mintOrReuseDiscovery('aa:bb:cc:dd:ee:ff');
    const b1 = await svc.mintOrReuseDiscovery('11:22:33:44:55:66');

    expect(a1).toBe(a2);
    expect(a1).not.toBe(b1);
  });

  it('mintOrReuseDiscovery serializes concurrent callers for the same MAC', async () => {
    const cache = new FakeCache();
    const svc = new AgentTokenService(cache, makeLogger());

    const results = await Promise.all(Array.from({ length: 8 }, () => svc.mintOrReuseDiscovery('aa:bb:cc:dd:ee:ff')));

    expect(new Set(results).size).toBe(1);
    const hashKeys = [...cache.secret.keys()].filter((k) => k.startsWith('agent-token:hash:'));
    expect(hashKeys).toHaveLength(1);
  });
});
