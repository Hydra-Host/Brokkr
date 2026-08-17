import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getErrorMessage } from '../../common/error-utils';

import { Logger } from '@nestjs/common';

import type { RedisClient } from '../../common/redis/redis-client/index.js';
import { deviceBmcCipher, deviceBmcCipherByIp } from '../../common/redis/redis-keys.js';
import { buildBaseCommand } from './command.js';
import type { IPMIDevice } from './device.js';
import { withCipher } from './device.js';
import { getIpmiConfig, ttlOrNone } from './ipmi.config.js';
import { run as transportRun } from './transport.js';

const logger = new Logger('adapter-ipmi-cipher');
const CIPHER_NONE = '__none__';
const PROBE_TIMEOUT = 15;

export interface CipherResolution {
  found: boolean;
  cipher: string | null;
}

interface CacheRead {
  hit: boolean;
  cipher: string | null;
}

function cacheValueToCipher(value: string | null): string | null {
  if (value === null || value === CIPHER_NONE) return null;
  return value || null;
}

async function readRedisCache(
  redis: RedisClient,
  ip: string,
  deviceId: string | null,
  jobId: string,
): Promise<CacheRead> {
  try {
    if (deviceId) {
      const value = await redis.get(deviceBmcCipher(deviceId), jobId);
      if (value !== null) {
        return { hit: true, cipher: cacheValueToCipher(value) };
      }
    }
    const value = await redis.get(deviceBmcCipherByIp(ip), jobId);
    if (value !== null) {
      return { hit: true, cipher: cacheValueToCipher(value) };
    }
  } catch (e) {
    logger.debug(`cipher cache read failed for ${ip}: ${getErrorMessage(e)}`, jobId);
  }
  return { hit: false, cipher: null };
}

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

async function readFileCache(ip: string, cacheDir: string, jobId: string): Promise<CacheRead> {
  const safeIp = ip.replace(/[^0-9a-zA-Z]/g, '_');
  const path = join(cacheDir, `${safeIp}.cipher`);
  try {
    const buf = await readFile(path);
    const content = STRICT_UTF8.decode(buf).trim();
    const cipher = content === '' ? null : content;
    logger.debug(`file-cached cipher for ${ip}: ${cipher}`, jobId);
    return { hit: true, cipher };
  } catch (e) {
    const code: unknown = e !== null && typeof e === 'object' ? Reflect.get(e, 'code') : undefined;
    if (code !== 'ENOENT') {
      logger.debug(`file cache read failed for ${ip}: ${getErrorMessage(e)}`, jobId);
    }
  }
  return { hit: false, cipher: null };
}

async function writeCache(
  redis: RedisClient,
  ip: string,
  cipher: string | null,
  deviceId: string | null,
  jobId: string,
): Promise<void> {
  const storeValue = cipher === null ? CIPHER_NONE : cipher;
  try {
    const cfg = getIpmiConfig();
    const ttl = ttlOrNone(cfg.ttlBmcCipher);
    if (deviceId) {
      await redis.set(deviceBmcCipher(deviceId), storeValue, ttl, jobId);
    } else {
      await redis.set(deviceBmcCipherByIp(ip), storeValue, ttl, jobId);
    }
    logger.log(`cached cipher for ${ip}: ${cipher}`, jobId);
  } catch (e) {
    logger.debug(`failed to cache cipher for ${ip}: ${getErrorMessage(e)}`, jobId);
  }
}

async function probeCipher(device: IPMIDevice, cipher: string | null): Promise<boolean> {
  const probeDevice = withCipher(device, cipher);
  const command = [...buildBaseCommand(probeDevice), 'power', 'status'];
  const result = await transportRun(command, probeDevice.password, PROBE_TIMEOUT, {
    cipherUsed: cipher,
    jobId: device.jobId,
  });
  if (result.ok) {
    logger.debug(`cipher ${cipher} ok for ${device.ip}`, device.jobId);
    return true;
  }
  logger.debug(`cipher ${cipher} failed for ${device.ip}: ${result.stderr.slice(0, 100)}`, device.jobId);
  return false;
}

export async function detectCipher(device: IPMIDevice): Promise<CipherResolution> {
  const cfg = getIpmiConfig();
  logger.log(`cipher detection for ${device.ip} (testing ${cfg.cipherDetectionList.length})`, device.jobId);
  for (const cipher of cfg.cipherDetectionList) {
    const cipherStr = cipher !== null ? String(cipher) : null;
    if (await probeCipher(device, cipherStr)) {
      logger.log(`detected working cipher for ${device.ip}: ${cipherStr}`, device.jobId);
      return { found: true, cipher: cipherStr };
    }
  }
  logger.error(`no working cipher for ${device.ip} after ${cfg.cipherDetectionList.length} attempts`, device.jobId);
  return { found: false, cipher: null };
}

export async function resolveCipher(
  redis: RedisClient,
  device: IPMIDevice,
  deviceId: string | null = null,
): Promise<CipherResolution> {
  const cached = await readRedisCache(redis, device.ip, deviceId, device.jobId);
  if (cached.hit) {
    logger.debug(`redis cipher cache hit for ${device.ip}: ${cached.cipher}`, device.jobId);
    return { found: true, cipher: cached.cipher };
  }

  const cfg = getIpmiConfig();
  const fileCached = await readFileCache(device.ip, cfg.cipherCacheDir, device.jobId);
  if (fileCached.hit) {
    return { found: true, cipher: fileCached.cipher };
  }

  logger.log(`cipher cache miss for ${device.ip}, detecting`, device.jobId);
  const detected = await detectCipher(device);
  if (detected.found) {
    await writeCache(redis, device.ip, detected.cipher, deviceId, device.jobId);
  } else {
    logger.log(`all cipher probes failed for ${device.ip}; NOT caching (will retry on next call)`, device.jobId);
  }
  return detected;
}

export async function getCipherForDevice(
  redis: RedisClient,
  device: IPMIDevice,
  deviceId: string | null = null,
): Promise<string | null> {
  const { cipher } = await resolveCipher(redis, device, deviceId);
  return cipher;
}
