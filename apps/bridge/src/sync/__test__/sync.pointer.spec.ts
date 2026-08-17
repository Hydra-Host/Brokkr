import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetDiscoveryFileConfig } from '../../download/discovery.config.js';
import { BrokkrLiveHTTPSSyncService, type FetchLike } from '../brokkr-live-https-sync.service.js';
import { resetPersistentStorageConfig, resetStorageConfig, resetSyncConfig } from '../sync.config.js';

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

describe('discovery manifest version pointers', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'brokkr-sync-pointer-'));
    process.env.PERSISTENT_STORAGE_PATH = baseDir;
    process.env.DISCOVERY_ARCHITECTURES = 'amd64';
    process.env.HTTPS_RETRY_ATTEMPTS = '1';
    resetPersistentStorageConfig();
    resetStorageConfig();
    resetSyncConfig();
    resetDiscoveryFileConfig();
  });

  afterEach(async () => {
    delete process.env.PERSISTENT_STORAGE_PATH;
    delete process.env.DISCOVERY_ARCHITECTURES;
    delete process.env.HTTPS_RETRY_ATTEMPTS;
    delete process.env.BROKKR_LIVE_VERSION;
    resetPersistentStorageConfig();
    resetStorageConfig();
    resetSyncConfig();
    resetDiscoveryFileConfig();
    await rm(baseDir, { recursive: true, force: true });
  });

  it('uses the pointer target for files and the configured alias for the manifest', async () => {
    process.env.BROKKR_LIVE_VERSION = 'latest-stable';
    resetSyncConfig();
    const content = 'image';
    const manifest = {
      version: '1.2.3',
      files: [{ name: 'image.iso', size: content.length, sha256sum: sha256Hex(content) }],
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

    await new BrokkrLiveHTTPSSyncService('job-1', fetchFn).syncDiscoveryImages();

    expect(requested.map((url) => new URL(url).pathname)).toEqual([
      '/brokkr-live/latest-stable/amd64/manifest.json',
      '/brokkr-live/1.2.3/amd64/image.iso',
    ]);
  });

  it('uses the configured version for files when the version is explicit', async () => {
    process.env.BROKKR_LIVE_VERSION = '2.0.0';
    resetSyncConfig();
    const content = 'image';
    const manifest = {
      version: '9.9.9',
      files: [{ name: 'image.iso', size: content.length, sha256sum: sha256Hex(content) }],
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

    await new BrokkrLiveHTTPSSyncService('job-1', fetchFn).syncDiscoveryImages();

    expect(requested.map((url) => new URL(url).pathname)).toEqual([
      '/brokkr-live/2.0.0/amd64/manifest.json',
      '/brokkr-live/2.0.0/amd64/image.iso',
    ]);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['non-string', 123],
  ])('rejects a %s pointer before the file download', async (_kind, version) => {
    process.env.BROKKR_LIVE_VERSION = 'latest-stable';
    resetSyncConfig();
    const content = 'image';
    const manifest = {
      version,
      files: [{ name: 'image.iso', size: content.length, sha256sum: sha256Hex(content) }],
    };
    const requested: string[] = [];
    const fetchFn: FetchLike = (input) => {
      const url = String(input);
      requested.push(url);
      return Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 }));
    };

    await expect(new BrokkrLiveHTTPSSyncService('job-1', fetchFn).syncDiscoveryImages()).rejects.toThrow(
      "invalid 'version' pointer",
    );
    expect(requested.map((url) => new URL(url).pathname)).toEqual([
      '/brokkr-live/latest-stable/amd64/manifest.json',
    ]);
  });

  it('discards a partial file when its marker does not match the resolved artifact', async () => {
    process.env.BROKKR_LIVE_VERSION = 'latest-stable';
    resetSyncConfig();
    const content = 'new-image';
    const archDir = join(baseDir, 'brokkr-live', 'amd64');
    await mkdir(archDir, { recursive: true });
    await writeFile(join(archDir, 'image.iso.tmp'), 'old-partial');
    await writeFile(join(archDir, 'image.iso.tmp.sha256'), sha256Hex('old-image'));
    const manifest = {
      version: '1.2.3',
      files: [{ name: 'image.iso', size: content.length, sha256sum: sha256Hex(content) }],
    };
    const ranges: (string | null)[] = [];
    const fetchFn: FetchLike = (input, init) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) {
        return Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 }));
      }
      ranges.push(new Headers(init?.headers).get('Range'));
      return Promise.resolve(new Response(content, { status: 200 }));
    };

    await new BrokkrLiveHTTPSSyncService('job-1', fetchFn).syncDiscoveryImages();

    expect(ranges).toEqual([null]);
    expect(await readFile(join(archDir, 'image.iso'), 'utf-8')).toBe(content);
  });
});
