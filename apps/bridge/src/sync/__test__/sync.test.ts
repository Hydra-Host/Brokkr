import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bridgeInstanceVersion } from '../../common/redis/redis-keys.js';
import { getDiscoverySyncRecord, resetDiscoverySyncRecordForTests } from '../../composition/discovery-sync-holder.js';
import type { DiscoveryFlavor } from '../../download/discovery.config.js';
import { resetDiscoveryFileConfig } from '../../download/discovery.config.js';
import { resetLeaderConfigForTests } from '../../leader-election/leader-election.config.js';
import type { FetchLike } from '../brokkr-live-https-sync.service.js';
import {
  BrokkrLiveHTTPSSyncService,
  buildArchCacheDir,
  buildDiscoveryManifestUrl,
  buildFlavorBaseUrl,
  classifyDownloadVerification,
  decideCacheAction,
  HTTPSSyncError,
} from '../brokkr-live-https-sync.service.js';
import type { SyncVersionCache } from '../discovery-sync.js';
import { discoverySyncVersionKey, resetDiscoverySyncQueueForTests, syncDiscoveryImages } from '../discovery-sync.js';
import { resetPersistentStorageConfig, resetStorageConfig, resetSyncConfig } from '../sync.config.js';

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

const ROOT_URL = 'https://assets.test/brokkr-live';

function versionKeyFor(flavor: DiscoveryFlavor, rootUrl: string): string {
  return bridgeInstanceVersion('bridge-test', discoverySyncVersionKey(flavor, rootUrl));
}

class FakeVersionCache implements SyncVersionCache {
  store = new Map<string, string>();
  deletes: string[] = [];
  sets: [string, string, number | null][] = [];

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.store.get(key) ?? null);
  }

  set(key: string, value: string, ttl: number | null = null): Promise<boolean> {
    this.store.set(key, value);
    this.sets.push([key, value, ttl]);
    return Promise.resolve(true);
  }

  delete(key: string): Promise<number> {
    this.deletes.push(key);
    return Promise.resolve(this.store.delete(key) ? 1 : 0);
  }
}

describe('pure sync helpers', () => {
  it('buildDiscoveryManifestUrl strips trailing slashes', () => {
    expect(buildDiscoveryManifestUrl('https://assets.example/brokkr-live/', '1.0.4', 'amd64')).toBe(
      'https://assets.example/brokkr-live/1.0.4/amd64/manifest.json',
    );
  });

  it('buildArchCacheDir joins the flavor and arch subdirs', () => {
    expect(buildArchCacheDir('/brokkr/brokkr-live', 'light', 'arm64')).toBe('/brokkr/brokkr-live/light/arm64');
  });

  it('buildFlavorBaseUrl appends -light for the light flavor and nothing for full', () => {
    expect(buildFlavorBaseUrl('https://assets.example/brokkr-live/', 'light')).toBe(
      'https://assets.example/brokkr-live-light',
    );
    expect(buildFlavorBaseUrl('https://assets.example/brokkr-live', 'full')).toBe('https://assets.example/brokkr-live');
  });

  it('classifyDownloadVerification checks size before sha', () => {
    expect(classifyDownloadVerification(10, 'aa', 11, 'bb')).toBe('size_mismatch');
    expect(classifyDownloadVerification(10, 'aa', 10, 'bb')).toBe('sha256_mismatch');
    expect(classifyDownloadVerification(10, 'aa', 10, 'aa')).toBe('ok');
    expect(classifyDownloadVerification(10, 'aa', 0, '')).toBe('ok');
  });

  it('decideCacheAction requires manifest sha, matching cache, and an existing file to skip', () => {
    expect(decideCacheAction(null, { sha256sum: 'x' }, true)).toBe('download');
    expect(decideCacheAction({}, { sha256sum: 'x' }, true)).toBe('download');
    expect(decideCacheAction({ sha256sum: 'x' }, null, true)).toBe('download');
    expect(decideCacheAction({ sha256sum: 'x' }, { sha256sum: 'y' }, true)).toBe('download');
    expect(decideCacheAction({ sha256sum: 'x' }, { sha256sum: 'x' }, false)).toBe('download');
    expect(decideCacheAction({ sha256sum: 'x' }, { sha256sum: 'x' }, true)).toBe('skip');
  });
});

