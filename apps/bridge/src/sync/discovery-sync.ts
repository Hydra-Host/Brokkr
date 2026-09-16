import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { createRunExclusive } from '../common/async/run-exclusive.js';
import { getErrorMessage } from '../common/error-utils';
import { loadRedisConfig, ttlOrNone } from '../common/redis/redis-client/redis.config.js';
import { bridgeInstanceVersion } from '../common/redis/redis-keys.js';
import { setDiscoverySyncRecord, type DiscoverySyncOutcome } from '../composition/discovery-sync-holder.js';
import type { DiscoveryFlavor } from '../download/discovery.config.js';
import { getLeaderConfig } from '../leader-election/leader-election.config.js';
import { createBrokkrLiveHttpsSyncService } from './brokkr-live-https-sync.service.js';
import { getStorageConfig, getSyncConfig } from './sync.config.js';
import { logInfo, logWarning } from './sync.logger.js';

const APP_CLASS_NAME = 'service-sync';

const VERSION_KEY_PREFIX = 'brokkr-live-https';
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
  syncDiscoveryImages(flavor: DiscoveryFlavor): Promise<number>;
}

export interface SyncDiscoveryImagesOptions {
  force?: boolean;
  syncService?: DiscoveryImageSyncer;
}

function getBridgeVersionKey(suffix: string): string {
  return bridgeInstanceVersion(getLeaderConfig().instanceId, suffix);
}

// the url hash makes a DISCOVERY_BASE_URL change re-sync even when BROKKR_LIVE_VERSION did not move
export function discoverySyncVersionKey(flavor: DiscoveryFlavor, baseUrl: string): string {
  const urlHash = createHash('sha1').update(baseUrl, 'utf8').digest('hex').slice(0, 8);
  return `${VERSION_KEY_PREFIX}:${flavor}:${urlHash}`;
}

function getSyncValidationPath(flavor: DiscoveryFlavor, brokkrLiveHttpsDir: string): string {
  return join(brokkrLiveHttpsDir, flavor);
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
  flavor: DiscoveryFlavor,
  currentVersion: string,
  jobId: string,
): Promise<boolean> {
  try {
    const key = getBridgeVersionKey(versionKey);
    const cachedVersion = await cache.get(key, jobId);
    if (cachedVersion !== currentVersion) return false;

    const validationPath = getSyncValidationPath(flavor, getStorageConfig().brokkrLiveHttpsDir);
    if (!(await isDirectory(validationPath)) || !(await hasFilesRecursive(validationPath))) {
      logWarning(`Sync version ${currentVersion} cached for ${flavor} but ${validationPath} has no files, re-syncing`, {
        appClassName: APP_CLASS_NAME,
        jobId,
      });
      await cache.delete(key, jobId);
      return false;
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

interface FlavorSyncResult {
  ran: DiscoveryFlavor[];
  empty: DiscoveryFlavor[];
}

// an empty flavor is a failure to sync, not a quiet pass: the manifests were unreachable or listed nothing
function passOutcome({ ran, empty }: FlavorSyncResult): DiscoverySyncOutcome {
  if (ran.length === 0) return 'skipped';
  return empty.length === 0 ? 'ok' : 'failed';
}

async function runDiscoveryImageSync(
  cache: SyncVersionCache,
  jobId: string,
  options: SyncDiscoveryImagesOptions = {},
): Promise<void> {
  const syncConfig = getSyncConfig();
  const record = (outcome: DiscoverySyncOutcome, error: string | null): void =>
    setDiscoverySyncRecord({
      at: Date.now(),
      outcome,
      error,
      baseUrl: syncConfig.discoveryBaseUrl,
      version: syncConfig.brokkrLiveVersion,
      flavors: syncConfig.discoveryFlavors,
    });

  let result: FlavorSyncResult;
  try {
    result = await syncEachFlavor(cache, jobId, options);
  } catch (error) {
    record('failed', getErrorMessage(error));
    throw error;
  }
  const outcome = passOutcome(result);
  record(outcome, outcome === 'failed' ? `discovery sync produced no files for ${result.empty.join(', ')}` : null);
}

async function syncEachFlavor(
  cache: SyncVersionCache,
  jobId: string,
  options: SyncDiscoveryImagesOptions,
): Promise<FlavorSyncResult> {
  const { force = false } = options;
  const ran: DiscoveryFlavor[] = [];
  const empty: DiscoveryFlavor[] = [];

  const syncConfig = getSyncConfig();
  const currentVersion = syncConfig.brokkrLiveVersion;
  const isAlias = currentVersion.startsWith(VERSION_ALIAS_PREFIX);
  let syncService: DiscoveryImageSyncer | null = options.syncService ?? null;

  for (const flavor of syncConfig.discoveryFlavors) {
    const versionKey = discoverySyncVersionKey(flavor, syncConfig.discoveryBaseUrl);

    if (force) {
      await clearSyncVersionCache(cache, versionKey, jobId);
    }

    if (!isAlias && (await checkSyncedVersion(cache, versionKey, flavor, currentVersion, jobId))) {
      logInfo(`Discovery images sync skipped for ${flavor} - version ${currentVersion} already synced on this bridge`, {
        appClassName: APP_CLASS_NAME,
        jobId,
      });
      continue;
    }

    logInfo(`Starting ${flavor} discovery images sync via HTTPS (sha256sum-based)`, {
      appClassName: APP_CLASS_NAME,
      jobId,
    });

    syncService ??= createBrokkrLiveHttpsSyncService(jobId);
    const syncedCount = await syncService.syncDiscoveryImages(flavor);
    ran.push(flavor);

    if (syncedCount > 0) {
      if (isAlias) {
        await clearSyncVersionCache(cache, versionKey, jobId);
      } else {
        await storeSyncedVersion(cache, versionKey, currentVersion, jobId);
      }
      logInfo(`Discovery images sync via HTTPS completed successfully for ${flavor}`, {
        appClassName: APP_CLASS_NAME,
        jobId,
      });
    } else {
      empty.push(flavor);
      logWarning(`Discovery images sync via HTTPS produced no files for ${flavor}, version not cached`, {
        appClassName: APP_CLASS_NAME,
        jobId,
      });
    }
  }
  return { ran, empty };
}

export function syncDiscoveryImages(
  cache: SyncVersionCache,
  jobId: string,
  options: SyncDiscoveryImagesOptions = {},
): Promise<void> {
  return runSyncExclusive(() => runDiscoveryImageSync(cache, jobId, options));
}
