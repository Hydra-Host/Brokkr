import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const holder = { redis: null as unknown as ScriptedRedis };
  const RedisCtor = vi.fn(function () {
    return holder.redis;
  });
  return { holder, RedisCtor };
});

vi.mock('ioredis', () => ({ default: h.RedisCtor }));

import type { ProcessEnv } from '../../contract';
import { RedisConnectionsService } from '../../datastore/redis-connections.service';
import { NULL_RUN_SINK } from '../../runner/run-sink';
import { RunnerService } from '../../runner/runner.service';
import {
  assembleDiscoveryItems,
  blobsToItems,
  computeDiscoveryOk,
  discoverySyncFromStatus,
  listFiles,
  originHostFromBaseUrl,
  readCacheMetadata,
  REQUIRED_DISCOVERY_FILES,
  StorageService,
} from '../storage.service';

class ScriptedRedis {
  on = vi.fn();
  disconnect = vi.fn();
  scan = vi.fn();
  del = vi.fn();
}

const ZONE = '00000000-0000-0000-0000-111111111111';

describe('listFiles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'list-'));
  mkdirSync(join(dir, 'arm64'));
  writeFileSync(join(dir, 'top.img'), Buffer.alloc(10));
  writeFileSync(join(dir, 'arm64', 'nested.efi'), Buffer.alloc(10));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('recurses into subdirectories and counts every file', () => {
    const items = listFiles(dir);
    expect(items.length).toBe(2);
  });
  it('uses a path relative to the base dir for nested files', () => {
    const names = listFiles(dir)
      .map((i) => i.name)
      .sort();
    expect(names).toEqual(['arm64/nested.efi', 'top.img']);
  });
  it('returns [] for an absent dir', () => {
    expect(listFiles(join(dir, 'nope'))).toEqual([]);
  });
});

describe('originHostFromBaseUrl', () => {
  it('extracts the host', () => {
    expect(originHostFromBaseUrl('https://brokkr.assets.hydra.host/brokkr-live')).toBe('brokkr.assets.hydra.host');
  });
  it('returns empty string on garbage', () => {
    expect(originHostFromBaseUrl('not a url')).toBe('');
  });
});

describe('readCacheMetadata', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sha-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  it('parses the sha map', () => {
    writeFileSync(join(dir, '.cache_metadata.json'), JSON.stringify({ vmlinuz: { sha256sum: 'abc' } }));
    expect(readCacheMetadata(dir).vmlinuz?.sha256sum).toBe('abc');
  });
  it('returns {} when missing', () => {
    expect(readCacheMetadata(join(dir, 'nope'))).toEqual({});
  });
});

describe('assembleDiscoveryItems', () => {
  it('merges inventory + sha + path + served per flavor tree', () => {
    const inv = [
      { flavor: 'light', arch: 'arm64', files: [{ name: 'vmlinuz', present: true, sizeBytes: 5, mtimeMs: 9 }] },
    ];
    const items = assembleDiscoveryItems(
      inv,
      '/base',
      { 'light/arm64': { vmlinuz: 'sha1' } },
      { 'light/arm64': { vmlinuz: true } },
    );
    expect(items[0]).toEqual({
      name: 'vmlinuz',
      present: true,
      sizeBytes: 5,
      mtimeMs: 9,
      path: '/base/light/arm64/vmlinuz',
      flavor: 'light',
      arch: 'arm64',
      sha256: 'sha1',
      served: true,
    });
  });

  it('leaves the path empty when the storage root is unknown', () => {
    const inv = [
      { flavor: 'full', arch: 'amd64', files: [{ name: 'vmlinuz', present: false, sizeBytes: 0, mtimeMs: 0 }] },
    ];
    expect(assembleDiscoveryItems(inv, null, {}, {})[0]?.path).toBe('');
  });
});