describe('BrokkrLiveHTTPSSyncService', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'brokkr-sync-'));
    process.env.PERSISTENT_STORAGE_PATH = baseDir;
    process.env.HTTPS_RETRY_ATTEMPTS = '2';
    process.env.HTTPS_RETRY_DELAY = '0';
    resetPersistentStorageConfig();
    resetStorageConfig();
    resetSyncConfig();
  });

  afterEach(async () => {
    delete process.env.PERSISTENT_STORAGE_PATH;
    delete process.env.HTTPS_RETRY_ATTEMPTS;
    delete process.env.HTTPS_RETRY_DELAY;
    delete process.env.DISCOVERY_ARCHITECTURES;
    resetPersistentStorageConfig();
    resetStorageConfig();
    resetSyncConfig();
    resetDiscoveryFileConfig();
    await rm(baseDir, { recursive: true, force: true });
  });

  function makeFetch(routes: Record<string, () => Response>): FetchLike {
    return (input) => {
      const url = String(input);
      for (const [suffix, make] of Object.entries(routes)) {
        if (url.endsWith(suffix)) return Promise.resolve(make());
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    };
  }

  it('downloads manifest files, verifies sha256, and writes cache metadata', async () => {
    const isoContent = 'fake-iso-bytes';
    const manifest = {
      version: '1.0.4',
      architecture: 'amd64',
      files: [{ name: 'brokkr-live-amd64.iso', size: isoContent.length, sha256sum: sha256Hex(isoContent) }],
    };
    const fetchFn = makeFetch({
      '/amd64/manifest.json': () => new Response(JSON.stringify(manifest), { status: 200 }),
      '/amd64/brokkr-live-amd64.iso': () => new Response(isoContent, { status: 200 }),
    });

    const service = new BrokkrLiveHTTPSSyncService('job-1', fetchFn);
    const synced = await service.syncDiscoveryImages('full');

    expect(synced).toBe(1);
    const archDir = join(baseDir, 'brokkr-live', 'full', 'amd64');
    expect(await readFile(join(archDir, 'brokkr-live-amd64.iso'), 'utf-8')).toBe(isoContent);
    const metadata = JSON.parse(await readFile(join(archDir, '.cache_metadata.json'), 'utf-8'));
    expect(metadata['brokkr-live-amd64.iso'].sha256sum).toBe(sha256Hex(isoContent));
  });

  it('iterates architectures from DISCOVERY_ARCHITECTURES, not a hardcoded list', async () => {
    process.env.DISCOVERY_ARCHITECTURES = 'amd64,riscv64';
    resetDiscoveryFileConfig();

    const iso = 'bytes';
    const manifestFor = (arch: string): string =>
      JSON.stringify({ files: [{ name: `f-${arch}.iso`, size: iso.length, sha256sum: sha256Hex(iso) }] });
    const requested: string[] = [];
    const fetchFn: FetchLike = (input) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith('/amd64/manifest.json'))
        return Promise.resolve(new Response(manifestFor('amd64'), { status: 200 }));
      if (url.endsWith('/riscv64/manifest.json'))
        return Promise.resolve(new Response(manifestFor('riscv64'), { status: 200 }));
      if (url.endsWith('.iso')) return Promise.resolve(new Response(iso, { status: 200 }));
      return Promise.resolve(new Response('not found', { status: 404 }));
    };

    const service = new BrokkrLiveHTTPSSyncService('job-1', fetchFn);
    const synced = await service.syncDiscoveryImages('full');

    expect(requested.some((u) => u.endsWith('/riscv64/manifest.json'))).toBe(true);
    expect(requested.some((u) => u.endsWith('/arm64/manifest.json'))).toBe(false);
    expect(synced).toBe(2);
  });

  it('drops path-traversal arch names from DISCOVERY_ARCHITECTURES before they reach join()', async () => {
    process.env.DISCOVERY_ARCHITECTURES = 'amd64,..';
    resetDiscoveryFileConfig();

    const iso = 'bytes';
    const manifest = JSON.stringify({ files: [{ name: 'f.iso', size: iso.length, sha256sum: sha256Hex(iso) }] });
    const requested: string[] = [];
    const fetchFn: FetchLike = (input) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith('/amd64/manifest.json')) return Promise.resolve(new Response(manifest, { status: 200 }));
      if (url.endsWith('.iso')) return Promise.resolve(new Response(iso, { status: 200 }));
      return Promise.resolve(new Response('not found', { status: 404 }));
    };

    const service = new BrokkrLiveHTTPSSyncService('job-1', fetchFn);
    const synced = await service.syncDiscoveryImages('full');

    expect(requested.some((u) => u.includes('/../'))).toBe(false);
    expect(synced).toBe(1);
    expect(await readdir(baseDir)).not.toContain('.cache_metadata.json');
  });

  it('throws HTTPSSyncError on sha256 mismatch and removes the temp file', async () => {
    const manifest = {
      files: [{ name: 'brokkr-live-amd64.iso', size: 4, sha256sum: 'deadbeef' }],
    };
    const fetchFn = makeFetch({
      '/amd64/manifest.json': () => new Response(JSON.stringify(manifest), { status: 200 }),
      '/amd64/brokkr-live-amd64.iso': () => new Response('blob', { status: 200 }),
    });

    const service = new BrokkrLiveHTTPSSyncService('job-1', fetchFn);
    await expect(service.syncDiscoveryImages('full')).rejects.toThrow('sha256sum mismatch');

    const archDir = join(baseDir, 'brokkr-live', 'full', 'amd64');
    const leftover = await readdir(archDir);
    expect(leftover).not.toContain('brokkr-live-amd64.iso.tmp');
    expect(leftover).not.toContain('brokkr-live-amd64.iso');
  });

  it('throws HTTPSSyncError on size mismatch', async () => {
    const content = 'blob';
    const manifest = {
      files: [{ name: 'f.iso', size: 999, sha256sum: sha256Hex(content) }],
    };
    const fetchFn = makeFetch({
      '/amd64/manifest.json': () => new Response(JSON.stringify(manifest), { status: 200 }),
      '/amd64/f.iso': () => new Response(content, { status: 200 }),
    });

    const service = new BrokkrLiveHTTPSSyncService('job-1', fetchFn);
    await expect(service.syncDiscoveryImages('full')).rejects.toThrow('Size mismatch');
  });

  it('rejects a downloadable manifest entry that has no sha256sum and caches nothing', async () => {
    const content = 'unverified';
    const manifest = {
      files: [{ name: 'no-sha.iso', size: content.length }],
    };
    let downloadAttempts = 0;
    const fetchFn = makeFetch({
      '/amd64/manifest.json': () => new Response(JSON.stringify(manifest), { status: 200 }),
      '/amd64/no-sha.iso': () => {
        downloadAttempts += 1;
        return new Response(content, { status: 200 });
      },
    });

    const service = new BrokkrLiveHTTPSSyncService('job-1', fetchFn);
    await expect(service.syncDiscoveryImages('full')).rejects.toThrow(HTTPSSyncError);

    expect(downloadAttempts).toBe(0);
    const archDir = join(baseDir, 'brokkr-live', 'full', 'amd64');
    const leftover = await readdir(archDir).catch(() => [] as string[]);
    expect(leftover).not.toContain('no-sha.iso');
    expect(leftover).not.toContain('.cache_metadata.json');
  });

  it('allows a no-sha entry through the local-simulation escape hatch', async () => {
    process.env.LOCAL_SIMULATION_ENABLED = 'true';
    resetSyncConfig();
    try {
      const content = 'sim-bytes';
      const manifest = { files: [{ name: 'sim.iso', size: content.length }] };
      const fetchFn = makeFetch({
        '/amd64/manifest.json': () => new Response(JSON.stringify(manifest), { status: 200 }),
        '/amd64/sim.iso': () => new Response(content, { status: 200 }),
      });

      const service = new BrokkrLiveHTTPSSyncService('job-1', fetchFn);
      await service.syncDiscoveryImages('full');

      const archDir = join(baseDir, 'brokkr-live', 'full', 'amd64');
      expect(await readFile(join(archDir, 'sim.iso'), 'utf-8')).toBe(content);
      const metadata = JSON.parse(await readFile(join(archDir, '.cache_metadata.json'), 'utf-8'));
      expect(metadata['sim.iso'].sha256sum).toBe(sha256Hex(content));
    } finally {
      delete process.env.LOCAL_SIMULATION_ENABLED;
      resetSyncConfig();
    }
  });

  it('rejects a manifest filename containing path traversal and writes nothing outside the cache dir', async () => {
    const traversalName = '../../../../escape.iso';
    const content = 'evil';
    const manifest = {
      files: [{ name: traversalName, size: content.length, sha256sum: sha256Hex(content) }],
    };
    let downloadAttempts = 0;
    const fetchFn = makeFetch({
      '/amd64/manifest.json': () => new Response(JSON.stringify(manifest), { status: 200 }),
      'escape.iso': () => {
        downloadAttempts += 1;
        return new Response(content, { status: 200 });
      },
    });

    const service = new BrokkrLiveHTTPSSyncService('job-1', fetchFn);
    await expect(service.syncDiscoveryImages('full')).rejects.toThrow(HTTPSSyncError);

    expect(downloadAttempts).toBe(0);
    const escaped = await readFile(join(baseDir, 'escape.iso'), 'utf-8').then(
      () => true,
      () => false,
    );
    expect(escaped).toBe(false);
  });

  it('skips an architecture whose manifest is unavailable', async () => {
    const fetchFn = makeFetch({});
    const service = new BrokkrLiveHTTPSSyncService('job-1', fetchFn);
    expect(await service.syncDiscoveryImages('full')).toBe(0);
  });

  it('skips re-downloading files whose cached sha matches the manifest', async () => {
    const isoContent = 'cached-bytes';
    const sha = sha256Hex(isoContent);
    const archDir = join(baseDir, 'brokkr-live', 'full', 'amd64');
    await rm(archDir, { recursive: true, force: true });
    const manifest = { files: [{ name: 'f.iso', size: isoContent.length, sha256sum: sha }] };

    let downloads = 0;
    const fetchFn = makeFetch({
      '/amd64/manifest.json': () => new Response(JSON.stringify(manifest), { status: 200 }),
      '/amd64/f.iso': () => {
        downloads += 1;
        return new Response(isoContent, { status: 200 });
      },
    });

    const first = new BrokkrLiveHTTPSSyncService('job-1', fetchFn);
    await first.syncDiscoveryImages('full');
    expect(downloads).toBe(1);

    const second = new BrokkrLiveHTTPSSyncService('job-1', fetchFn);
    await second.syncDiscoveryImages('full');
    expect(downloads).toBe(1);
  });

  it('cleans up orphaned cache files no longer in the manifest', async () => {
    const isoContent = 'live-bytes';
    const archDir = join(baseDir, 'brokkr-live', 'full', 'amd64');
    await import('node:fs/promises').then((fs) => fs.mkdir(archDir, { recursive: true }));
    await writeFile(join(archDir, 'stale.iso'), 'old');

    const manifest = { files: [{ name: 'f.iso', size: isoContent.length, sha256sum: sha256Hex(isoContent) }] };
    const fetchFn = makeFetch({
      '/amd64/manifest.json': () => new Response(JSON.stringify(manifest), { status: 200 }),
      '/amd64/f.iso': () => new Response(isoContent, { status: 200 }),
    });

    const service = new BrokkrLiveHTTPSSyncService('job-1', fetchFn);
    await service.syncDiscoveryImages('full');

    const files = await readdir(archDir);
    expect(files).toContain('f.iso');
    expect(files).not.toContain('stale.iso');
  });

  function chunkThenError(chunk: string): ReadableStream<Uint8Array> {
    let pulls = 0;
    const enc = new TextEncoder().encode(chunk);
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls === 0) {
          controller.enqueue(enc);
          pulls += 1;
        } else {
          controller.error(new Error('mid-stream stall'));
        }
      },
    });
  }

  it('resumes a partial .tmp via a Range request instead of restarting from zero', async () => {
    const full = 'abcdefghijklmnop';
    const head = full.slice(0, 6);
    const tail = full.slice(6);
    const manifest = { files: [{ name: 'f.iso', size: full.length, sha256sum: sha256Hex(full) }] };

    const ranges: (string | undefined)[] = [];
    let isoCall = 0;
    const fetchFn: FetchLike = (input, init) => {
      const url = String(input);
      if (url.endsWith('/amd64/manifest.json')) {
        return Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 }));
      }
      if (url.endsWith('/amd64/f.iso')) {
        ranges.push((init?.headers as Record<string, string> | undefined)?.Range);
        isoCall += 1;
        if (isoCall === 1) return Promise.resolve(new Response(chunkThenError(head), { status: 200 }));
        return Promise.resolve(new Response(tail, { status: 206 }));
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    };

    const service = new BrokkrLiveHTTPSSyncService('job-1', fetchFn);
    expect(await service.syncDiscoveryImages('full')).toBe(1);

    const archDir = join(baseDir, 'brokkr-live', 'full', 'amd64');
    expect(await readFile(join(archDir, 'f.iso'), 'utf-8')).toBe(full);
    expect(ranges[0]).toBeUndefined();
    expect(ranges[1]).toBe('bytes=6-');
  });

  it('restarts cleanly when the server ignores Range and replies 200 with the full body', async () => {
    const full = 'ABCDEFGHIJ';
    const manifest = { files: [{ name: 'f.iso', size: full.length, sha256sum: sha256Hex(full) }] };
    let isoCall = 0;
    const fetchFn: FetchLike = (input) => {
      const url = String(input);
      if (url.endsWith('/amd64/manifest.json')) {
        return Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 }));
      }
      if (url.endsWith('/amd64/f.iso')) {
        isoCall += 1;
        if (isoCall === 1) return Promise.resolve(new Response(chunkThenError(full.slice(0, 4)), { status: 200 }));
        return Promise.resolve(new Response(full, { status: 200 }));
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    };

    const service = new BrokkrLiveHTTPSSyncService('job-1', fetchFn);
    expect(await service.syncDiscoveryImages('full')).toBe(1);
    const archDir = join(baseDir, 'brokkr-live', 'full', 'amd64');
    expect(await readFile(join(archDir, 'f.iso'), 'utf-8')).toBe(full);
  });

  it('finalizes a complete .tmp on a 416 without re-downloading the body', async () => {
    const full = 'complete-file-bytes';
    const archDir = join(baseDir, 'brokkr-live', 'full', 'amd64');
    await import('node:fs/promises').then((fs) => fs.mkdir(archDir, { recursive: true }));
    await writeFile(join(archDir, 'f.iso.tmp'), full);
    const manifest = { files: [{ name: 'f.iso', size: full.length, sha256sum: sha256Hex(full) }] };

    let bodyDownloads = 0;
    const fetchFn: FetchLike = (input, init) => {
      const url = String(input);
      if (url.endsWith('/amd64/manifest.json')) {
        return Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 }));
      }
      if (url.endsWith('/amd64/f.iso')) {
        if ((init?.headers as Record<string, string> | undefined)?.Range) {
          return Promise.resolve(new Response(null, { status: 416 }));
        }
        bodyDownloads += 1;
        return Promise.resolve(new Response(full, { status: 200 }));
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    };

    const service = new BrokkrLiveHTTPSSyncService('job-1', fetchFn);
    expect(await service.syncDiscoveryImages('full')).toBe(1);
    expect(bodyDownloads).toBe(0);
    expect(await readFile(join(archDir, 'f.iso'), 'utf-8')).toBe(full);
  });

  it('resumes (does not wipe) a partial when the manifest omits size (size 0)', async () => {
    const full = 'abcdefghijklmnop';
    const head = full.slice(0, 6);
    const tail = full.slice(6);
    const archDir = join(baseDir, 'brokkr-live', 'full', 'amd64');
    await import('node:fs/promises').then((fs) => fs.mkdir(archDir, { recursive: true }));
    await writeFile(join(archDir, 'f.iso.tmp'), head);
    const manifest = { files: [{ name: 'f.iso', size: 0, sha256sum: sha256Hex(full) }] };

    const ranges: (string | undefined)[] = [];
    const fetchFn: FetchLike = (input, init) => {
      const url = String(input);
      if (url.endsWith('/amd64/manifest.json')) {
        return Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 }));
      }
      if (url.endsWith('/amd64/f.iso')) {
        ranges.push((init?.headers as Record<string, string> | undefined)?.Range);
        return Promise.resolve(new Response(tail, { status: 206 }));
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    };

    const service = new BrokkrLiveHTTPSSyncService('job-1', fetchFn);
    expect(await service.syncDiscoveryImages('full')).toBe(1);
    expect(ranges[0]).toBe('bytes=6-');
    expect(await readFile(join(archDir, 'f.iso'), 'utf-8')).toBe(full);
  });

  it('discards a leftover partial whose marker sha does not match the manifest entry', async () => {
    const full = 'the-new-artifact-bytes';
    const staleSha = sha256Hex('previous-artifact-bytes');
    const archDir = join(baseDir, 'brokkr-live', 'full', 'amd64');
    await import('node:fs/promises').then((fs) => fs.mkdir(archDir, { recursive: true }));
    await writeFile(join(archDir, 'f.iso.tmp'), 'previous-artifact-partial');
    await writeFile(join(archDir, 'f.iso.tmp.sha256'), staleSha);
    const manifest = { files: [{ name: 'f.iso', size: full.length, sha256sum: sha256Hex(full) }] };

    const ranges: (string | undefined)[] = [];
    const fetchFn: FetchLike = (input, init) => {
      const url = String(input);
      if (url.endsWith('/amd64/manifest.json')) {
        return Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 }));
      }
      if (url.endsWith('/amd64/f.iso')) {
        ranges.push((init?.headers as Record<string, string> | undefined)?.Range);
        return Promise.resolve(new Response(full, { status: 200 }));
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    };

    const service = new BrokkrLiveHTTPSSyncService('job-1', fetchFn);
    expect(await service.syncDiscoveryImages('full')).toBe(1);
    expect(ranges[0]).toBeUndefined();
    expect(await readFile(join(archDir, 'f.iso'), 'utf-8')).toBe(full);
    expect(await readdir(archDir)).not.toContain('f.iso.tmp.sha256');
  });
  it('moves a legacy arch tree under the full flavor once and reuses its cache', async () => {
    const content = 'legacy-image';
    const legacyDir = join(baseDir, 'brokkr-live', 'amd64');
    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, 'vmlinuz'), content);
    await writeFile(
      join(legacyDir, '.cache_metadata.json'),
      JSON.stringify({ vmlinuz: { sha256sum: sha256Hex(content), filename: 'vmlinuz', size: content.length } }),
    );
    process.env.DISCOVERY_ARCHITECTURES = 'amd64';
    resetDiscoveryFileConfig();
    const manifest = { files: [{ name: 'vmlinuz', size: content.length, sha256sum: sha256Hex(content) }] };
    const requested: string[] = [];
    const fetchFn: FetchLike = (input) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith('/manifest.json')) {
        return Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 }));
      }
      return Promise.resolve(new Response('unexpected', { status: 500 }));
    };

    const synced = await new BrokkrLiveHTTPSSyncService('job-1', fetchFn).syncDiscoveryImages('full');

    expect(synced).toBe(1);
    expect(requested.filter((u) => !u.endsWith('/manifest.json'))).toEqual([]);
    expect(await readFile(join(baseDir, 'brokkr-live', 'full', 'amd64', 'vmlinuz'), 'utf-8')).toBe(content);
    await expect(stat(legacyDir)).rejects.toThrow();
  });

  it('leaves a legacy arch tree alone when the full tree already exists', async () => {
    const legacyDir = join(baseDir, 'brokkr-live', 'amd64');
    const fullDir = join(baseDir, 'brokkr-live', 'full', 'amd64');
    await mkdir(legacyDir, { recursive: true });
    await mkdir(fullDir, { recursive: true });
    await writeFile(join(legacyDir, 'stale'), 'x');
    process.env.DISCOVERY_ARCHITECTURES = 'amd64';
    resetDiscoveryFileConfig();
    const fetchFn = makeFetch({});

    await new BrokkrLiveHTTPSSyncService('job-1', fetchFn).syncDiscoveryImages('full');

    expect(await readFile(join(legacyDir, 'stale'), 'utf-8')).toBe('x');
  });
});

