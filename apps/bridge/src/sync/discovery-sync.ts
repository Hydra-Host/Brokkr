import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { createRunExclusive } from '../common/async/run-exclusive.js';
import { loadRedisConfig, ttlOrNone } from '../common/redis/redis-client/redis.config.js';
import { bridgeInstanceVersion } from '../common/redis/redis-keys.js';
import { getLeaderConfig } from '../leader-election/leader-election.config.js';
import { createBrokkrLiveHttpsSyncService } from './brokkr-live-https-sync.service.js';
import { getStorageConfig, getSyncConfig } from './sync.config.js';
import { logInfo, logWarning } from './sync.logger.js';

const APP_CLASS_NAME = 'service-sync';

const VERSION_KEY = 'brokkr-live-https';
const VERSION_ALIAS_PREFIX = 'latest-';

let runSyncExclusive = createRunExclusive();

export function resetDiscoverySyncQueueForTests(): void {
  runSyncExclusive = createRunExclusive();
}

export interface SyncVersionCache {
  get(key: string, jobId?: string): Promise<string | null>;
  set(key: string, value: string, ttl?: number | null, jobId?: string): Promise<boolean>;
  delete(key: string, jobId?: string): Promise<number>;
}

export interface DiscoveryImageSyncer {
  syncDiscoveryImages(): Promise<number>;
}

export interface SyncDiscoveryImagesOptions {
  force?: boolean;
  syncService?: DiscoveryImageSyncer;
}

function getBridgeVersionKey(suffix: string): string {
  return bridgeInstanceVersion(getLeaderConfig().instanceId, suffix);
}

export function getSyncValidationPath(versionKey: string, brokkrLiveHttpsDir: string): string | null {
  if (versionKey === VERSION_KEY) return brokkrLiveHttpsDir;
  return null;
}

async function hasFilesRecursive(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path, { withFileTypes: true, recursive: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) continue;
      if (entry.isFile()) return true;
      if (entry.isSymbolicLink()) {
        const parent =
          (entry as { parentPath?: string; path?: string }).parentPath ?? (entry as { path?: string }).path ?? path;
        const fullPath = join(parent, entry.name);
        try {
          const st = await stat(fullPath);
          if (!st.isDirectory()) return true;
        } catch {
          return true;
        }
        continue;
      }
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    await readdir(path);
    return true;
  } catch {
    return false;
  }
}

async function checkSyncedVersion(
  cache: SyncVersionCache,
  versionKey: string,
  currentVersion: string,
  jobId: string,
): Promise<boolean> {
  try {
    const key = getBridgeVersionKey(versionKey);
    const cachedVersion = await cache.get(key, jobId);
    if (cachedVersion !== currentVersion) return false;

    const storage = getStorageConfig();
    const validationPath = getSyncValidationPath(versionKey, storage.brokkrLiveHttpsDir);
    if (validationPath) {
      if (!(await isDirectory(validationPath)) || !(await hasFilesRecursive(validationPath))) {
        logWarning(`Sync version ${currentVersion} cached but ${validationPath} has no files, re-syncing`, {
          appClassName: APP_CLASS_NAME,
          jobId,
        });
        await cache.delete(key, jobId);
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

async function storeSyncedVersion(
  cache: SyncVersionCache,
  versionKey: string,
  version: string,
  jobId: string,
): Promise<void> {
  try {
    const cfg = loadRedisConfig();
    const key = getBridgeVersionKey(versionKey);
    await cache.set(key, version, ttlOrNone(cfg.ttls.syncVersion) ?? null, jobId);
  } catch {
    return;
  }
}

async function clearSyncVersionCache(cache: SyncVersionCache, versionKey: string, jobId: string): Promise<void> {
  try {
    const key = getBridgeVersionKey(versionKey);
    await cache.delete(key, jobId);
    logInfo(`Cleared sync version cache for ${versionKey}`, { appClassName: APP_CLASS_NAME, jobId });
  } catch (exc) {
    logWarning(
      `Failed to clear sync version cache for ${versionKey}: ${exc instanceof Error ? exc.message : String(exc)}`,
      {
        appClassName: APP_CLASS_NAME,
        jobId,
      },
    );
  }
}

async function runDiscoveryImageSync(
  cache: SyncVersionCache,
  jobId: string,
  options: SyncDiscoveryImagesOptions = {},
): Promise<void> {
  const { force = false } = options;

  if (force) {
    await clearSyncVersionCache(cache, VERSION_KEY, jobId);
  }

  const syncConfig = getSyncConfig();
  const currentVersion = syncConfig.brokkrLiveVersion;
  const isAlias = currentVersion.startsWith(VERSION_ALIAS_PREFIX);

  if (!isAlias && (await checkSyncedVersion(cache, VERSION_KEY, currentVersion, jobId))) {
    logInfo(`Discovery images sync skipped - version ${currentVersion} already synced on this bridge`, {
      appClassName: APP_CLASS_NAME,
      jobId,
    });
    return;
  }

  logInfo('Starting discovery images sync via HTTPS (sha256sum-based)', { appClassName: APP_CLASS_NAME, jobId });

  const syncService = options.syncService ?? createBrokkrLiveHttpsSyncService(jobId);
  const syncedCount = await syncService.syncDiscoveryImages();

  if (syncedCount > 0) {
    if (isAlias) {
      await clearSyncVersionCache(cache, VERSION_KEY, jobId);
    } else {
      await storeSyncedVersion(cache, VERSION_KEY, currentVersion, jobId);
    }
    logInfo('Discovery images sync via HTTPS completed successfully', { appClassName: APP_CLASS_NAME, jobId });
  } else {
    logWarning('Discovery images sync via HTTPS produced no files, version not cached', {
      appClassName: APP_CLASS_NAME,
      jobId,
    });
  }
}

export function syncDiscoveryImages(
  cache: SyncVersionCache,
  jobId: string,
  options: SyncDiscoveryImagesOptions = {},
): Promise<void> {
  return runSyncExclusive(() => runDiscoveryImageSync(cache, jobId, options));
}
