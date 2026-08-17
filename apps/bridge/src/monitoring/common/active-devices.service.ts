import { getErrorMessage } from '../../common/error-utils';
import { deviceDataPattern } from '../../common/redis/redis-keys';
import { logDebug } from '../../logger/logger.service';

export interface ActiveDevicesCache {
  scan(pattern: string, jobId?: string): Promise<string[]>;
  get(key: string, jobId?: string): Promise<string | null>;
}

export type DeviceDataBlob = Record<string, unknown>;

const DATA_KEY_TEMPLATE = (deviceId: string): string => `device:${deviceId}:data`;

export async function* iterActiveDeviceIds(
  cache: ActiveDevicesCache,
  jobId: string = '',
): AsyncGenerator<string, void, void> {
  let keys: string[];
  try {
    keys = await cache.scan(deviceDataPattern(), jobId);
  } catch (error) {
    await logDebug(`active_devices: scan() failed: ${getErrorMessage(error)}`, { jobId });
    return;
  }

  for (const key of keys) {
    const parts = key.split(':');
    if (parts.length >= 3 && parts[0] === 'device' && parts[parts.length - 1] === 'data') {
      const deviceId = parts.slice(1, -1).join(':');
      if (deviceId) {
        yield deviceId;
      }
    }
  }
}

export async function getCachedDeviceData(
  cache: ActiveDevicesCache,
  deviceId: string,
  jobId: string = '',
): Promise<DeviceDataBlob | null> {
  const key = DATA_KEY_TEMPLATE(deviceId);
  let raw: string | null;
  try {
    raw = await cache.get(key, jobId);
  } catch (error) {
    await logDebug(`active_devices: get(${key}) failed: ${getErrorMessage(error)}`, { jobId });
    return null;
  }
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as DeviceDataBlob;
  } catch (error) {
    await logDebug(`active_devices: malformed device data at ${key}: ${getErrorMessage(error)}`, { jobId });
    return null;
  }
}

export function extractBmcIp(deviceData: DeviceDataBlob): string | null {
  const interfaces = deviceData.interfaces;
  const list = Array.isArray(interfaces) ? interfaces : [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const iface = item as Record<string, unknown>;
    if (!iface.mgmt_only) continue;
    const ipAddresses = iface.ip_addresses;
    const ips = Array.isArray(ipAddresses) ? ipAddresses : [];
    for (const entry of ips) {
      if (typeof entry !== 'object' || entry === null) continue;
      const address = (entry as Record<string, unknown>).address;
      if (typeof address !== 'string' || address.length === 0) continue;
      const slash = address.indexOf('/');
      return slash === -1 ? address : address.slice(0, slash);
    }
  }
  return null;
}
