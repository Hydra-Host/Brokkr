import { isIP } from 'node:net';

import { getErrorMessage } from '../common/error-utils';

import { isRecord } from '@repo/utils';

import { getLeaderConfig } from '../leader-election/leader-election.config';
import { getLogger } from '../logger/logger.service';
import { isClientFacingName } from './bridge-ip-resolution.service';
import { isRoutableUnicastIpv4 } from './ip-utils';

const APP_CLASS_NAME = 'bridge-registry-reader';

export interface RegistryRedis {
  scan(pattern: string, jobId?: string): Promise<string[]>;
  hgetall(key: string, jobId?: string): Promise<Record<string, string>>;
}

export type BridgeRegistrySnapshot = [string, unknown][];

export interface BridgeRegistryReaderOptions {
  jobId?: string;
}

export async function getBridgeHostsEntriesForClient(
  redis: RegistryRedis,
  clientIp: string,
  options: BridgeRegistryReaderOptions = {},
): Promise<[string, string][]> {
  const { jobId = '' } = options;
  if (isIP(clientIp) === 0) {
    void getLogger().warning(
      `bridge registry reader: invalid client_ip '${clientIp}' [${APP_CLASS_NAME}] job=${jobId}`,
    );
    return [];
  }

  const snapshot = await getBridgeRegistrySnapshot(redis, { jobId });
  const result = subnetMatchEntries(snapshot, clientIp);
  void getLogger().debug(
    `bridge registry reader: ${result.length} host entries for client_ip=${clientIp} [${APP_CLASS_NAME}] job=${jobId}`,
  );
  return result;
}

export function subnetMatchEntries(snapshot: BridgeRegistrySnapshot, clientAddr: string): [string, string][] {
  const out: [string, string][] = [];
  for (const [hostname, interfaces] of snapshot) {
    const ip = pickInterfaceIpForSubnet(interfaces, clientAddr);
    if (ip !== null) out.push([ip, hostname]);
  }
  return out;
}

function interfaceEntries(interfaces: unknown): Record<string, unknown>[] {
  if (!Array.isArray(interfaces)) return [];
  return interfaces.filter(isRecord).filter((entry) => {
    const iface = entry.iface;
    return typeof iface === 'string' && isClientFacingName(iface);
  });
}

export function pickInterfaceIpForSubnet(interfaces: unknown, clientAddr: string): string | null {
  for (const entry of interfaceEntries(interfaces)) {
    const subnet = entry.subnet;
    const ip = entry.ip;
    if (typeof subnet !== 'string' || !subnet) continue;
    if (typeof ip !== 'string' || !isRoutableUnicastIpv4(ip)) continue;
    if (cidrContains(subnet, clientAddr)) return ip;
  }
  return null;
}

function firstClientFacingIpv4(interfaces: unknown): string | null {
  for (const entry of interfaceEntries(interfaces)) {
    const ip = entry.ip;
    if (typeof ip === 'string' && isRoutableUnicastIpv4(ip)) return ip;
  }
  return null;
}

function clientFacingIpv4s(interfaces: unknown): string[] {
  const out: string[] = [];
  for (const entry of interfaceEntries(interfaces)) {
    const ip = entry.ip;
    if (typeof ip === 'string' && isRoutableUnicastIpv4(ip)) out.push(ip);
  }
  return out;
}

export async function getPeerClientFacingIpv4(
  redis: RegistryRedis,
  selfInstanceId: string,
  preferClientAddr: string | null,
  options: BridgeRegistryReaderOptions = {},
): Promise<string | null> {
  const { jobId = '' } = options;
  const snapshot = await getBridgeRegistrySnapshot(redis, { jobId });
  if (preferClientAddr !== null) {
    for (const [instanceId, interfaces] of snapshot) {
      if (instanceId === selfInstanceId) continue;
      const ip = pickInterfaceIpForSubnet(interfaces, preferClientAddr);
      if (ip !== null && isRoutableUnicastIpv4(ip)) return ip;
    }
  }
  for (const [instanceId, interfaces] of snapshot) {
    if (instanceId === selfInstanceId) continue;
    const ip = firstClientFacingIpv4(interfaces);
    if (ip !== null && isRoutableUnicastIpv4(ip)) return ip;
  }
  return null;
}

export async function getPeerServerIds(
  redis: RegistryRedis,
  selfInstanceId: string,
  options: BridgeRegistryReaderOptions = {},
): Promise<Set<string>> {
  const { jobId = '' } = options;
  const out = new Set<string>();
  for (const [instanceId, interfaces] of await getBridgeRegistrySnapshot(redis, { jobId })) {
    if (instanceId === selfInstanceId) continue;
    for (const ip of clientFacingIpv4s(interfaces)) out.add(ip);
  }
  return out;
}

interface RegistryHash {
  instanceId: string;
  interfaces: unknown;
}

async function* iterateRegistryHashes(redis: RegistryRedis, jobId: string): AsyncGenerator<RegistryHash> {
  const pattern = `${getLeaderConfig().registryKeyPrefix}*`;

  let keys: string[];
  try {
    keys = await redis.scan(pattern, jobId);
  } catch (error) {
    void getLogger().warning(
      `bridge registry reader: scan() failed (${getErrorMessage(error)}) [${APP_CLASS_NAME}] job=${jobId}`,
    );
    return;
  }

  if (keys.length === 0) {
    void getLogger().warning(
      `bridge registry reader: registry is empty (no ${getLeaderConfig().registryKeyPrefix}* keys); device /etc/hosts will have no bridge entries [${APP_CLASS_NAME}] job=${jobId}`,
    );
    return;
  }

  for (const key of [...keys].sort()) {
    let data: Record<string, string>;
    try {
      data = await redis.hgetall(key, jobId);
    } catch (error) {
      void getLogger().warning(
        `bridge registry reader: hgetall(${key}) failed: ${getErrorMessage(error)} [${APP_CLASS_NAME}] job=${jobId}`,
      );
      continue;
    }

    if (!data || Object.keys(data).length === 0) continue;

    const instanceId = data.instance_id || '';
    if (!instanceId) continue;

    let interfaces: unknown[] = [];
    try {
      const parsed: unknown = JSON.parse(data.interfaces_json || '[]');
      if (Array.isArray(parsed)) interfaces = parsed;
    } catch {
      void getLogger().warning(
        `bridge registry reader: malformed interfaces_json for ${instanceId} [${APP_CLASS_NAME}] job=${jobId}`,
      );
    }

    yield { instanceId, interfaces };
  }
}

