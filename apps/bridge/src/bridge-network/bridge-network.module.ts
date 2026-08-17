import { DynamicModule, Global, Module, Provider } from '@nestjs/common';

import { RedisService } from '../common/redis/redis.service';
import { getApplicationConfig } from '../core/application.config';

import { createDefaultActiveBridgeIpsProvider } from './active-bridge-ips-provider';
import {
  type AppConfigProvider,
  type BridgeIpResolutionDeps,
  BridgeIpResolutionService,
  type ResolutionCache,
} from './bridge-ip-resolution.service';
import { NetplanAtomService } from './netplan-atom.service';
import { netplanAddressExtractor } from './netplan-extract-addresses';
import { type ActiveBridgeIpsProvider, NetplanToKernelParamsService } from './netplan-to-kernel-params.service';

export const DEFAULT_INTERFACE_CACHE_TTL_SECONDS = 300;

export const ACTIVE_BRIDGE_IPS_PROVIDER = Symbol('ActiveBridgeIpsProvider');
export const NETPLAN_KERNEL_PARAMS_FACTORY = Symbol('NetplanKernelParamsFactory');

export type NetplanKernelParamsFactory = (jobId: string) => NetplanToKernelParamsService;

export interface BridgeNetworkModuleOptions {
  resolution?: Partial<BridgeIpResolutionDeps>;
  activeBridgeIpsProvider?: ActiveBridgeIpsProvider;
}

export function appConfigProviderFromEnv(): AppConfigProvider {
  return { bridgeUrl: getApplicationConfig().bridgeUrl };
}

function buildResolutionProvider(options: BridgeNetworkModuleOptions): Provider {
  return {
    provide: BridgeIpResolutionService,
    useFactory: (redis: RedisService) => {
      const overrides = options.resolution ?? {};
      const cache: ResolutionCache | null = overrides.cache !== undefined ? overrides.cache : redis;
      return new BridgeIpResolutionService({
        netplanAddressExtractor,
        appConfig: appConfigProviderFromEnv(),
        cache,
        interfaceCacheTtlSeconds: DEFAULT_INTERFACE_CACHE_TTL_SECONDS,
        ...overrides,
      });
    },
    inject: [RedisService],
  };
}

function buildActiveBridgeIpsProvider(options: BridgeNetworkModuleOptions): Provider {
  return {
    provide: ACTIVE_BRIDGE_IPS_PROVIDER,
    useValue: options.activeBridgeIpsProvider ?? createDefaultActiveBridgeIpsProvider(),
  };
}

const netplanToKernelParamsProvider: Provider = {
  provide: NetplanToKernelParamsService,
  useFactory: (provider: ActiveBridgeIpsProvider) => new NetplanToKernelParamsService('', provider),
  inject: [ACTIVE_BRIDGE_IPS_PROVIDER],
};

const netplanKernelParamsFactoryProvider: Provider = {
  provide: NETPLAN_KERNEL_PARAMS_FACTORY,
  useFactory:
    (provider: ActiveBridgeIpsProvider): NetplanKernelParamsFactory =>
    (jobId: string) =>
      new NetplanToKernelParamsService(jobId, provider),
  inject: [ACTIVE_BRIDGE_IPS_PROVIDER],
};

// @Global: one cached BridgeIpResolutionService for all injectors; local providers would shadow it with uncached duplicates.
@Global()
@Module({
  providers: [
    NetplanAtomService,
    buildActiveBridgeIpsProvider({}),
    buildResolutionProvider({}),
    netplanToKernelParamsProvider,
    netplanKernelParamsFactoryProvider,
  ],
  exports: [
    NetplanAtomService,
    BridgeIpResolutionService,
    NetplanToKernelParamsService,
    ACTIVE_BRIDGE_IPS_PROVIDER,
    NETPLAN_KERNEL_PARAMS_FACTORY,
  ],
})
export class BridgeNetworkModule {
  static forRoot(options: BridgeNetworkModuleOptions = {}): DynamicModule {
    return {
      module: BridgeNetworkModule,
      global: true,
      providers: [
        NetplanAtomService,
        buildActiveBridgeIpsProvider(options),
        buildResolutionProvider(options),
        netplanToKernelParamsProvider,
        netplanKernelParamsFactoryProvider,
      ],
      exports: [
        NetplanAtomService,
        BridgeIpResolutionService,
        NetplanToKernelParamsService,
        ACTIVE_BRIDGE_IPS_PROVIDER,
        NETPLAN_KERNEL_PARAMS_FACTORY,
      ],
    };
  }
}