describe('computeDiscoveryOk', () => {
  const mk = (present: boolean, served: boolean) =>
    REQUIRED_DISCOVERY_FILES.map((name) => ({
      name,
      present,
      sizeBytes: 1,
      mtimeMs: 1,
      path: `/b/arm64/${name}`,
      arch: 'arm64',
      served,
    }));
  it('true when all required present + served', () => {
    expect(computeDiscoveryOk(mk(true, true), 'arm64', REQUIRED_DISCOVERY_FILES)).toBe(true);
  });
  it('false when any not served', () => {
    expect(computeDiscoveryOk(mk(true, false), 'arm64', REQUIRED_DISCOVERY_FILES)).toBe(false);
  });
  it('false when host arch absent', () => {
    expect(computeDiscoveryOk(mk(true, true), 'amd64', REQUIRED_DISCOVERY_FILES)).toBe(false);
  });
});

describe('blobsToItems', () => {
  const shaA = 'a'.repeat(64);
  const shaB = 'b'.repeat(64);

  it('maps blobs 1:1 to items, preserving size/mtime/path with a sha256: name', () => {
    const items = blobsToItems([
      { sha: shaA, path: '/cache/a/aa/x', sizeBytes: 100, mtimeMs: 5 },
      { sha: shaB, path: '/cache/b/bb/y', sizeBytes: 50, mtimeMs: 9 },
    ]);
    expect(items[0]).toEqual({
      name: `sha256:${shaA}`,
      present: true,
      sizeBytes: 100,
      mtimeMs: 5,
      path: '/cache/a/aa/x',
      sha256: shaA,
    });
    expect(items.length).toBe(2);
    expect(items.reduce((n, i) => n + i.sizeBytes, 0)).toBe(150);
  });

  it('returns [] for no blobs', () => {
    expect(blobsToItems([])).toEqual([]);
  });
});

describe('discoverySyncFromStatus', () => {
  const wire = {
    at: 1700,
    outcome: 'failed',
    error: 'manifest fetch returned 404',
    base_url: 'https://assets.example/brokkr-live',
    version: 'latest-dev',
    flavors: ['light', 'full'],
  };
  const { base_url, ...restOfWire } = wire;
  const sync = { ...restOfWire, baseUrl: base_url };

  it('reads the last sync outcome from the spoke status body and maps the snake_case root url', () => {
    expect(discoverySyncFromStatus({ bridge_url: 'http://spoke:8000', discovery_sync: wire })).toEqual(sync);
  });

  it('reports no last sync when the status body still carries the camelCase root url', () => {
    expect(discoverySyncFromStatus({ discovery_sync: sync })).toBeNull();
  });

  it('reports no last sync when the status body carries none', () => {
    expect(discoverySyncFromStatus({ bridge_url: 'http://spoke:8000' })).toBeNull();
    expect(discoverySyncFromStatus({ discovery_sync: null })).toBeNull();
  });

  it('reports no last sync rather than throwing when the body does not parse', () => {
    expect(discoverySyncFromStatus({ discovery_sync: { at: 'soon', outcome: 'ok' } })).toBeNull();
    expect(discoverySyncFromStatus(null)).toBeNull();
  });
});

const spokeEnv = (vars: Record<string, string>): ProcessEnv => ({
  name: 'spoke',
  source: 'configured',
  vars: Object.entries(vars).map(([key, value]) => ({ key, value, secret: false, origin: 'process' })),
});

const inventoryFiles = (present: boolean) =>
  REQUIRED_DISCOVERY_FILES.map((name) => ({ name, present, sizeBytes: present ? 7 : 0, mtimeMs: present ? 1_000 : 0 }));

const inventory = {
  architectures: [
    { flavor: 'light', arch: 'arm64', files: inventoryFiles(true) },
    { flavor: 'full', arch: 'arm64', files: inventoryFiles(false) },
  ],
};

const servedOnEveryHost = {
  architectures: ['arm64', 'amd64'].flatMap((arch) => [
    { flavor: 'light', arch, files: inventoryFiles(true) },
    { flavor: 'full', arch, files: inventoryFiles(false) },
  ]),
};

