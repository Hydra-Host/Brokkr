
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetApplicationConfigForTests } from '../../core/application.config';
import { BridgeIpResolutionService, type NetworkInterface } from '../bridge-ip-resolution.service';
import {
  ACTIVE_BRIDGE_IPS_PROVIDER,
  BridgeNetworkModule,
  DEFAULT_INTERFACE_CACHE_TTL_SECONDS,
  NETPLAN_KERNEL_PARAMS_FACTORY,
  type NetplanKernelParamsFactory,
} from '../bridge-network.module';
import { NetplanToKernelParamsService, type ActiveBridgeIpsProvider } from '../netplan-to-kernel-params.service';

const MULTI_HOMED_NETPLAN = `
network:
  version: 2
  ethernets:
    eno1:
      addresses:
        - 10.20.0.50/24
`;

function multiHomedInterfaces(): NetworkInterface[] {
  return [
    {
      name: 'eth0',
      ip: '10.10.0.1',
      netmask: '255.255.255.0',
      prefix: 24,
      network: '10.10.0.0/24',
      isPrimary: true,
      interfaceType: 'physical',
    },
    {
      name: 'eth1',
      ip: '10.20.0.1',
      netmask: '255.255.255.0',
      prefix: 24,
      network: '10.20.0.0/24',
      isPrimary: false,
      interfaceType: 'physical',
    },
  ];
}

interface FactoryProvider {
  provide: unknown;
  useFactory?: (...args: unknown[]) => unknown;
  useValue?: unknown;
  inject?: unknown[];
}

function isFactoryProvider(value: unknown): value is FactoryProvider {
  return typeof value === 'object' && value !== null && 'provide' in value;
}

function findProvider(providers: ReadonlyArray<unknown>, token: unknown): FactoryProvider {
  for (const provider of providers) {
    if (isFactoryProvider(provider) && provider.provide === token) return provider;
  }
  throw new Error(`Provider not found for ${String(token)}`);
}

interface FakeRedisRecord {
  value: string;
  ttl: number | undefined;
}

class FakeRedis {
  readonly store = new Map<string, FakeRedisRecord>();
  readonly get = vi.fn(async (key: string) => this.store.get(key)?.value ?? null);
  readonly set = vi.fn(async (key: string, value: string, ttl?: number) => {
    this.store.set(key, { value, ttl });
    return 'OK';
  });
}

function resolveServiceFromModule(
  providers: ReadonlyArray<unknown>,
  redisStub: FakeRedis = new FakeRedis(),
): BridgeIpResolutionService {
  const fp = findProvider(providers, BridgeIpResolutionService);
  if (typeof fp.useFactory === 'function') {
    const value = fp.useFactory(redisStub);
    if (value instanceof BridgeIpResolutionService) return value;
  }
  throw new Error('BridgeIpResolutionService factory did not produce an instance');
}

function stubInterfaces(service: BridgeIpResolutionService): void {
  (service as unknown as { getBridgeInterfaces: () => Promise<NetworkInterface[]> }).getBridgeInterfaces = async () =>
    multiHomedInterfaces();
}

describe('BridgeNetworkModule wiring', () => {
  it('forRoot wires the concrete netplanAddressExtractor by default (no silent degradation)', async () => {
    const dynamic = BridgeNetworkModule.forRoot();
    const service = resolveServiceFromModule(dynamic.providers ?? []);
    stubInterfaces(service);
    const fallback = vi.fn(async () => '10.10.0.1');
    service.getBridgeIpForHostsFile = fallback;

    const result = await service.getBridgeIpForDevice(MULTI_HOMED_NETPLAN);

    expect(result).toBe('10.20.0.1');
    expect(fallback).not.toHaveBeenCalled();
  });

  it('forRoot lets the composition root override the extractor for tests', async () => {
    const extract = vi.fn(() => ['10.20.0.99']);
    const dynamic = BridgeNetworkModule.forRoot({
      resolution: { netplanAddressExtractor: { extract } },
    });
    const service = resolveServiceFromModule(dynamic.providers ?? []);
    stubInterfaces(service);
    service.getBridgeIpForHostsFile = vi.fn(async () => '10.10.0.1');

    const result = await service.getBridgeIpForDevice(MULTI_HOMED_NETPLAN);

    expect(extract).toHaveBeenCalledWith(MULTI_HOMED_NETPLAN);
    expect(result).toBe('10.20.0.1');
  });
});

