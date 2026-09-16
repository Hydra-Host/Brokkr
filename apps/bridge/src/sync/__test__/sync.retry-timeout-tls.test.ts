import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { Agent as HttpsAgent, globalAgent as httpsGlobalAgent } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FetchLike } from '../brokkr-live-https-sync.service.js';
import { BrokkrLiveHTTPSSyncService, buildHttpsRequestAgent } from '../brokkr-live-https-sync.service.js';
import { resetPersistentStorageConfig, resetStorageConfig, resetSyncConfig } from '../sync.config.js';

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

function transportError(message: string): TypeError {
  const err = new TypeError(message);
  (err as { cause?: unknown }).cause = new Error('ECONNRESET');
  return err;
}

function makeFetch(routes: Record<string, () => Promise<Response> | Response>): FetchLike {
  return (input) => {
    const url = String(input);
    for (const [suffix, make] of Object.entries(routes)) {
      if (url.endsWith(suffix)) return Promise.resolve(make());
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  };
}

describe('HTTPS sync retry loop', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'brokkr-sync-retry-'));
    process.env.PERSISTENT_STORAGE_PATH = baseDir;
    process.env.HTTPS_RETRY_ATTEMPTS = '3';
    process.env.HTTPS_RETRY_DELAY = '0';
    resetPersistentStorageConfig();
    resetStorageConfig();
    resetSyncConfig();
  });

  afterEach(async () => {
    delete process.env.PERSISTENT_STORAGE_PATH;
    delete process.env.HTTPS_RETRY_ATTEMPTS;
    delete process.env.HTTPS_RETRY_DELAY;
    resetPersistentStorageConfig();
    resetStorageConfig();
    resetSyncConfig();
    await rm(baseDir, { recursive: true, force: true });
  });

  it('fetchManifest retries transport errors and succeeds on a later attempt', async () => {
    const isoContent = 'iso-bytes';
    const manifest = {
      files: [{ name: 'f.iso', size: isoContent.length, sha256sum: sha256Hex(isoContent) }],
    };
    let manifestCalls = 0;
    const fetchFn = makeFetch({
      '/amd64/manifest.json': () => {
        manifestCalls += 1;
        if (manifestCalls < 3) throw transportError('fetch failed');
        return new Response(JSON.stringify(manifest), { status: 200 });
      },
      '/amd64/f.iso': () => new Response(isoContent, { status: 200 }),
    });

    const service = new BrokkrLiveHTTPSSyncService('job-retry', fetchFn);
    const synced = await service.syncDiscoveryImages('full');

    expect(synced).toBe(1);
    expect(manifestCalls).toBe(3);
    const archDir = join(baseDir, 'brokkr-live', 'full', 'amd64');
    expect(await readFile(join(archDir, 'f.iso'), 'utf-8')).toBe(isoContent);
  });

  it('fetchManifest returns null (arch skipped) after exhausting retries on persistent transport errors', async () => {
    let manifestCalls = 0;
    const fetchFn = makeFetch({
      'manifest.json': () => {
        manifestCalls += 1;
        throw transportError('fetch failed');
      },
    });

    const service = new BrokkrLiveHTTPSSyncService('job-retry', fetchFn);
    const synced = await service.syncDiscoveryImages('full');

    expect(synced).toBe(0);
    expect(manifestCalls).toBe(6);
  });

  it('fetchManifest treats a non-OK HTTP status as retryable and skips after exhaustion', async () => {
    let manifestCalls = 0;
    const fetchFn = makeFetch({
      'manifest.json': () => {
        manifestCalls += 1;
        return new Response('upstream down', { status: 503 });
      },
    });

    const service = new BrokkrLiveHTTPSSyncService('job-retry', fetchFn);
    const synced = await service.syncDiscoveryImages('full');

    expect(synced).toBe(0);
    expect(manifestCalls).toBe(6);
  });

  it('fetchManifest does NOT retry a validation TypeError (non-object manifest) — bypasses retry and aborts the sync', async () => {
    let manifestCalls = 0;
    const fetchFn = makeFetch({
      '/amd64/manifest.json': () => {
        manifestCalls += 1;
        return new Response(JSON.stringify(['not', 'an', 'object']), { status: 200 });
      },
    });

    const service = new BrokkrLiveHTTPSSyncService('job-retry', fetchFn);
    await expect(service.syncDiscoveryImages('full')).rejects.toThrow(/not a JSON object/);

    expect(manifestCalls).toBe(1);
  });

  it('downloadFile retries transport errors and succeeds on a later attempt', async () => {
    const isoContent = 'download-bytes';
    const manifest = {
      files: [{ name: 'f.iso', size: isoContent.length, sha256sum: sha256Hex(isoContent) }],
    };
    let downloadCalls = 0;
    const fetchFn = makeFetch({
      '/amd64/manifest.json': () => new Response(JSON.stringify(manifest), { status: 200 }),
      '/amd64/f.iso': () => {
        downloadCalls += 1;
        if (downloadCalls < 2) throw transportError('socket hang up');
        return new Response(isoContent, { status: 200 });
      },
    });

    const service = new BrokkrLiveHTTPSSyncService('job-retry', fetchFn);
    const synced = await service.syncDiscoveryImages('full');

    expect(synced).toBe(1);
    expect(downloadCalls).toBe(2);
    const archDir = join(baseDir, 'brokkr-live', 'full', 'amd64');
    expect(await readFile(join(archDir, 'f.iso'), 'utf-8')).toBe(isoContent);
  });

  it('downloadFile throws after exhausting retries on persistent transport errors', async () => {
    const manifest = {
      files: [{ name: 'f.iso', size: 4, sha256sum: sha256Hex('blob') }],
    };
    let downloadCalls = 0;
    const fetchFn = makeFetch({
      '/amd64/manifest.json': () => new Response(JSON.stringify(manifest), { status: 200 }),
      '/amd64/f.iso': () => {
        downloadCalls += 1;
        throw transportError('socket hang up');
      },
    });

    const service = new BrokkrLiveHTTPSSyncService('job-retry', fetchFn);
    await expect(service.syncDiscoveryImages('full')).rejects.toThrow('socket hang up');

    expect(downloadCalls).toBe(3);
  });

  it('downloadFile does NOT retry a validation TypeError (mistyped manifest size) — bypasses retry', async () => {
    const isoContent = 'bytes';
    const manifest = {
      files: [{ name: 'f.iso', size: 'not-a-number', sha256sum: sha256Hex(isoContent) }],
    };
    let downloadCalls = 0;
    const fetchFn = makeFetch({
      '/amd64/manifest.json': () => new Response(JSON.stringify(manifest), { status: 200 }),
      '/amd64/f.iso': () => {
        downloadCalls += 1;
        return new Response(isoContent, { status: 200 });
      },
    });

    const service = new BrokkrLiveHTTPSSyncService('job-retry', fetchFn);
    await expect(service.syncDiscoveryImages('full')).rejects.toThrow(/expected_size must be a number/);

    expect(downloadCalls).toBe(1);
  });
});

