import { parseDocument, Scalar, parse as yamlLoad, YAMLParseError } from 'yaml';
import type { ZodType, ZodTypeDef } from 'zod';

import { isRecord } from '@repo/utils';

import { RedisOperationError } from '../common/redis/redis-client';
import { deviceNetplanPhase, deviceRecord, discoveryPending } from '../common/redis/redis-keys';
import { type DeviceRecord, deviceRecordSchema } from '../device-record/device-record.schema';
import { type NetplanAtom, netplanAtomSchema } from '../device-record/netplan/netplan.schema';
import { pythonFalsy } from '../saga-framework/truthiness';

// optional trailing '\n' tolerated; '\r\n' must still reject (corpus vector "trailing_crlf")
const MAC_COLON_RE = /^([0-9A-Fa-f]{2}:){5}([0-9A-Fa-f]{2})\n?$/;
const MAC_DASH_RE = /^([0-9A-Fa-f]{2}-){5}([0-9A-Fa-f]{2})\n?$/;

export function isValidMac(mac: string): boolean {
  return MAC_COLON_RE.test(mac) || MAC_DASH_RE.test(mac);
}

export class DeviceServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceServiceError';
  }
}

export class DeviceServiceTransientError extends DeviceServiceError {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceServiceTransientError';
  }
}

export class DeviceValidationError extends DeviceServiceError {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceValidationError';
  }
}

export type DeviceData = Record<string, unknown>;

export type ValueSchema<T> = ZodType<T, ZodTypeDef, unknown>;

export interface GetAtomParams<T> {
  domain: string;
  entityId: string;
  atomKey: string;
  valueSchema: ValueSchema<T>;
  jobId?: string;
}

export interface AtomFetcherLike {
  getAtom<T>(params: GetAtomParams<T>): Promise<T | null>;
  readAtom<T>(key: string, valueSchema: ValueSchema<T>, jobId?: string): Promise<T | null>;
}

export type GetLiveNetplanFn = (deviceId: string, jobId?: string) => Promise<string | null>;

export interface DeviceServiceCache {
  hset(key: string, mapping: Record<string, string>, ttl?: number, jobId?: string): Promise<number>;
}

export interface DeviceServiceDeps {
  cache: DeviceServiceCache;
  atomFetcher: AtomFetcherLike;
  getLiveNetplan: GetLiveNetplanFn;
}

const VALID_NETPLAN_PHASES = new Set<string>(['live', 'deploy']);
const PENDING_DEVICE_TTL_S = 2592000;

export function generateDhcpFallbackNetplan(deviceData: DeviceData): string {
  const rawInterfaces = deviceData['interfaces'];
  if (rawInterfaces === null) {
    throw new TypeError('interfaces is null and cannot be iterated');
  }
  const interfaces: unknown[] =
    rawInterfaces === undefined
      ? []
      : Array.isArray(rawInterfaces)
        ? rawInterfaces
        : typeof rawInterfaces === 'string'
          ? Array.from(rawInterfaces)
          : [];

  let ethernets: Record<string, { dhcp4: true; dhcp6: true }> = {};
  for (const iface of interfaces) {
    if (iface === null || iface === undefined) {
      throw new TypeError('interface entry is null or undefined');
    }
    if (typeof iface === 'string') {
      throw new TypeError('interface entry is a string, expected an object');
    }
    if (!isRecord(iface)) continue;
    const name = iface['name'];
    const mgmtOnly = iface['mgmt_only'];
    if (typeof name === 'string' && name !== '' && pythonFalsy(mgmtOnly)) {
      ethernets[name] = { dhcp4: true, dhcp6: true };
    }
  }

  if (Object.keys(ethernets).length === 0) {
    ethernets = {
      eth0: { dhcp4: true, dhcp6: true },
      ens2: { dhcp4: true, dhcp6: true },
    };
  }

  const sortedIfaceNames = Object.keys(ethernets).sort();
  const lines: string[] = ['network:', '  ethernets:'];
  for (const name of sortedIfaceNames) {
    lines.push(`    ${name}:`);
    lines.push('      dhcp4: true');
    lines.push('      dhcp6: true');
  }
  lines.push('  renderer: networkd');
  lines.push('  version: 2');
  return lines.join('\n') + '\n';
}

