import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { ZoneCryptoCache } from '../../startup/zone-crypto-bootstrap';
import { KEY_SIZE } from '../../zone-crypto/auth-dh.types';
import { resetZoneCryptoConfigForTests } from '../../zone-crypto/zone-crypto.config';
import {
  ZoneCryptoService,
  clearActiveZoneCryptoSnapshot,
  getActiveZoneCryptoSnapshot,
  zoneCryptoToCacheBlob,
  type ZoneCryptoSnapshot,
} from '../../zone-crypto/zone-crypto.service';
import { buildStartupArgs } from '../startup-args';
import { buildZoneCryptoBootstrapFactory } from '../zone-crypto-bootstrap-factory';

const ZONE_ID = '00000000-0000-4000-8000-000000000001';
const JOB_ID = 'zone-crypto-smoke';

function sampleSnapshot(): ZoneCryptoSnapshot {
  return {
    zonePriv: Buffer.from(Array.from({ length: KEY_SIZE }, (_, b) => b)),
    zonePub: Buffer.from(Array.from({ length: KEY_SIZE }, (_, b) => (b + 1) % 256)),
    hubPub: Buffer.from(Array.from({ length: KEY_SIZE }, (_, b) => (b + 2) % 256)),
    enrolledAt: 1_730_000_000_000,
  };
}

describe('buildZoneCryptoBootstrapFactory (wiring)', () => {
  beforeEach(() => {
    clearActiveZoneCryptoSnapshot();
    resetZoneCryptoConfigForTests();
  });

  afterEach(() => {
    clearActiveZoneCryptoSnapshot();
    resetZoneCryptoConfigForTests();
    vi.unstubAllEnvs();
  });

  it('returns a createBootstrap that produces a runnable bootstrap whose run() completes', async () => {
    vi.stubEnv('BROKKR_HUB_URL', '');
    vi.stubEnv('BROKKR_ZONE_ID', ZONE_ID);
    const deps = buildZoneCryptoBootstrapFactory({ zoneId: ZONE_ID });
    const bootstrap = deps.createBootstrap(JOB_ID);
    await expect(bootstrap.run()).resolves.toBe(false);
  });

  it('with BROKKR_HUB_URL unset: dormant path returns false, never touches cacheFactory', async () => {
    vi.stubEnv('BROKKR_HUB_URL', '');
    const cacheFactory = vi.fn<() => ZoneCryptoCache>(() => ({
      secretGet: vi.fn(),
      secretSet: vi.fn(),
      acquireLock: vi.fn(),
      releaseLock: vi.fn(),
    }));

    const deps = buildZoneCryptoBootstrapFactory({ cacheFactory, zoneId: ZONE_ID });
    const bootstrap = deps.createBootstrap(JOB_ID);
    await expect(bootstrap.run()).resolves.toBe(false);
    const cache = cacheFactory.mock.results[0]?.value as ZoneCryptoCache | undefined;
    expect(cache).toBeDefined();
    expect((cache!.secretGet as Mock<(...args: any[]) => any>).mock.calls).toEqual([]);
    expect((cache!.acquireLock as Mock<(...args: any[]) => any>).mock.calls).toEqual([]);
  });

  it('with BROKKR_ZONE_ID unset and hub_url set: returns false without throwing', async () => {
    vi.stubEnv('BROKKR_HUB_URL', 'https://hub.test');
    const deps = buildZoneCryptoBootstrapFactory({ zoneId: '' });
    const bootstrap = deps.createBootstrap(JOB_ID);
    await expect(bootstrap.run()).resolves.toBe(false);
  });

  it('passes the cacheCloser through as closeCache', () => {
    const cacheCloser = vi.fn(async () => {});

    const deps = buildZoneCryptoBootstrapFactory({ cacheCloser, zoneId: ZONE_ID });

    expect(deps.closeCache).toBe(cacheCloser);
  });

  it('loads from cacheFactory-supplied cache when blob is present and codec setActive writes the module-level holder', async () => {
    vi.stubEnv('BROKKR_HUB_URL', 'https://hub.test');
    const snapshot = sampleSnapshot();
    const blob = zoneCryptoToCacheBlob(snapshot).toString('utf8');
    const cache: ZoneCryptoCache = {
      secretGet: vi.fn(async () => blob),
      secretSet: vi.fn(async () => true),
      acquireLock: vi.fn(),
      releaseLock: vi.fn(),
    };
    const deps = buildZoneCryptoBootstrapFactory({
      cacheFactory: () => cache,
      zoneId: ZONE_ID,
      markerWriter: async () => undefined,
      markerExists: () => false,
    });

    const bootstrap = deps.createBootstrap(JOB_ID);
    await expect(bootstrap.run()).resolves.toBe(true);

    const active = getActiveZoneCryptoSnapshot();
    expect(active).not.toBeNull();
    expect(active!.zonePriv.equals(snapshot.zonePriv)).toBe(true);
    expect(active!.zonePub.equals(snapshot.zonePub)).toBe(true);
    expect(active!.hubPub.equals(snapshot.hubPub)).toBe(true);
    expect(active!.enrolledAt).toBe(snapshot.enrolledAt);
    const nestService = new ZoneCryptoService();
    expect(nestService.get()?.enrolledAt).toBe(snapshot.enrolledAt);
  });

  it('startup-args wires the factory into the zoneCryptoBootstrap slot and run() completes', async () => {
    vi.stubEnv('BROKKR_HUB_URL', '');
    vi.stubEnv('BROKKR_ZONE_ID', ZONE_ID);
    const args = buildStartupArgs({ BROKKR_HUB_URL: '', BROKKR_ZONE_ID: ZONE_ID });
    expect(args.zoneCryptoBootstrap.closeCache).toBeDefined();
    const bootstrap = args.zoneCryptoBootstrap.createBootstrap(JOB_ID);
    await expect(bootstrap.run()).resolves.not.toThrow;
  });
});