describe('HTTPS sync per-chunk read timeout', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'brokkr-sync-timeout-'));
    process.env.PERSISTENT_STORAGE_PATH = baseDir;
    process.env.HTTPS_RETRY_ATTEMPTS = '1';
    process.env.HTTPS_RETRY_DELAY = '0';
    process.env.HTTPS_STALL_TIMEOUT = '0';
    resetPersistentStorageConfig();
    resetStorageConfig();
    resetSyncConfig();
  });

  afterEach(async () => {
    delete process.env.PERSISTENT_STORAGE_PATH;
    delete process.env.HTTPS_RETRY_ATTEMPTS;
    delete process.env.HTTPS_RETRY_DELAY;
    delete process.env.HTTPS_STALL_TIMEOUT;
    resetPersistentStorageConfig();
    resetStorageConfig();
    resetSyncConfig();
    await rm(baseDir, { recursive: true, force: true });
  });

  it('cancels the reader when a chunk does not arrive within the stall timeout', async () => {
    let cancelled = false;
    let cancelReason: unknown;
    const hangingBody = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => undefined);
      },
      cancel(reason) {
        cancelled = true;
        cancelReason = reason;
      },
    });

    const fetchFn = makeFetch({
      '/amd64/manifest.json': () => new Response(hangingBody, { status: 200 }),
    });

    const service = new BrokkrLiveHTTPSSyncService('job-timeout', fetchFn);
    await expect(service.syncDiscoveryImages('full')).resolves.toBe(0);

    expect(cancelled).toBe(true);
    expect(cancelReason).toBeInstanceOf(Error);
    expect((cancelReason as Error).message).toBe('read timeout');
  });
});