function containsRejectableTab(input: string): boolean {
  return input.includes('\t');
}

function safeLoadStrict(content: string): unknown {
  if (containsRejectableTab(content)) {
    throw new YAMLParseError([0, 0], 'TAB_AS_INDENT', 'tab character used in indentation or as token separator');
  }
  return yamlLoad(content);
}

export class DeviceService {
  static readonly VALID_NETPLAN_PHASES = VALID_NETPLAN_PHASES;

  readonly jobId: string;
  private readonly cache: DeviceServiceCache;
  private readonly atomFetcher: AtomFetcherLike;
  private readonly getLiveNetplan: GetLiveNetplanFn;

  constructor(jobId: string, deps: DeviceServiceDeps) {
    this.jobId = jobId;
    this.cache = deps.cache;
    this.atomFetcher = deps.atomFetcher;
    this.getLiveNetplan = deps.getLiveNetplan;
  }

  validateNetplanYaml(netplanContent: string): boolean {
    try {
      safeLoadStrict(netplanContent);
      return true;
    } catch {
      return false;
    }
  }

  generateDhcpFallbackNetplan(deviceData: DeviceData): string {
    return generateDhcpFallbackNetplan(deviceData);
  }

  normalizeNetplanYaml(netplanContent: string): string | null {
    if (!netplanContent || netplanContent.trim() === '') return null;
    if (containsRejectableTab(netplanContent)) return null;

    const doc = parseDocument(netplanContent);
    if (doc.errors.length > 0) return null;
    if (doc.contents === null) return null;
    if (doc.toJS() === null) return null;

    for (const tag of doc.schema.tags) {
      if (!tag.stringify) continue;
      if (tag.tag === 'tag:yaml.org,2002:int') {
        tag.stringify = (item) => {
          const s = item.source ?? String(item.value);
          if (s.startsWith('+')) return s.slice(1);
          if (s.startsWith('-') && item.value === 0) return s.slice(1);
          return s;
        };
      } else if (tag.tag === 'tag:yaml.org,2002:bool') {
        tag.stringify = (item) => String(item.value);
      } else if (tag.tag === 'tag:yaml.org,2002:float') {
        tag.stringify = (item) => {
          const s = item.source ?? String(item.value);
          return /^\+\.(?:inf|Inf|INF)$/.test(s) ? '.inf' : s;
        };
      } else if (tag.tag === 'tag:yaml.org,2002:str') {
        const stringify = tag.stringify;
        tag.stringify = (item, ctx, onComment, onChompKeep) => {
          if (item.tag === 'tag:yaml.org,2002:str' && item.type === Scalar.PLAIN && typeof item.value === 'string') {
            return item.value;
          }
          return stringify(item, ctx, onComment, onChompKeep);
        };
      } else if (tag.tag === 'tag:yaml.org,2002:null') {
        tag.stringify = (_item, ctx) => (ctx.inFlow ? 'null' : '');
      }
    }

    const out = doc.toString({
      flowCollectionPadding: false,
      indentSeq: false,
      lineWidth: 0,
    });
    return doc.contents instanceof Scalar ? `${out}...\n` : out;
  }

  validateNetplanPhase(phase: string): void {
    if (!VALID_NETPLAN_PHASES.has(phase)) {
      throw new RangeError(
        `netplan_phase must be one of {${[...VALID_NETPLAN_PHASES].map((p) => `'${p}'`).join(', ')}}, got '${phase}'`,
      );
    }
  }

  isValidMac(mac: string): boolean {
    return isValidMac(mac);
  }

  async getDeviceById(deviceId: string, skipNetplan = false, netplanPhase = 'live'): Promise<DeviceData> {
    this.validateNetplanPhase(netplanPhase);

    if (!deviceId) {
      throw new DeviceValidationError('Device ID cannot be empty');
    }

    const record: DeviceRecord | null = await this.atomFetcher.getAtom({
      domain: 'device_record',
      entityId: deviceId,
      atomKey: deviceRecord(deviceId),
      valueSchema: deviceRecordSchema,
      jobId: this.jobId,
    });
    if (record === null) return {};

    const deviceData: DeviceData = { ...record };
    if (skipNetplan) return deviceData;
    return this.applyNetplanResolution(deviceData, netplanPhase);
  }

