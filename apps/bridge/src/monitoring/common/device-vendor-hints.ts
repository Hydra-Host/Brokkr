import type { BmcCredentials } from '../../common/bmc.types';

export enum GpuLayout {
  NONE = 'none',
  DELL_IDRAC9 = 'dell_idrac9',
  LENOVO_XCC = 'lenovo_xcc',
  CISCO_CBMC = 'cisco_cbmc',
  GRAPHICS_CONTROLLER = 'graphics_controller',
  SUPERMICRO_ASPEED = 'supermicro_aspeed',
  NVIDIA_HGX = 'nvidia_hgx',
}

export interface VendorHints {
  readonly baselineChassisId: string;
  readonly baselineUrlTrailingSlash: boolean;
  readonly gpuLayout: GpuLayout;
  readonly gpuCount: number;
  readonly gpuSlots: readonly number[];
  readonly gpuChassisIds: readonly string[];
}

export function defaultVendorHints(): VendorHints {
  return Object.freeze({
    baselineChassisId: '1',
    baselineUrlTrailingSlash: false,
    gpuLayout: GpuLayout.NONE,
    gpuCount: 0,
    gpuSlots: Object.freeze([]) as readonly number[],
    gpuChassisIds: Object.freeze([]) as readonly string[],
  });
}

export interface DeviceVendorHints {
  get(deviceId: string, creds: BmcCredentials): Promise<VendorHints>;
}

export class EmptyDeviceVendorHints implements DeviceVendorHints {
  async get(_deviceId: string, _creds: BmcCredentials): Promise<VendorHints> {
    return defaultVendorHints();
  }
}

const DEFAULT_TTL_SECONDS = 24 * 3600;

export class CachingDeviceVendorHints implements DeviceVendorHints {
  private readonly inner: DeviceVendorHints;
  private readonly ttlSeconds: number;
  private readonly cache = new Map<string, { ts: number; hints: VendorHints }>();

  constructor(inner: DeviceVendorHints, ttlSeconds: number = DEFAULT_TTL_SECONDS) {
    this.inner = inner;
    this.ttlSeconds = ttlSeconds;
  }

  async get(deviceId: string, creds: BmcCredentials): Promise<VendorHints> {
    const key = cacheKey(deviceId, creds);
    const now = monotonicSeconds();
    const entry = this.cache.get(key);
    if (entry !== undefined && now - entry.ts < this.ttlSeconds) {
      return entry.hints;
    }
    const hints = await this.inner.get(deviceId, creds);
    this.cache.set(key, { ts: now, hints });
    return hints;
  }

  invalidate(deviceId?: string | null): void {
    if (deviceId === undefined || deviceId === null) {
      this.cache.clear();
      return;
    }
    for (const key of [...this.cache.keys()]) {
      if (keyDeviceId(key) === deviceId) {
        this.cache.delete(key);
      }
    }
  }
}

function cacheKey(deviceId: string, creds: BmcCredentials): string {
  return JSON.stringify([deviceId, creds.bmcIp, creds.username, creds.password]);
}

function keyDeviceId(key: string): string {
  return (JSON.parse(key) as [string, string, string, string])[0];
}

function monotonicSeconds(): number {
  return performance.now() / 1000;
}