export async function getBridgeRegistrySnapshot(
  redis: RegistryRedis,
  options: BridgeRegistryReaderOptions = {},
): Promise<BridgeRegistrySnapshot> {
  const { jobId = '' } = options;
  const snapshot: BridgeRegistrySnapshot = [];
  for await (const { instanceId, interfaces } of iterateRegistryHashes(redis, jobId)) {
    snapshot.push([instanceId, interfaces]);
  }
  return snapshot;
}

export async function getAllBridgeHostnames(
  redis: RegistryRedis,
  options: BridgeRegistryReaderOptions = {},
): Promise<string[]> {
  const { jobId = '' } = options;
  const pattern = `${getLeaderConfig().registryKeyPrefix}*`;

  let keys: string[];
  try {
    keys = await redis.scan(pattern, jobId);
  } catch (error) {
    void getLogger().warning(
      `bridge registry reader: scan() failed (${getErrorMessage(error)}) [${APP_CLASS_NAME}] job=${jobId}`,
    );
    return [];
  }

  const hostnames = new Set<string>();
  for (const key of keys) {
    let data: Record<string, string>;
    try {
      data = await redis.hgetall(key, jobId);
    } catch (error) {
      void getLogger().warning(
        `bridge registry reader: hgetall(${key}) failed: ${getErrorMessage(error)} [${APP_CLASS_NAME}] job=${jobId}`,
      );
      continue;
    }
    const instanceId = data?.instance_id;
    if (instanceId) hostnames.add(instanceId);
  }

  const result = [...hostnames].sort();
  void getLogger().debug(`bridge registry reader: ${result.length} bridge hostnames [${APP_CLASS_NAME}] job=${jobId}`);
  return result;
}

function cidrContains(cidr: string, addr: string): boolean {
  const slash = cidr.indexOf('/');
  const network = slash === -1 ? cidr : cidr.slice(0, slash);

  const netFamily = isIP(network);
  const addrFamily = isIP(addr);
  if (netFamily === 0 || addrFamily === 0 || netFamily !== addrFamily) return false;

  let prefix: number;
  if (slash === -1) {
    prefix = netFamily === 4 ? 32 : 128;
  } else {
    const prefixStr = cidr.slice(slash + 1);
    if (!/^[0-9]+$/.test(prefixStr)) return false;
    prefix = Number.parseInt(prefixStr, 10);
  }

  if (netFamily === 4) {
    if (prefix > 32) return false;
    const netInt = ipv4ToInt(network);
    const addrInt = ipv4ToInt(addr);
    if (netInt === null || addrInt === null) return false;
    if (prefix === 0) return netInt === 0;
    const mask = (0xffffffff << (32 - prefix)) >>> 0;
    if ((netInt & ~mask) >>> 0) return false;
    return (netInt & mask) === (addrInt & mask);
  }

  if (prefix > 128) return false;
  const netBits = ipv6ToBits(network);
  const addrBits = ipv6ToBits(addr);
  if (netBits === null || addrBits === null) return false;
  if (prefix < 128 && netBits.slice(prefix).includes('1')) return false;
  return netBits.slice(0, prefix) === addrBits.slice(0, prefix);
}

function ipv4ToInt(addr: string): number | null {
  const parts = addr.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number.parseInt(part, 10);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = (value * 256 + octet) >>> 0;
  }
  return value;
}

function ipv6ToBits(addr: string): string | null {
  const expanded = expandIpv6(addr);
  if (expanded === null) return null;
  let bits = '';
  for (const group of expanded.split(':')) {
    const num = Number.parseInt(group, 16);
    if (!Number.isInteger(num) || num < 0 || num > 0xffff) return null;
    bits += num.toString(2).padStart(16, '0');
  }
  return bits;
}

function ipv4DottedToHexGroups(group: string): string[] | null {
  const value = ipv4ToInt(group);
  if (value === null) return null;
  const high = Math.floor(value / 0x10000);
  const low = value % 0x10000;
  return [high.toString(16), low.toString(16)];
}

function expandIpv6(addr: string): string | null {
  if (!addr.includes(':')) return null;
  const doubleColonIdx = addr.indexOf('::');
  let head: string[];
  let tail: string[];
  if (doubleColonIdx === -1) {
    head = addr.split(':');
    tail = [];
  } else {
    head = addr.slice(0, doubleColonIdx) ? addr.slice(0, doubleColonIdx).split(':') : [];
    tail = addr.slice(doubleColonIdx + 2) ? addr.slice(doubleColonIdx + 2).split(':') : [];
  }

  const groups = tail.length ? tail : head;
  const last = groups[groups.length - 1];
  if (last !== undefined && last.includes('.')) {
    const hexGroups = ipv4DottedToHexGroups(last);
    if (hexGroups === null) return null;
    groups.splice(groups.length - 1, 1, ...hexGroups);
  }

  const total = head.length + tail.length;
  if (total > 8) return null;
  const fill = Array(8 - total).fill('0');
  return [...head, ...fill, ...tail].join(':');
}