describe('BridgeNetworkModule BRIDGE_URL override', () => {
  const originalBridgeUrl = process.env.BRIDGE_URL;

  beforeEach(() => {
    resetApplicationConfigForTests();
  });

  afterEach(() => {
    if (originalBridgeUrl === undefined) delete process.env.BRIDGE_URL;
    else process.env.BRIDGE_URL = originalBridgeUrl;
    resetApplicationConfigForTests();
  });

  it('threads BRIDGE_URL through forRoot default provider', async () => {
    process.env.BRIDGE_URL = 'https://operator-override.example';
    const dynamic = BridgeNetworkModule.forRoot();
    const service = resolveServiceFromModule(dynamic.providers ?? []);

    const result = await service.getBridgeUrlForRequest();

    expect(result).toBe('https://operator-override.example');
  });

  it('omits the short-circuit when BRIDGE_URL is unset (default)', async () => {
    delete process.env.BRIDGE_URL;
    const dynamic = BridgeNetworkModule.forRoot();
    const service = resolveServiceFromModule(dynamic.providers ?? []);
    stubInterfaces(service);

    const result = await service.getBridgeUrlForRequest();

    expect(result).toBe('https://10.10.0.1');
  });
});

describe('BridgeNetworkModule ResolutionCache wiring', () => {
  it('forRoot wires RedisService as the default ResolutionCache so repeated lookups hit cache', async () => {
    const redis = new FakeRedis();
    const dynamic = BridgeNetworkModule.forRoot();
    const service = resolveServiceFromModule(dynamic.providers ?? [], redis);

    const discoveryFn = vi.fn(() => multiHomedInterfaces());
    Object.assign(service, { interfaceDiscovery: discoveryFn });

    await service.getPrimaryBridgeUrl();
    await service.getPrimaryBridgeUrl();

    expect(discoveryFn).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledTimes(1);
    const [, , ttl] = redis.set.mock.calls[0];
    expect(ttl).toBe(DEFAULT_INTERFACE_CACHE_TTL_SECONDS);
  });

  it('forRoot accepts cache: null override (composition-root opt-out)', async () => {
    const dynamic = BridgeNetworkModule.forRoot({ resolution: { cache: null } });
    const service = resolveServiceFromModule(dynamic.providers ?? []);
    const discoveryFn = vi.fn(() => multiHomedInterfaces());
    Object.assign(service, { interfaceDiscovery: discoveryFn });

    await service.getPrimaryBridgeUrl();
    await service.getPrimaryBridgeUrl();

    expect(discoveryFn).toHaveBeenCalledTimes(2);
  });
});

describe('BridgeNetworkModule NetplanToKernelParamsService wiring', () => {
  it('forRoot wires the default ActiveBridgeIpsProvider so the service no longer treats `activeBridgeIps` as empty', () => {
    const customProvider: ActiveBridgeIpsProvider = {
      getActiveBridgeIps: vi.fn(async () => ['10.0.0.1']),
    };
    const dynamic = BridgeNetworkModule.forRoot({ activeBridgeIpsProvider: customProvider });
    const providers = dynamic.providers ?? [];
    const tokenProvider = findProvider(providers, ACTIVE_BRIDGE_IPS_PROVIDER);
    expect(tokenProvider.useValue).toBe(customProvider);
  });

  it('forRoot exposes a NETPLAN_KERNEL_PARAMS_FACTORY that bakes the active-ips provider into each per-jobId instance', async () => {
    const seen: string[] = [];
    const provider: ActiveBridgeIpsProvider = {
      getActiveBridgeIps: async (jobId) => {
        seen.push(jobId);
        return ['10.0.0.1'];
      },
    };
    const dynamic = BridgeNetworkModule.forRoot({ activeBridgeIpsProvider: provider });
    const providers = dynamic.providers ?? [];
    const factoryProvider = findProvider(providers, NETPLAN_KERNEL_PARAMS_FACTORY);
    if (typeof factoryProvider.useFactory !== 'function') throw new Error('expected useFactory');

    const factory: NetplanKernelParamsFactory = (jobId: string) => {
      const result = factoryProvider.useFactory!(provider);
      if (typeof result !== 'function') throw new Error('factory did not return a callable');
      const built = result(jobId);
      if (!(built instanceof NetplanToKernelParamsService)) throw new Error('did not build service');
      return built;
    };

    const built = factory('job-42');
    const netplan =
      'network:\n  ethernets:\n    eth0:\n      addresses: [10.0.0.5/24]\n      dhcp4: false\n      routes:\n        - to: 0.0.0.0/0\n          via: 10.0.0.1\n  version: 2\n';
    const result = await built.convertNetplanToKernelParams(netplan, { hostname: 'h' });
    expect(result.find((p) => p.startsWith('ip='))).toContain('10.0.0.5');
    expect(seen).toContain('job-42');
  });
});
