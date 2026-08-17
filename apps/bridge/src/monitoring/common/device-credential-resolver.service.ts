import type { BmcCredentials } from '../../common/bmc.types';

export interface BmcCredentialsLookup {
  get(deviceId: string): Promise<BmcCredentials | null>;
  /** IP-only resolution for credential-less paths (ICMP ping) — must succeed for devices with no sealed secret. */
  getIp?(deviceId: string): Promise<string | null>;
}

export class DeviceCredentialResolver {
  private readonly cache = new Map<string, BmcCredentials>();
  private lock: Promise<void> = Promise.resolve();

  constructor(private readonly lookup: BmcCredentialsLookup) {}

  async resolve(deviceId: string): Promise<BmcCredentials | null> {
    const cached = this.cache.get(deviceId);
    if (cached !== undefined) {
      return cached;
    }
    return this.withLock(async () => {
      const reCached = this.cache.get(deviceId);
      if (reCached !== undefined) {
        return reCached;
      }
      const creds = await this.lookup.get(deviceId);
      if (creds !== null) {
        this.cache.set(deviceId, creds);
      }
      return creds;
    });
  }

  async resolveIp(deviceId: string): Promise<string | null> {
    if (this.lookup.getIp) {
      const ip = await this.lookup.getIp(deviceId);
      if (ip !== null) {
        return ip;
      }
    }
    const cached = this.cache.get(deviceId);
    if (cached !== undefined) {
      return cached.bmcIp;
    }
    const creds = await this.resolve(deviceId);
    return creds === null ? null : creds.bmcIp;
  }

  /** Call only when the BMC was reachable and rejected auth, never on network failures. */
  invalidate(deviceId: string): void {
    this.cache.delete(deviceId);
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await prev;
      return await fn();
    } finally {
      release();
    }
  }
}

let _resolver: DeviceCredentialResolver | null = null;
let _builder: (() => DeviceCredentialResolver) | null = null;

export function configureDeviceCredentialResolver(builder: () => DeviceCredentialResolver): void {
  _builder = builder;
  _resolver = null;
}

export function getDeviceCredentialResolver(): DeviceCredentialResolver {
  if (_resolver === null) {
    if (_builder === null) {
      throw new Error('DeviceCredentialResolver not configured; call configureDeviceCredentialResolver before use');
    }
    _resolver = _builder();
  }
  return _resolver;
}

export function resetDeviceCredentialResolverForTests(): void {
  _resolver = null;
  _builder = null;
}

export interface ResolvedMetricsTarget {
  ip: string | null;
  username: string | null;
  password: string | null;
  usedResolver: boolean;
}

export interface ResolveMetricsTargetArgs {
  deviceId: string | null;
  ip?: string | null;
  username?: string | null;
  password?: string | null;
}

export async function resolveMetricsTarget(args: ResolveMetricsTargetArgs): Promise<ResolvedMetricsTarget> {
  const ip = args.ip ?? null;
  const username = args.username ?? null;
  const password = args.password ?? null;
  const deviceId = args.deviceId;

  if (ip && username && password) {
    return { ip, username, password, usedResolver: false };
  }
  if (!deviceId) {
    return { ip, username, password, usedResolver: false };
  }

  const creds = await getDeviceCredentialResolver().resolve(deviceId);
  if (creds === null) {
    return { ip, username, password, usedResolver: false };
  }

  return {
    ip: ip || creds.bmcIp,
    username: username || creds.username,
    password: password || creds.password,
    usedResolver: true,
  };
}
