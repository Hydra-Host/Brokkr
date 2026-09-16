import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger/sync-log.js', () => ({
  syncLogDebug: vi.fn(),
  syncLogInfo: vi.fn(),
  syncLogWarning: vi.fn(),
  syncLogError: vi.fn(),
}));

import { resetDiscoveryFileConfig } from '../../download/discovery.config.js';
import { syncLogDebug, syncLogError, syncLogInfo, syncLogWarning } from '../../logger/sync-log.js';
import { BrokkrLiveHTTPSSyncService, type FetchLike } from '../brokkr-live-https-sync.service.js';
import { resetPersistentStorageConfig, resetStorageConfig, resetSyncConfig } from '../sync.config.js';
import { logDebug, logError, logInfo, logWarning } from '../sync.logger.js';

describe('sync.logger delegation', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('routes each level to the matching process logger with the job id and app class', () => {
    const context = { jobId: 'job-9', appClassName: 'service-sync' };

    logDebug('d', context);
    logInfo('i', context);
    logWarning('w', context);
    logError('e', context);

    expect(syncLogDebug).toHaveBeenCalledWith('d', 'job-9', 'service-sync');
    expect(syncLogInfo).toHaveBeenCalledWith('i', 'job-9', 'service-sync');
    expect(syncLogWarning).toHaveBeenCalledWith('w', 'job-9', 'service-sync');
    expect(syncLogError).toHaveBeenCalledWith('e', 'job-9', 'service-sync');
  });

  it('falls back to the process logger defaults when no context is given', () => {
    logInfo('bare');

    expect(syncLogInfo).toHaveBeenCalledWith('bare', '', 'main');
  });
});

describe('sync service logging', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'brokkr-sync-logger-'));
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
    resetPersistentStorageConfig();
    resetStorageConfig();
    resetSyncConfig();
    resetDiscoveryFileConfig();
    vi.clearAllMocks();
    await rm(baseDir, { recursive: true, force: true });
  });

  it('logs a failed manifest fetch through the process logger', async () => {
    const fetchFn: FetchLike = () => Promise.resolve(new Response('nope', { status: 503 }));

    const synced = await new BrokkrLiveHTTPSSyncService('job-503', fetchFn).syncDiscoveryImages('full');

    expect(synced).toBe(0);
    expect(syncLogError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to fetch manifest after 1 attempts: HTTP 503'),
      'job-503',
      'service-sync',
    );
  });
});