const SPOKE_VARS = {
  BROKKR_LIVE_VERSION: '1.1.9',
  DISCOVERY_BASE_URL: 'https://origin.example/brokkr-live',
  DISCOVERY_ARCHITECTURES: 'arm64',
  DISCOVERY_FLAVORS: 'light,full',
  PERSISTENT_STORAGE_PATH: '/srv/spoke-x',
};

const storageService = (getProcessEnv: () => Promise<ProcessEnv | null>) =>
  new StorageService(
    new RunnerService(NULL_RUN_SINK),
    { restartAndWait: () => Promise.resolve(true), list: () => Promise.resolve([]) },
    { cachedBlobs: () => Promise.resolve([]) },
    { getProcessEnv },
    new RedisConnectionsService(),
  );

describe('StorageService.state', () => {
  const env = vi.fn<() => ProcessEnv | null>(() => spokeEnv(SPOKE_VARS));
  const service = () => storageService(() => Promise.resolve(env()));

  const statusBody = vi.fn<() => unknown>(() => ({ bridge_url: 'http://spoke:8000' }));

  beforeEach(() => {
    env.mockClear();
    statusBody.mockReset().mockReturnValue({ bridge_url: 'http://spoke:8000' });
    vi.stubGlobal('fetch', (url: string) =>
      Promise.resolve(new Response(JSON.stringify(String(url).endsWith('/api/status') ? statusBody() : inventory))),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('reports the spoke last discovery sync from its status route', async () => {
    statusBody.mockReturnValue({
      bridge_url: 'http://spoke:8000',
      discovery_sync: {
        at: 1700,
        outcome: 'ok',
        error: null,
        base_url: 'https://origin.example/brokkr-live',
        version: '1.1.9',
        flavors: ['light'],
      },
    });

    const state = await service().state();

    expect(state.lastSync).toEqual({
      at: 1700,
      outcome: 'ok',
      error: null,
      baseUrl: 'https://origin.example/brokkr-live',
      version: '1.1.9',
      flavors: ['light'],
    });
  });

  it('reports no last sync while the status route carries none', async () => {
    expect((await service().state()).lastSync).toBeNull();
  });

  it('reads the provenance from the spoke env on every poll', async () => {
    env
      .mockReturnValueOnce(spokeEnv(SPOKE_VARS))
      .mockReturnValueOnce(spokeEnv({ ...SPOKE_VARS, BROKKR_LIVE_VERSION: '1.2.0' }));
    const svc = service();

    const first = (await svc.state()).provenance;
    const second = (await svc.state()).provenance;

    expect(first).toMatchObject({
      version: '1.1.9',
      baseUrl: 'https://origin.example/brokkr-live',
      originHost: 'origin.example',
      architectures: ['arm64'],
      hostArch: expect.stringMatching(/^(arm64|amd64)$/),
    });
    expect(first.flavors).toEqual([
      { name: 'light', present: true, fileCount: 3, sizeBytes: 21 },
      { name: 'full', present: false, fileCount: 0, sizeBytes: 0 },
    ]);
    expect(second.version).toBe('1.2.0');
    expect(env).toHaveBeenCalledTimes(2);
  });

  it('resolves the storage root from the spoke process env', async () => {
    vi.stubEnv('PERSISTENT_STORAGE_PATH', '/tmp/not-the-spoke');

    const state = await service().state();
    const byId = Object.fromEntries(state.categories.map((c) => [c.id, c]));

    expect(byId['discovery-images']?.path).toBe('/srv/spoke-x/brokkr-live');
    expect(byId['built-artifacts']?.path).toBe('/srv/spoke-x/initrd-builds');
    expect(byId['discovery-images']?.items[0]?.path).toBe('/srv/spoke-x/brokkr-live/light/arm64/vmlinuz');
  });

  it('tells the operator the built artifacts come back through a rebuild', async () => {
    const state = await service().state();

    expect(state.categories.find((c) => c.id === 'built-artifacts')?.detail).toBe(
      'built by Build → agent; wiping needs a rebuild',
    );
  });

  it('reports the spoke-rooted paths as unknown when the spoke env cannot be read', async () => {
    env.mockReturnValue(null);

    const state = await service().state();
    const byId = Object.fromEntries(state.categories.map((c) => [c.id, c]));

    expect(byId['discovery-images']?.path).toBe('');
    expect(byId['built-artifacts']?.path).toBe('');
    expect(byId['built-artifacts']?.detail).toContain('spoke env');
  });
});

describe('StorageService.resync', () => {
  const spoke = (pid: number | null) => (pid === null ? [] : [{ name: 'spoke', status: 'Running', pid }]);
  const calls: string[] = [];

  const resync = (pids: [number, number | null], restarted = true) => {
    const runner = new RunnerService(NULL_RUN_SINK);
    const emit = vi.spyOn(runner, 'emit');
    const finalize = vi.spyOn(runner, 'finalize');
    const list = vi.fn().mockResolvedValueOnce(spoke(pids[0])).mockResolvedValueOnce(spoke(pids[1]));
    const service = new StorageService(
      runner,
      {
        restartAndWait: () => {
          calls.push('restart');
          return Promise.resolve(restarted);
        },
        list,
      },
      { cachedBlobs: () => Promise.resolve([]) },
      {
        getProcessEnv: () =>
          Promise.resolve(spokeEnv({ ...SPOKE_VARS, BRIDGE_HOSTNAME: 'spoke-a', DISCOVERY_ARCHITECTURES: 'arm64' })),
      },
      new RedisConnectionsService(),
    );
    service.resync();
    return { emit, finalize };
  };

  beforeEach(() => {
    calls.length = 0;
    h.holder.redis = new ScriptedRedis();
    h.holder.redis.scan
      .mockResolvedValueOnce(['3', [`${ZONE}:bridge:spoke-a:version:brokkr-live-https:light:0a1b2c3d`]])
      .mockResolvedValueOnce(['0', [`${ZONE}:bridge:spoke-a:version:brokkr-live-https:full:0a1b2c3d`]]);
    h.holder.redis.del.mockImplementation((...keys: string[]) => {
      calls.push('del');
      return Promise.resolve(keys.length);
    });
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify(servedOnEveryHost))));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('clears the sync version keys before restarting the spoke', async () => {
    const { emit, finalize } = resync([100, 200]);

    await vi.waitFor(() => expect(finalize).toHaveBeenCalled());

    expect(h.holder.redis.scan).toHaveBeenNthCalledWith(
      1,
      '0',
      'MATCH',
      '*:bridge:spoke-a:version:brokkr-live-https*',
      'COUNT',
      200,
    );
    expect(calls).toEqual(['del', 'del', 'restart']);
    expect(emit.mock.calls.map(([, text]) => text)).toContainEqual(
      expect.stringContaining('[storage] cleared the sync version cache (2 keys)'),
    );
  });

  it('fails the resync when the spoke pid does not change', async () => {
    const { emit, finalize } = resync([4242, 4242], false);

    await vi.waitFor(() => expect(finalize).toHaveBeenCalled());

    expect(finalize.mock.calls[0]?.[1]).toBe(1);
    expect(emit.mock.calls.map(([, text]) => text)).toContainEqual(
      expect.stringContaining('spoke process did not change (pid 4242); restart it from the Stack page'),
    );
  });

  it('reports a stop-or-start failure when the restart fails with a changed pid', async () => {
    const { emit, finalize } = resync([4242, 4343], false);

    await vi.waitFor(() => expect(finalize).toHaveBeenCalled());

    const texts = emit.mock.calls.map(([, text]) => text);
    expect(finalize.mock.calls[0]?.[1]).toBe(1);
    expect(texts).toContainEqual(expect.stringContaining('spoke failed to restart (stop or start)'));
    expect(texts).not.toContainEqual(expect.stringContaining('spoke process did not change'));
  });

  it('reports a stop-or-start failure when the restart fails and the spoke is gone from the roster', async () => {
    const { emit, finalize } = resync([4242, null], false);

    await vi.waitFor(() => expect(finalize).toHaveBeenCalled());

    const texts = emit.mock.calls.map(([, text]) => text);
    expect(finalize.mock.calls[0]?.[1]).toBe(1);
    expect(texts).toContainEqual(expect.stringContaining('spoke failed to restart (stop or start)'));
    expect(texts).not.toContainEqual(expect.stringContaining('spoke process did not change'));
  });
});

describe('StorageService.verify', () => {
  const manifestUrl = `${SPOKE_VARS.DISCOVERY_BASE_URL}-light/1.1.9/arm64/manifest.json`;
  const root = mkdtempSync(join(tmpdir(), 'verify-'));
  mkdirSync(join(root, 'brokkr-live', 'light', 'arm64'), { recursive: true });
  writeFileSync(
    join(root, 'brokkr-live', 'light', 'arm64', '.cache_metadata.json'),
    JSON.stringify({ vmlinuz: { sha256sum: 'abc' } }),
  );
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const lightOnly = { architectures: [{ flavor: 'light', arch: 'arm64', files: inventoryFiles(true) }] };

  const service = () =>
    storageService(() => Promise.resolve(spokeEnv({ ...SPOKE_VARS, PERSISTENT_STORAGE_PATH: root })));

  const stubFetch = (manifest: (init: RequestInit | undefined) => Promise<Response>) => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      seen.push(url);
      if (url.endsWith('/api/discovery/inventory')) return Promise.resolve(new Response(JSON.stringify(lightOnly)));
      return manifest(init);
    });
    return seen;
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('names a manifest timeout instead of reporting unverified', async () => {
    vi.useFakeTimers();
    const seen = stubFetch(
      (init) =>
        new Promise((_, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
        ),
    );

    const pending = service().verify();
    await vi.advanceTimersByTimeAsync(20_000);
    const { results } = await pending;

    expect(seen).toContain(manifestUrl);
    expect(results.map((r) => [r.flavor, r.arch, r.name, r.status, r.manifestError])).toEqual(
      REQUIRED_DISCOVERY_FILES.map((name) => ['light', 'arm64', name, 'manifest-unreachable', 'timed out after 20s']),
    );
  });

  it('names a manifest timeout when the body read never settles', async () => {
    vi.useFakeTimers();
    stubFetch((init) =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start: (controller) =>
              init?.signal?.addEventListener('abort', () =>
                controller.error(new DOMException('aborted', 'AbortError')),
              ),
          }),
        ),
      ),
    );

    const pending = service().verify();
    await vi.advanceTimersByTimeAsync(20_000);
    const { results } = await pending;

    expect(results[0]).toMatchObject({ status: 'manifest-unreachable', manifestError: 'timed out after 20s' });
  });

  it('names an http failure and an unusable manifest', async () => {
    stubFetch(() => Promise.resolve(new Response('nope', { status: 502 })));
    expect((await service().verify()).results[0]).toMatchObject({
      status: 'manifest-unreachable',
      manifestError: 'HTTP 502',
    });

    vi.unstubAllGlobals();
    stubFetch(() => Promise.resolve(new Response(JSON.stringify({ hello: 'world' }))));
    expect((await service().verify()).results[0]).toMatchObject({
      status: 'manifest-invalid',
      manifestError: expect.stringContaining('files'),
    });
  });

  it('compares the local sha and names a file the cache never hashed', async () => {
    stubFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify({ files: [{ name: 'vmlinuz', sha256sum: 'abc' }, { name: 'initrd.img' }] })),
      ),
    );

    const { results } = await service().verify();

    expect(results.map((r) => [r.name, r.status, r.manifestError])).toEqual([
      ['vmlinuz', 'match', null],
      ['initrd.img', 'no-local-sha', null],
      ['brokkr-discovery.iso', 'no-local-sha', null],
    ]);
  });
});