describe('syncDiscoveryImages orchestration', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'brokkr-discovery-sync-'));
    process.env.PERSISTENT_STORAGE_PATH = baseDir;
    process.env.BROKKR_LIVE_VERSION = '9.9.9';
    process.env.BRIDGE_HOSTNAME = 'bridge-test';
    process.env.DISCOVERY_BASE_URL = ROOT_URL;
    resetPersistentStorageConfig();
    resetStorageConfig();
    resetSyncConfig();
    resetLeaderConfigForTests();
    resetDiscoveryFileConfig();
  });

  afterEach(async () => {
    delete process.env.PERSISTENT_STORAGE_PATH;
    delete process.env.BROKKR_LIVE_VERSION;
    delete process.env.BRIDGE_HOSTNAME;
    delete process.env.DISCOVERY_BASE_URL;
    delete process.env.DISCOVERY_FLAVORS;
    delete process.env.DISCOVERY_ARCHITECTURES;
    resetPersistentStorageConfig();
    resetStorageConfig();
    resetSyncConfig();
    resetLeaderConfigForTests();
    resetDiscoveryFileConfig();
    resetDiscoverySyncRecordForTests();
    await rm(baseDir, { recursive: true, force: true });
  });

  const VERSION_REDIS_KEY = versionKeyFor('full', ROOT_URL);

  it('syncs one tree per flavor and arch', async () => {
    process.env.DISCOVERY_FLAVORS = 'full,light';
    process.env.DISCOVERY_ARCHITECTURES = 'amd64,arm64';
    resetSyncConfig();
    resetDiscoveryFileConfig();
    const content = 'image';
    const manifest = {
      version: '9.9.9',
      files: [{ name: 'vmlinuz', size: content.length, sha256sum: sha256Hex(content) }],
    };
    const requested: string[] = [];
    const fetchFn: FetchLike = (input) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith('/manifest.json')) {
        return Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 }));
      }
      return Promise.resolve(new Response(content, { status: 200 }));
    };
    const cache = new FakeVersionCache();

    await syncDiscoveryImages(cache, 'job-1', { syncService: new BrokkrLiveHTTPSSyncService('job-1', fetchFn) });

    expect(requested.filter((u) => u.endsWith('/manifest.json')).map((u) => new URL(u).pathname)).toEqual([
      '/brokkr-live-light/9.9.9/amd64/manifest.json',
      '/brokkr-live-light/9.9.9/arm64/manifest.json',
      '/brokkr-live/9.9.9/amd64/manifest.json',
      '/brokkr-live/9.9.9/arm64/manifest.json',
    ]);
    for (const flavor of ['light', 'full']) {
      for (const arch of ['amd64', 'arm64']) {
        expect(await readFile(join(baseDir, 'brokkr-live', flavor, arch, 'vmlinuz'), 'utf-8')).toBe(content);
      }
    }
    expect(cache.store.get(versionKeyFor('light', ROOT_URL))).toBe('9.9.9');
    expect(cache.store.get(versionKeyFor('full', ROOT_URL))).toBe('9.9.9');
  });

  it('re-syncs when the base url changes at the same version', async () => {
    const cache = new FakeVersionCache();
    cache.store.set(versionKeyFor('full', 'https://old.test/brokkr-live'), '9.9.9');
    const fs = await import('node:fs/promises');
    await fs.mkdir(join(baseDir, 'brokkr-live', 'full', 'amd64'), { recursive: true });
    await writeFile(join(baseDir, 'brokkr-live', 'full', 'amd64', 'f.iso'), 'data');

    const syncService = { syncDiscoveryImages: vi.fn(async () => 1) };
    await syncDiscoveryImages(cache, 'job-1', { syncService });

    expect(syncService.syncDiscoveryImages).toHaveBeenCalledWith('full');
    expect(cache.store.get(VERSION_REDIS_KEY)).toBe('9.9.9');
  });

  it('skips a flavor whose version is cached and syncs the one that is not', async () => {
    process.env.DISCOVERY_FLAVORS = 'light,full';
    resetSyncConfig();
    const cache = new FakeVersionCache();
    cache.store.set(versionKeyFor('light', ROOT_URL), '9.9.9');
    const fs = await import('node:fs/promises');
    await fs.mkdir(join(baseDir, 'brokkr-live', 'light', 'amd64'), { recursive: true });
    await writeFile(join(baseDir, 'brokkr-live', 'light', 'amd64', 'f.iso'), 'data');

    const syncService = { syncDiscoveryImages: vi.fn(async () => 1) };
    await syncDiscoveryImages(cache, 'job-1', { syncService });

    expect(syncService.syncDiscoveryImages.mock.calls).toEqual([['full']]);
    expect(cache.store.get(versionKeyFor('full', ROOT_URL))).toBe('9.9.9');
  });

  it('skips the sync when the cached version matches and files exist on disk', async () => {
    const cache = new FakeVersionCache();
    cache.store.set(VERSION_REDIS_KEY, '9.9.9');
    const fs = await import('node:fs/promises');
    await fs.mkdir(join(baseDir, 'brokkr-live', 'full', 'amd64'), { recursive: true });
    await writeFile(join(baseDir, 'brokkr-live', 'full', 'amd64', 'f.iso'), 'data');

    const syncService = { syncDiscoveryImages: vi.fn(async () => 1) };
    await syncDiscoveryImages(cache, 'job-1', { syncService });
    expect(syncService.syncDiscoveryImages).not.toHaveBeenCalled();
  });

  it('re-syncs when the cached version matches but the directory is empty', async () => {
    const cache = new FakeVersionCache();
    cache.store.set(VERSION_REDIS_KEY, '9.9.9');
    const fs = await import('node:fs/promises');
    await fs.mkdir(join(baseDir, 'brokkr-live'), { recursive: true });

    const syncService = { syncDiscoveryImages: vi.fn(async () => 1) };
    await syncDiscoveryImages(cache, 'job-1', { syncService });
    expect(syncService.syncDiscoveryImages).toHaveBeenCalledTimes(1);
    expect(syncService.syncDiscoveryImages).toHaveBeenCalledWith('full');
    expect(cache.deletes).toContain(VERSION_REDIS_KEY);
  });

  it('runs the sync and stores the version when files were synced', async () => {
    const cache = new FakeVersionCache();
    const syncService = { syncDiscoveryImages: vi.fn(async () => 2) };
    await syncDiscoveryImages(cache, 'job-1', { syncService });
    expect(syncService.syncDiscoveryImages).toHaveBeenCalledTimes(1);
    expect(cache.store.get(VERSION_REDIS_KEY)).toBe('9.9.9');
  });

  it('does not cache the version when the sync produced no files', async () => {
    const cache = new FakeVersionCache();
    const syncService = { syncDiscoveryImages: vi.fn(async () => 0) };
    await syncDiscoveryImages(cache, 'job-1', { syncService });
    expect(cache.store.has(VERSION_REDIS_KEY)).toBe(false);
  });

  it('force clears the version cache before checking', async () => {
    const cache = new FakeVersionCache();
    cache.store.set(VERSION_REDIS_KEY, '9.9.9');
    const fs = await import('node:fs/promises');
    await fs.mkdir(join(baseDir, 'brokkr-live', 'full', 'amd64'), { recursive: true });
    await writeFile(join(baseDir, 'brokkr-live', 'full', 'amd64', 'f.iso'), 'data');

    const syncService = { syncDiscoveryImages: vi.fn(async () => 1) };
    await syncDiscoveryImages(cache, 'job-1', { force: true, syncService });
    expect(cache.deletes[0]).toBe(VERSION_REDIS_KEY);
    expect(syncService.syncDiscoveryImages).toHaveBeenCalledTimes(1);
  });

  it('propagates sync service failures and records a failed outcome with the error', async () => {
    const cache = new FakeVersionCache();
    const syncService = {
      syncDiscoveryImages: vi.fn(async () => {
        throw new HTTPSSyncError('boom');
      }),
    };
    await expect(syncDiscoveryImages(cache, 'job-1', { syncService })).rejects.toThrow('boom');

    expect(getDiscoverySyncRecord()).toMatchObject({
      outcome: 'failed',
      error: 'boom',
      baseUrl: ROOT_URL,
      version: '9.9.9',
      flavors: ['full'],
    });
  });

  it('records an ok outcome after a pass that synced files', async () => {
    const before = Date.now();
    const syncService = { syncDiscoveryImages: vi.fn(async () => 2) };

    await syncDiscoveryImages(new FakeVersionCache(), 'job-1', { syncService });

    const record = getDiscoverySyncRecord();
    expect(record).toMatchObject({
      outcome: 'ok',
      error: null,
      baseUrl: ROOT_URL,
      version: '9.9.9',
      flavors: ['full'],
    });
    expect(record?.at).toBeGreaterThanOrEqual(before);
  });

  it('records a skipped outcome when every flavor was already synced', async () => {
    const cache = new FakeVersionCache();
    cache.store.set(VERSION_REDIS_KEY, '9.9.9');
    const fs = await import('node:fs/promises');
    await fs.mkdir(join(baseDir, 'brokkr-live', 'full', 'amd64'), { recursive: true });
    await writeFile(join(baseDir, 'brokkr-live', 'full', 'amd64', 'f.iso'), 'data');

    await syncDiscoveryImages(cache, 'job-1', { syncService: { syncDiscoveryImages: vi.fn(async () => 1) } });

    expect(getDiscoverySyncRecord()).toMatchObject({ outcome: 'skipped', error: null });
  });

  it('records a failed outcome naming the flavor when a pass produced no files', async () => {
    const syncService = { syncDiscoveryImages: vi.fn(async () => 0) };

    await syncDiscoveryImages(new FakeVersionCache(), 'job-1', { syncService });

    expect(getDiscoverySyncRecord()).toMatchObject({
      outcome: 'failed',
      error: 'discovery sync produced no files for full',
    });
  });
});

describe('syncDiscoveryImages serialization', () => {
  afterEach(() => resetDiscoverySyncQueueForTests());

  it('starts the second sync after the first sync completes', async () => {
    let finishFirst = (): void => undefined;
    let markFirstStarted = (): void => undefined;
    const firstPending = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const order: string[] = [];
    const firstService = {
      syncDiscoveryImages: vi.fn(async () => {
        order.push('first');
        markFirstStarted();
        await firstPending;
        return 0;
      }),
    };
    const secondService = {
      syncDiscoveryImages: vi.fn(async () => {
        order.push('second');
        return 0;
      }),
    };

    const first = syncDiscoveryImages(new FakeVersionCache(), 'job-1', { syncService: firstService });
    const second = syncDiscoveryImages(new FakeVersionCache(), 'job-2', { syncService: secondService });
    await firstStarted;
    await new Promise((resolve) => setImmediate(resolve));

    expect(order).toEqual(['first']);
    expect(secondService.syncDiscoveryImages).not.toHaveBeenCalled();

    finishFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(['first', 'second']);
  });
});