describe('HTTPS sync download stall vs. overall timeout budgets', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'brokkr-sync-budget-'));
    process.env.PERSISTENT_STORAGE_PATH = baseDir;
    process.env.HTTPS_RETRY_ATTEMPTS = '1';
    process.env.HTTPS_RETRY_DELAY = '0';
    resetPersistentStorageConfig();
    resetStorageConfig();
    resetSyncConfig();
  });

  afterEach(async () => {
    delete process.env.PERSISTENT_STORAGE_PATH;
    delete process.env.HTTPS_RETRY_ATTEMPTS;
    delete process.env.HTTPS_RETRY_DELAY;
    delete process.env.HTTPS_STALL_TIMEOUT;
    delete process.env.HTTPS_DOWNLOAD_TIMEOUT;
    resetPersistentStorageConfig();
    resetStorageConfig();
    resetSyncConfig();
    await rm(baseDir, { recursive: true, force: true });
  });

  function steadyBody(chunks: string[], gapMs: number): ReadableStream<Uint8Array> {
    let i = 0;
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            if (i < chunks.length) {
              controller.enqueue(encoder.encode(chunks[i++]));
            } else {
              controller.close();
            }
            resolve();
          }, gapMs);
        });
      },
    });
  }

  it('aborts a stalled download within the stall timeout, not the overall download timeout', async () => {
    process.env.HTTPS_STALL_TIMEOUT = '0';
    process.env.HTTPS_DOWNLOAD_TIMEOUT = '3600';
    resetSyncConfig();

    const isoContent = 'never-arrives';
    const manifest = { files: [{ name: 'f.iso', size: isoContent.length, sha256sum: sha256Hex(isoContent) }] };
    let cancelled = false;
    let cancelReason: unknown;
    const hangingBody = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => undefined);
      },
      cancel(reason) {
        cancelled = true;
        cancelReason = reason;
      },
    });
    const fetchFn = makeFetch({
      '/amd64/manifest.json': () => new Response(JSON.stringify(manifest), { status: 200 }),
      '/amd64/f.iso': () => new Response(hangingBody, { status: 200 }),
    });

    const service = new BrokkrLiveHTTPSSyncService('job-stall', fetchFn);
    await expect(service.syncDiscoveryImages('full')).rejects.toThrow(/Read timeout after 0s/);

    expect(cancelled).toBe(true);
    expect((cancelReason as Error).message).toBe('read timeout');
  });

  it('aborts when the overall download deadline elapses even with a healthy stall budget', async () => {
    process.env.HTTPS_STALL_TIMEOUT = '120';
    process.env.HTTPS_DOWNLOAD_TIMEOUT = '0';
    resetSyncConfig();

    const isoContent = 'some-bytes';
    const manifest = { files: [{ name: 'f.iso', size: isoContent.length, sha256sum: sha256Hex(isoContent) }] };
    const fetchFn = makeFetch({
      '/amd64/manifest.json': () => new Response(JSON.stringify(manifest), { status: 200 }),
      '/amd64/f.iso': () => new Response(isoContent, { status: 200 }),
    });

    const service = new BrokkrLiveHTTPSSyncService('job-deadline', fetchFn);
    await expect(service.syncDiscoveryImages('full')).rejects.toThrow(/Download timeout after 0s/);
  });

  it('completes a slow-but-steady download whose chunks each arrive within the stall budget', async () => {
    process.env.HTTPS_STALL_TIMEOUT = '2';
    process.env.HTTPS_DOWNLOAD_TIMEOUT = '3600';
    resetSyncConfig();

    const chunks = ['alpha-', 'bravo-', 'charlie'];
    const isoContent = chunks.join('');
    const manifest = { files: [{ name: 'f.iso', size: isoContent.length, sha256sum: sha256Hex(isoContent) }] };
    const fetchFn = makeFetch({
      '/amd64/manifest.json': () => new Response(JSON.stringify(manifest), { status: 200 }),
      '/amd64/f.iso': () => new Response(steadyBody(chunks, 20), { status: 200 }),
    });

    const service = new BrokkrLiveHTTPSSyncService('job-steady', fetchFn);
    const synced = await service.syncDiscoveryImages('full');

    expect(synced).toBe(1);
    const archDir = join(baseDir, 'brokkr-live', 'full', 'amd64');
    expect(await readFile(join(archDir, 'f.iso'), 'utf-8')).toBe(isoContent);
  });
});

describe('buildHttpsRequestAgent per-request TLS verification', () => {
  it('sets rejectUnauthorized=false on a fresh per-request agent when verifySsl=false', () => {
    const agent = buildHttpsRequestAgent(false);
    expect(agent).toBeInstanceOf(HttpsAgent);
    expect((agent.options as { rejectUnauthorized?: boolean }).rejectUnauthorized).toBe(false);
  });

  it('sets rejectUnauthorized=true when verifySsl=true', () => {
    const agent = buildHttpsRequestAgent(true);
    expect((agent.options as { rejectUnauthorized?: boolean }).rejectUnauthorized).toBe(true);
  });

  it('returns a fresh agent per call so an insecure toggle is scoped and never shared', () => {
    const insecure1 = buildHttpsRequestAgent(false);
    const insecure2 = buildHttpsRequestAgent(false);
    const secure = buildHttpsRequestAgent(true);

    expect(insecure1).not.toBe(insecure2);
    expect(insecure1).not.toBe(secure);
    const globalAgent = httpsGlobalAgent as HttpsAgent | undefined;
    if (globalAgent) {
      expect(insecure1).not.toBe(globalAgent);
      expect(secure).not.toBe(globalAgent);
      expect((globalAgent.options as { rejectUnauthorized?: boolean }).rejectUnauthorized).not.toBe(false);
    }
  });
});