  async registerPendingDevice(facts: DeviceData): Promise<boolean> {
    try {
      const rawMac = facts['mac'];
      const hasMac = typeof rawMac === 'string' && rawMac !== '';

      let key: string;
      let normalized: DeviceData;
      if (hasMac) {
        const mac = rawMac.replace(/-/g, ':').toLowerCase();
        key = discoveryPending(mac);
        normalized = { ...facts, mac };
      } else {
        const fallback = pendingFallbackIdentifier(facts);
        if (fallback === null) return false;
        key = discoveryPending(fallback);
        normalized = { ...facts };
      }

      const mapping: Record<string, string> = {};
      for (const [k, v] of Object.entries(normalized)) {
        if (pythonFalsy(v)) continue;
        mapping[k] = typeof v === 'string' ? v : stringify(v);
      }
      await this.cache.hset(key, mapping, PENDING_DEVICE_TTL_S, this.jobId);
      return true;
    } catch {
      return false;
    }
  }

  async applyNetplanResolution(device: DeviceData, netplanPhase: string): Promise<DeviceData> {
    const deviceId = readId(device);
    const isVpc = Boolean(device['is_vpc']);
    const roleSlug = typeof device['role'] === 'string' ? device['role'] : '';
    const isDiscovered = roleSlug === 'discovered-hosts';
    const effectivePhase = isVpc ? netplanPhase : 'live';

    if (deviceId !== '') {
      let redisRaw: string | null = null;
      try {
        if (!isDiscovered) {
          redisRaw = await this.fetchNetplanFromRedis(deviceId, effectivePhase);
        }
      } catch (error) {
        if (error instanceof RedisOperationError) {
          if (isVpc && netplanPhase === 'deploy') {
            throw new DeviceServiceTransientError(
              `VPC device ${deviceId}: Redis unavailable while reading :deploy netplan (${error.message}) — retryable`,
            );
          }
          redisRaw = null;
        } else {
          throw error;
        }
      }

      if (redisRaw) {
        const normalized = this.normalizeNetplanYaml(redisRaw);
        if (normalized) {
          device['netplan'] = normalized;
          return device;
        }
        if (isVpc && netplanPhase === 'deploy') {
          throw new DeviceServiceError(
            `VPC device ${deviceId} has invalid :deploy netplan in Redis — content failed YAML validation`,
          );
        }
      } else if (isVpc && netplanPhase === 'deploy') {
        throw new DeviceServiceError(
          `VPC device ${deviceId} missing :deploy netplan in Redis — hub has not staged provisioning config`,
        );
      }
    }

    if (deviceId !== '') {
      const rendered = (await this.getLiveNetplan(deviceId, this.jobId)) ?? '';
      if (rendered && this.validateNetplanYaml(rendered)) {
        device['netplan'] = rendered;
        return device;
      }
    }

    const existing = device['netplan'];
    const existingYaml = typeof existing === 'string' ? existing : '';
    if (!existingYaml || !this.validateNetplanYaml(existingYaml)) {
      device['netplan'] = generateDhcpFallbackNetplan(device);
    }
    return device;
  }

  async fetchNetplanFromRedis(deviceId: string, phase: string): Promise<string | null> {
    this.validateNetplanPhase(phase);

    const cacheKey = deviceNetplanPhase(deviceId, phase);
    let atom: NetplanAtom | null;
    try {
      atom = await this.atomFetcher.readAtom(cacheKey, netplanAtomSchema, this.jobId);
    } catch (error) {
      if (error instanceof RedisOperationError) throw error;
      return null;
    }
    if (atom === null) return null;
    return atom.yaml;
  }
}

function pendingFallbackIdentifier(facts: DeviceData): string | null {
  for (const kind of ['system_uuid', 'serial'] as const) {
    const value = facts[kind];
    if (typeof value === 'string' && value !== '') {
      const sanitized = value
        .toLowerCase()
        .replace(/[^0-9a-z-]+/g, '-')
        .replace(/^-+|-+$/g, '');
      if (sanitized !== '') return sanitized;
    }
  }
  return null;
}

function readId(device: DeviceData): string {
  const raw = device['id'];
  if (!raw) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'bigint') return String(raw);
  return '';
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

export async function createDeviceService(jobId: string, deps: DeviceServiceDeps): Promise<DeviceService> {
  return new DeviceService(jobId, deps);
}
