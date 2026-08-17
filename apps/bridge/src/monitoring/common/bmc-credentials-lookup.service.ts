import { bmcCredentials, type BmcCredentials } from '../../common/bmc.types';

import { extractBmcIp, getCachedDeviceData, type ActiveDevicesCache } from './active-devices.service';

export type { BmcCredentials } from '../../common/bmc.types';

export const APP_CLASS_NAME = 'bmc-credentials-lookup';

export interface BmcCredentialsLookup {
  get(deviceId: string): Promise<BmcCredentials | null>;
  /** IP-only resolution for credential-less paths (ICMP ping) — must succeed for devices with no sealed secret. */
  getIp?(deviceId: string): Promise<string | null>;
}

export class StaticBmcCredentialsLookup implements BmcCredentialsLookup {
  private readonly table: Map<string, BmcCredentials>;

  constructor(table: Map<string, BmcCredentials> | Record<string, BmcCredentials>) {
    this.table = table instanceof Map ? new Map(table) : new Map(Object.entries(table));
  }

  async get(deviceId: string): Promise<BmcCredentials | null> {
    return this.table.has(deviceId) ? (this.table.get(deviceId) as BmcCredentials) : null;
  }

  async getIp(deviceId: string): Promise<string | null> {
    return this.table.get(deviceId)?.bmcIp ?? null;
  }
}

// Must byte-match the hub render-request dispatcher's `device_secret` defaults (BMC/USER).
const BMC_SECRET_PURPOSE = 'BMC';
const BMC_SECRET_KIND = 'USER';

export interface OpenedBmcSecret {
  username: string;
  password: string;
}

export interface BmcSecretSource {
  getBmcSecret(
    deviceId: string,
    purpose: string,
    kind: string,
    options?: { jobId?: string },
  ): Promise<OpenedBmcSecret | null>;
}

export class AtomBmcCredentialsLookup implements BmcCredentialsLookup {
  private readonly resolveSecretSource: () => BmcSecretSource;
  private cachedSource: BmcSecretSource | null = null;
  private readonly resolveDataCache: () => ActiveDevicesCache;
  private cachedCache: ActiveDevicesCache | null = null;

  constructor(
    secretSource: BmcSecretSource | (() => BmcSecretSource),
    dataCache: ActiveDevicesCache | (() => ActiveDevicesCache),
    private readonly jobId: string = '',
  ) {
    this.resolveSecretSource = typeof secretSource === 'function' ? secretSource : (): BmcSecretSource => secretSource;
    this.resolveDataCache = typeof dataCache === 'function' ? dataCache : (): ActiveDevicesCache => dataCache;
  }

  private secretSource(): BmcSecretSource {
    if (this.cachedSource === null) {
      this.cachedSource = this.resolveSecretSource();
    }
    return this.cachedSource;
  }

  private dataCache(): ActiveDevicesCache {
    if (this.cachedCache === null) {
      this.cachedCache = this.resolveDataCache();
    }
    return this.cachedCache;
  }

  async get(deviceId: string): Promise<BmcCredentials | null> {
    const secret = await this.secretSource().getBmcSecret(deviceId, BMC_SECRET_PURPOSE, BMC_SECRET_KIND, {
      jobId: this.jobId,
    });
    if (secret === null || !secret.username || !secret.password) {
      return null;
    }

    const deviceData = await getCachedDeviceData(this.dataCache(), deviceId, this.jobId);
    if (deviceData === null) {
      return null;
    }
    const bmcIp = extractBmcIp(deviceData);
    if (!bmcIp) {
      return null;
    }

    return bmcCredentials(bmcIp, secret.username, secret.password);
  }

  async getIp(deviceId: string): Promise<string | null> {
    const deviceData = await getCachedDeviceData(this.dataCache(), deviceId, this.jobId);
    return deviceData === null ? null : extractBmcIp(deviceData);
  }
}
