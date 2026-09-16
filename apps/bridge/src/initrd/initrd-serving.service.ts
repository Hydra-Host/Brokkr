import { access, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { getErrorMessage } from '../common/error-utils';

import { loadRedisConfig, ttlOrNone } from '../common/redis/redis-client/index.js';
import { discoveryPending, NIL_DEVICE_ID, rescueSshPubKeys } from '../common/redis/redis-keys.js';
import type { DeviceRecord } from '../device-record/device-record.schema.js';
import { isPlaceholder } from '../device-record/device-record.schema.js';
import { getSyncConfig } from '../sync/sync.config.js';
import { getInitrdConfig } from './initrd.config.js';

import { getLogger } from '../logger/logger.service';

const logDebug = (msg: string, ctx?: unknown): void => void getLogger().debug(msg, ctx);
const logInfo = (msg: string, ctx?: unknown): void => void getLogger().info(msg, ctx);
const logWarning = (msg: string, ctx?: unknown): void => void getLogger().warning(msg, ctx);
const logError = (msg: string, ctx?: unknown): void => void getLogger().error(msg, ctx);

const cleanupTimers = new Set<NodeJS.Timeout>();

// critical section can run ~600s (atom fetch + cpio build); TTL must exceed that or the lock expires mid-build and admits a duplicate builder. Waiters share the budget.
const BUILD_LOCK_TTL_S = 660;
const BUILD_LOCK_WAIT_POLL_S = 3;

function initrdTtl(): number | undefined {
  const cfg = loadRedisConfig();
  return ttlOrNone(cfg.ttls.deviceInitrd);
}

export interface ParsedBuildName {
  initrdType: string;
  deviceId: string | null;
  discoveryMac: string | null;
}

export function isUuid(value: string): boolean {
  let hex = value.replace(/urn:/g, '').replace(/uuid:/g, '');
  hex = hex.replace(/^[{}]+|[{}]+$/g, '').replace(/-/g, '');
  if (hex.length !== 32) return false;
  return /^[\da-fA-F]{32}$/.test(hex);
}

export function parseBuildName(buildName: string): ParsedBuildName | null {
  if (buildName.startsWith('brokkr-discovery-') && buildName.endsWith('.img')) {
    const rest = buildName.slice('brokkr-discovery-'.length, -'.img'.length);
    if (rest.startsWith('mac-')) {
      const macCompact = rest.slice('mac-'.length).toLowerCase();
      if (macCompact.length !== 12 || ![...macCompact].every((c) => '0123456789abcdef'.includes(c))) {
        return null;
      }
      const pairs: string[] = [];
      for (let i = 0; i < 12; i += 2) {
        pairs.push(macCompact.slice(i, i + 2));
      }
      return { initrdType: 'brokkr-discovery', deviceId: null, discoveryMac: pairs.join(':') };
    }
    if (isUuid(rest)) {
      return { initrdType: 'brokkr-discovery', deviceId: rest, discoveryMac: null };
    }
    return null;
  }
  if (buildName.startsWith('ubuntu-rescue-os-') && buildName.endsWith('.img')) {
    const rest = buildName.slice('ubuntu-rescue-os-'.length, -'.img'.length);
    if (isUuid(rest)) {
      return { initrdType: 'ubuntu-rescue-os', deviceId: rest, discoveryMac: null };
    }
    return null;
  }
  return null;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveWithinBuildsDir(buildsDir: string, fileName: string): Promise<string | null> {
  if (basename(fileName) !== fileName) {
    return null;
  }
  const lexicalCandidate = join(buildsDir, fileName);
  const jailDir = await realpath(resolve(buildsDir)).catch(() => resolve(buildsDir));
  let realCandidate: string;
  try {
    realCandidate = await realpath(lexicalCandidate);
  } catch {
    return null;
  }
  if (realCandidate !== jailDir && !realCandidate.startsWith(`${jailDir}${sep}`)) {
    return null;
  }
  return lexicalCandidate;
}

export interface InitrdServingCache {
  get(key: string, jobId?: string): Promise<string | null>;
  set(key: string, value: string, ttl?: number, jobId?: string): Promise<unknown>;
  hgetall(key: string, jobId?: string): Promise<Record<string, string>>;
  acquireLock(lockKey: string, timeout?: number, jobId?: string): Promise<string | null>;
  releaseLock(lockKey: string, token: string, jobId?: string): Promise<boolean>;
  waitForLockRelease(lockKey: string, timeout?: number, pollIntervalS?: number, jobId?: string): Promise<boolean>;
}

export interface InitrdServingDeps {
  cache: InitrdServingCache;
  resolveDeviceRecordByMac(mac: string, jobId: string): Promise<DeviceRecord | null>;
  getDeviceById(deviceId: string, jobId: string): Promise<Record<string, unknown> | null>;
  buildBrokkrDiscoveryInitrd(
    jobId: string,
    deviceId: string,
    deviceData: Record<string, unknown>,
    outputName: string,
    clientIp: string,
  ): Promise<void>;
  buildUbuntuRescueOsInitrd(jobId: string, deviceId: string): Promise<void>;
}

export class InitrdServingService {
  private readonly jobId: string;
  private readonly deps: InitrdServingDeps;

  constructor(jobId: string, deps: InitrdServingDeps) {
    this.jobId = jobId;
    this.deps = deps;
  }

  async getBuildsDir(): Promise<string> {
    return getInitrdConfig().initrdBuildsDir;
  }

  async findInitrdFile(buildName: string | null = null): Promise<string | null> {
    const buildsDir = await this.getBuildsDir();

    if (buildName) {
      if (buildName.endsWith('.img')) {
        if (
          buildName.startsWith('brokkr-discovery-') ||
          buildName.startsWith('ubuntu-rescue-os-') ||
          ['brokkr-live.img', 'bridge-agent.img'].includes(buildName)
        ) {
          return resolveWithinBuildsDir(buildsDir, buildName);
        }
      } else if (['brokkr-live', 'bridge-agent'].includes(buildName)) {
        return resolveWithinBuildsDir(buildsDir, `${buildName}.img`);
      }
    } else {
      return resolveWithinBuildsDir(buildsDir, 'brokkr-live.img');
    }

    return null;
  }

  private async resolvePlaceholderFacts(discoveryMac: string): Promise<Record<string, unknown> | null> {
    const record = await this.deps.resolveDeviceRecordByMac(discoveryMac, this.jobId);
    if (record !== null && isPlaceholder(record)) {
      logInfo(`Sourcing discovery facts from placeholder device_record atom for mac=${discoveryMac}`, {
        jobId: this.jobId,
      });
      return { ...record };
    }
    return null;
  }

  private async resolvePendingFacts(
    discoveryMac: string,
    identityLog: string,
  ): Promise<Record<string, unknown> | null> {
    const pendingKey = discoveryPending(discoveryMac);
    const pending = await this.deps.cache.hgetall(pendingKey, this.jobId);
    if (Object.keys(pending).length === 0) {
      logWarning(`No placeholder record or discovery facts for ${pendingKey}; cannot build initrd for ${identityLog}`, {
        jobId: this.jobId,
      });
      return null;
    }
    return { ...pending };
  }

  async buildDeviceInitrdOnDemand(buildName: string, clientIp = ''): Promise<void> {
    const cache = this.deps.cache;

    const parsed = parseBuildName(buildName);
    if (parsed === null) {
      logWarning(`Cannot parse build name: ${buildName}`, { jobId: this.jobId });
      return;
    }

    if (parsed.discoveryMac === null && parsed.deviceId === NIL_DEVICE_ID) {
      logWarning(
        `Discovery build requested for the NIL device id (${NIL_DEVICE_ID}); no record and no MAC to ` +
          'mint against — bounded give-up, no initrd built',
        { jobId: this.jobId },
      );
      return;
    }

    const initrdType = parsed.initrdType;

    const skipCache = initrdType === 'brokkr-discovery';

    // a cached layer built against one brokkr-live version must not be served after the version moves
    const discoveryVersion = getSyncConfig().brokkrLiveVersion;
    let cacheKey: string;
    let lockKey: string;
    let identityLog: string;
    if (parsed.discoveryMac !== null) {
      cacheKey = `discovery:${parsed.discoveryMac}:initrd:${initrdType}:${discoveryVersion}`;
      lockKey = `discovery:${parsed.discoveryMac}:initrd:${initrdType}:build`;
      identityLog = `mac=${parsed.discoveryMac}`;
    } else {
      cacheKey = `device:${parsed.deviceId}:initrd:${initrdType}:${discoveryVersion}`;
      lockKey = `device:${parsed.deviceId}:initrd:${initrdType}:build`;
      identityLog = `device_id=${parsed.deviceId}`;
    }

    const buildsDir = await this.getBuildsDir();
    const outputFile = join(buildsDir, buildName);

    if (!skipCache) {
      try {
        const cachedB64 = await cache.get(cacheKey, this.jobId);
        if (cachedB64) {
          logInfo(`Serving cached ${initrdType} initrd for ${identityLog}`, { jobId: this.jobId });
          await mkdir(dirname(outputFile), { recursive: true });
          await writeFile(outputFile, Buffer.from(cachedB64, 'base64'));
          return;
        }
      } catch (e) {
        logDebug(`Cache read failed for initrd: ${getErrorMessage(e)}`, { jobId: this.jobId });
      }
    }

    let token = await cache.acquireLock(lockKey, BUILD_LOCK_TTL_S, this.jobId);

    if (!token) {
      logInfo(`Initrd build lock held for ${buildName} - waiting`, { jobId: this.jobId });
      await cache.waitForLockRelease(lockKey, BUILD_LOCK_TTL_S, BUILD_LOCK_WAIT_POLL_S, this.jobId);

      if (!skipCache) {
        try {
          const cachedB64 = await cache.get(cacheKey, this.jobId);
          if (cachedB64) {
            logInfo(`Serving cached ${initrdType} initrd for ${identityLog} (built by other instance)`, {
              jobId: this.jobId,
            });
            await mkdir(dirname(outputFile), { recursive: true });
            await writeFile(outputFile, Buffer.from(cachedB64, 'base64'));
            return;
          }
        } catch (e) {
          logDebug(`Cache read after lock release failed: ${getErrorMessage(e)}`, { jobId: this.jobId });
        }
      }

      logInfo(`No cached initrd after lock release for ${buildName}, attempting own build`, { jobId: this.jobId });
      token = await cache.acquireLock(lockKey, BUILD_LOCK_TTL_S, this.jobId);
      if (!token) {
        logWarning(`Could not acquire initrd build lock for ${buildName} after wait`, { jobId: this.jobId });
        return;
      }
    }

    let cacheBuiltImage = !skipCache;
    try {
      logInfo(`Building ${initrdType} initrd on-demand for ${identityLog}`, { jobId: this.jobId });

      let deviceId: string;

      if (initrdType === 'ubuntu-rescue-os') {
        if (parsed.deviceId === null) {
          throw new Error('ubuntu-rescue-os build requires a device_id');
        }
        deviceId = parsed.deviceId;

        const customerKeys = await cache.get(rescueSshPubKeys(deviceId), this.jobId);
        if (!customerKeys) {
          cacheBuiltImage = false;
          logWarning(
            `No customer rescue SSH keys in Redis for ${identityLog}; building admin-keys-only ` +
              'rescue image but NOT caching it (a later build will pick up the keys)',
            { jobId: this.jobId },
          );
        }

        await this.deps.buildUbuntuRescueOsInitrd(this.jobId, deviceId);
      } else {
        let deviceData: Record<string, unknown>;

        if (parsed.discoveryMac !== null) {
          let facts = await this.resolvePlaceholderFacts(parsed.discoveryMac);
          if (facts === null) {
            facts = await this.resolvePendingFacts(parsed.discoveryMac, identityLog);
          }
          if (facts === null) {
            return;
          }
          deviceData = facts;
          deviceData['id'] = NIL_DEVICE_ID;
          deviceData['mac'] = parsed.discoveryMac;
          deviceId = NIL_DEVICE_ID;
        } else {
          if (parsed.deviceId === null) {
            throw new Error('brokkr-discovery build requires a device_id or discovery mac');
          }
          deviceId = parsed.deviceId;

          const fetched = await this.deps.getDeviceById(deviceId, this.jobId);
          if (!fetched) {
            logWarning(`No device data found for device ${deviceId}`, { jobId: this.jobId });
            return;
          }
          deviceData = fetched;
        }

        await this.deps.buildBrokkrDiscoveryInitrd(this.jobId, deviceId, deviceData, buildName, clientIp);
      }

      if ((await pathExists(outputFile)) && cacheBuiltImage) {
        try {
          const imageBytes = await readFile(outputFile);
          const imageB64 = imageBytes.toString('base64');
          await cache.set(cacheKey, imageB64, initrdTtl(), this.jobId);
          const sizeKb = imageBytes.length / 1024;
          logInfo(`Cached ${initrdType} initrd for device ${deviceId} (${sizeKb.toFixed(1)}KB)`, { jobId: this.jobId });
        } catch (e) {
          logWarning(`Failed to cache initrd image: ${getErrorMessage(e)}`, { jobId: this.jobId });
        }
      }

      logInfo(`Successfully built ${initrdType} initrd for device ${deviceId}`, { jobId: this.jobId });
    } catch (e) {
      logError(`Failed to build device initrd on-demand: ${getErrorMessage(e)}`, { jobId: this.jobId });
    } finally {
      if (token) {
        await cache.releaseLock(lockKey, token, this.jobId);
      }
    }
  }

  scheduleDelayedCleanup(path: string, delay = 60): NodeJS.Timeout {
    const timer = setTimeout(() => {
      cleanupTimers.delete(timer);
      void unlink(path).catch(() => undefined);
    }, delay * 1000);
    timer.unref();
    cleanupTimers.add(timer);
    return timer;
  }
}

export async function createInitrdServingService(
  jobId: string,
  deps: InitrdServingDeps,
): Promise<InitrdServingService> {
  return new InitrdServingService(jobId, deps);
}
