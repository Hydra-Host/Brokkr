import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bridgeInstanceVersion } from '../../common/redis/redis-keys.js';
import { resetLeaderConfigForTests } from '../../leader-election/leader-election.config.js';
import type { DiscoveryImageSyncer, SyncVersionCache } from '../discovery-sync.js';
import { discoverySyncVersionKey, resetDiscoverySyncQueueForTests, syncDiscoveryImages } from '../discovery-sync.js';
import { resetPersistentStorageConfig, resetStorageConfig, resetSyncConfig } from '../sync.config.js';

const ROOT_URL = 'https://assets.test/brokkr-live';
const VERSION_REDIS_KEY = bridgeInstanceVersion('bridge-test', discoverySyncVersionKey('full', ROOT_URL));

class FakeVersionCache implements SyncVersionCache {
  readonly store = new Map<string, string>();
  readonly gets: string[] = [];
  readonly deletes: string[] = [];
  readonly sets: [string, string][] = [];

  get(key: string): Promise<string | null> {
    this.gets.push(key);
    return Promise.resolve(this.store.get(key) ?? null);
  }

  set(key: string, value: string): Promise<boolean> {
    this.store.set(key, value);
    this.sets.push([key, value]);
    return Promise.resolve(true);
  }

  delete(key: string): Promise<number> {
    this.deletes.push(key);
    return Promise.resolve(this.store.delete(key) ? 1 : 0);
  }
}

function createGate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe('discovery sync aliases and serialization', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'brokkr-discovery-sync-alias-'));
    process.env.PERSISTENT_STORAGE_PATH = baseDir;
    process.env.BRIDGE_HOSTNAME = 'bridge-test';
    process.env.DISCOVERY_BASE_URL = ROOT_URL;
    resetPersistentStorageConfig();
    resetStorageConfig();
    resetSyncConfig();
    resetLeaderConfigForTests();
  });

  afterEach(async () => {
    delete process.env.PERSISTENT_STORAGE_PATH;
    delete process.env.BRIDGE_HOSTNAME;
    delete process.env.BROKKR_LIVE_VERSION;
    delete process.env.DISCOVERY_BASE_URL;
    resetPersistentStorageConfig();
    resetStorageConfig();
    resetSyncConfig();
    resetLeaderConfigForTests();
    resetDiscoverySyncQueueForTests();
    await rm(baseDir, { recursive: true, force: true });
  });

  function setVersion(version: string): void {
    process.env.BROKKR_LIVE_VERSION = version;
    resetSyncConfig();
  }

  async function addDiscoveryFile(): Promise<void> {
    const directory = join(baseDir, 'brokkr-live', 'full', 'amd64');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'discovery.iso'), 'data');
  }

  it('does not skip an alias when the cache value matches', async () => {
    setVersion('latest-dev');
    await addDiscoveryFile();
    const cache = new FakeVersionCache();
    cache.store.set(VERSION_REDIS_KEY, 'latest-dev');
    const syncService = { syncDiscoveryImages: vi.fn(async () => 1) };

    await syncDiscoveryImages(cache, 'job-1', { syncService });

    expect(syncService.syncDiscoveryImages).toHaveBeenCalledTimes(1);
    expect(cache.gets).toEqual([]);
  });

  it('clears a pinned cache value after a successful alias sync', async () => {
    setVersion('latest-dev');
    const cache = new FakeVersionCache();
    cache.store.set(VERSION_REDIS_KEY, '1.2.3');
    const syncService = { syncDiscoveryImages: vi.fn(async () => 1) };

    await syncDiscoveryImages(cache, 'job-1', { syncService });

    expect(cache.deletes).toEqual([VERSION_REDIS_KEY]);
    expect(cache.sets).toEqual([]);
    expect(cache.store.has(VERSION_REDIS_KEY)).toBe(false);
  });

  it('skips an explicit version when the cache value matches', async () => {
    setVersion('1.2.3');
    await addDiscoveryFile();
    const cache = new FakeVersionCache();
    cache.store.set(VERSION_REDIS_KEY, '1.2.3');
    const syncService = { syncDiscoveryImages: vi.fn(async () => 1) };

    await syncDiscoveryImages(cache, 'job-1', { syncService });

    expect(syncService.syncDiscoveryImages).not.toHaveBeenCalled();
    expect(cache.store.get(VERSION_REDIS_KEY)).toBe('1.2.3');
  });

  it('does not overlap concurrent sync calls', async () => {
    setVersion('latest-dev');
    const cache = new FakeVersionCache();
    const gate = createGate();
    let activeCalls = 0;
    let maximumActiveCalls = 0;
    const firstSync: DiscoveryImageSyncer = {
      syncDiscoveryImages: vi.fn(async () => {
        activeCalls += 1;
        maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls);
        await gate.promise;
        activeCalls -= 1;
        return 1;
      }),
    };
    const secondSync: DiscoveryImageSyncer = {
      syncDiscoveryImages: vi.fn(async () => {
        activeCalls += 1;
        maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls);
        activeCalls -= 1;
        return 1;
      }),
    };

    const firstCall = syncDiscoveryImages(cache, 'job-1', { syncService: firstSync });
    await vi.waitFor(() => expect(firstSync.syncDiscoveryImages).toHaveBeenCalledTimes(1));
    const secondCall = syncDiscoveryImages(cache, 'job-2', { syncService: secondSync });
    await Promise.resolve();

    expect(secondSync.syncDiscoveryImages).not.toHaveBeenCalled();
    gate.open();
    await Promise.all([firstCall, secondCall]);
    expect(secondSync.syncDiscoveryImages).toHaveBeenCalledTimes(1);
    expect(maximumActiveCalls).toBe(1);
  });

  it('rejects the caller promise when the sync fails', async () => {
    setVersion('latest-dev');
    const cache = new FakeVersionCache();
    const syncService = {
      syncDiscoveryImages: vi.fn(async () => {
        throw new Error('sync failed');
      }),
    };

    await expect(syncDiscoveryImages(cache, 'saga-job', { syncService })).rejects.toThrow('sync failed');
  });
});
