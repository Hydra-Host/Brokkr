import { Module, type DynamicModule, type Provider, type Type } from '@nestjs/common';

import { BridgeIpResolutionService } from '../bridge-network/bridge-ip-resolution.service';
import {
  NETPLAN_KERNEL_PARAMS_FACTORY,
  type NetplanKernelParamsFactory,
} from '../bridge-network/bridge-network.module';
import { fetchLiveNetplanForInitrd } from '../bridge-network/initrd-netplan';
import { NetplanAtomService } from '../bridge-network/netplan-atom.service';
import { BULLMQ_QUEUE_FACTORY, BullmqQueueService, type BullmqQueueFactory } from '../bullmq/queue.service';
import { deviceIpxeUrl, deviceServerToken, ipxeChainHit, normalizeDiscoveryMac } from '../common/redis/redis-keys';
import { RedisService } from '../common/redis/redis.service';
import { createRealBullmqQueueFactory } from '../composition/bullmq-factories';
import { getAtom, type EnqueueRenderRequest } from '../device-record/atom/atom-fetcher';
import { serverTokenAtomSchema } from '../device-record/atom/server-token.schema';
import type { DeviceRecord } from '../device-record/device-record.schema';
import {
  DEVICE_RECORD_CACHE,
  DEVICE_RECORD_RENDER_ENQUEUER,
  DeviceRecordService,
} from '../device-record/device-record.service';
import { DeviceService, type AtomFetcherLike, type GetLiveNetplanFn } from '../devices/device.service';
import { getLeaderConfig } from '../leader-election/leader-election.config';
import { logDebug, logError, logInfo, logWarning } from '../logger/logger.service';
import { PLAN_PERSISTER_PROVIDER, type PlanPersisterProvider } from '../saga-framework/plan-manager-holder';
import { ZoneCryptoModule } from '../zone-crypto/zone-crypto.module';
import { ZoneCryptoService } from '../zone-crypto/zone-crypto.service';

import {
  ChainService,
  IPXE_INVENTORY_TRIGGER,
  IPXE_INVENTORY_TRIGGER_LOGGER,
  IPXE_KERNEL_NETWORK_BUILDER,
  IPXE_REDIS_IPXE_URL_LOOKUP,
  IPXE_RENDERER,
  type InventoryTrigger,
  type KernelNetworkBuilder,
  type RedisIpxeUrlLookup,
} from './chain.service';
import type { InventoryTriggerLogger } from './chain.types';
import { IpxeTemplateRenderer, type ServerTokenAtomFetcher } from './ipxe-renderer.service';
import { getIpxeConfig } from './ipxe.config';
import {
  IPXE_CHAIN_HIT_RECORDER,
  IPXE_PENDING_DEVICE_REGISTRAR,
  IpxeController,
  type ChainHitRecorder,
  type PendingDeviceRegistrar,
} from './ipxe.controller';

export const IPXE_RENDER_REQUEST_ENQUEUER = Symbol('IpxeRenderRequestEnqueuer');

export interface IpxeModuleOptions {
  enqueueRenderRequest?: EnqueueRenderRequest;
  enqueueRenderRequestToken?: Type<unknown> | symbol | string;
}

const ipxeRendererProvider: Provider = {
  provide: IPXE_RENDERER,
  useFactory: (redis: RedisService, enqueueRenderRequest: EnqueueRenderRequest) => {
    const config = getIpxeConfig();
    const fetcher: ServerTokenAtomFetcher = (request) =>
      getAtom({
        cache: redis,
        enqueueRenderRequest,
        bridgeId: getLeaderConfig().instanceId,
        domain: request.domain,
        entityId: request.entityId,
        atomKey: request.atomKey,
        valueSchema: serverTokenAtomSchema,
        jobId: request.jobId,
      });
    return new IpxeTemplateRenderer(config, fetcher);
  },
  inject: [RedisService, IPXE_RENDER_REQUEST_ENQUEUER],
};

// Keeps the key helper imported so a redis-keys rename breaks compilation here, not at runtime.
void deviceServerToken;

const redisIpxeUrlLookupProvider: Provider = {
  provide: IPXE_REDIS_IPXE_URL_LOOKUP,
  useFactory: (redis: RedisService): RedisIpxeUrlLookup => {
    return async (deviceId, jobId) => redis.get(deviceIpxeUrl(deviceId), jobId);
  },
  inject: [RedisService],
};

function hostnameFromRecord(record: DeviceRecord): string {
  return `host-${record.id}`;
}

// Failures log + return [] so a broken netplan never blocks boot; DHCP fallback recovers on the next chain hit.
const kernelNetworkBuilderProvider: Provider = {
  provide: IPXE_KERNEL_NETWORK_BUILDER,
  useFactory: (
    bridgeIpResolver: BridgeIpResolutionService,
    netplanFactory: NetplanKernelParamsFactory,
    netplanAtom: NetplanAtomService,
  ): KernelNetworkBuilder => {
    return async (record, jobId) => {
      try {
        let netplanYaml = record.netplan;
        if (!netplanYaml || !netplanYaml.trim()) {
          netplanYaml = await fetchLiveNetplanForInitrd(netplanAtom, record.id, { jobId });
        }
        if (!netplanYaml || !netplanYaml.trim()) {
          await logDebug(`No valid netplan data for device ${record.id}, using DHCP fallback`, { jobId });
          return [];
        }

        let bridgeIp = '';
        try {
          const resolved = await bridgeIpResolver.getBridgeIpForDevice(netplanYaml);
          if (resolved && resolved !== '127.0.0.1') {
            bridgeIp = resolved;
            await logDebug(`Using bridge IP as nameserver: ${bridgeIp}`, { jobId });
          } else {
            await logDebug('No valid bridge IP available for nameserver', { jobId });
          }
        } catch (exc) {
          await logWarning(
            `Failed to get bridge IP for nameserver: ${exc instanceof Error ? exc.message : String(exc)}`,
            { jobId },
          );
        }

        const netplanService = netplanFactory(jobId);
        const casperParams = await netplanService.convertNetplanToKernelParams(netplanYaml, {
          hostname: hostnameFromRecord(record),
          bridgeIp,
        });
        await logInfo(
          `Generated ${casperParams.length} Casper network parameters for device ${record.id} with hostname ${hostnameFromRecord(record)}`,
          { jobId },
        );
        return casperParams;
      } catch (exc) {
        await logError(
          `Failed to generate Casper network parameters for device ${record.id}: ${exc instanceof Error ? exc.message : String(exc)}`,
          { jobId },
        );
        return [];
      }
    };
  },
  inject: [BridgeIpResolutionService, NETPLAN_KERNEL_PARAMS_FACTORY, NetplanAtomService],
};

const inventoryTriggerProvider: Provider = {
  provide: IPXE_INVENTORY_TRIGGER,
  useFactory: (queue: BullmqQueueService): InventoryTrigger => {
    return async (deviceId, jobId) => {
      const { randomUUID } = await import('node:crypto');
      const planId = randomUUID();
      const enqueued = await queue.enqueueSagaJob({
        planId,
        sagaName: 'inventory_collection',
        payload: { device_id: deviceId },
        deviceId,
        bridgeLocal: true,
      });
      if (enqueued) {
        await logInfo(`Triggered inventory_collection saga for device ${deviceId} (plan=${planId})`, { jobId });
      } else {
        await logWarning(`Failed to trigger inventory_collection saga for device ${deviceId} (queue unavailable)`, {
          jobId,
        });
      }
    };
  },
  inject: [BullmqQueueService],
};

const inventoryTriggerLogger: InventoryTriggerLogger = {
  warn: (message, meta) => {
    const jobId = typeof meta?.jobId === 'string' ? meta.jobId : '';
    return logWarning(message, { jobId, appClassName: 'ipxe-chain' });
  },
};

const inventoryTriggerLoggerProvider: Provider = {
  provide: IPXE_INVENTORY_TRIGGER_LOGGER,
  useValue: inventoryTriggerLogger,
};

const pendingDeviceAtomFetcherStub: AtomFetcherLike = {
  getAtom: () => {
    throw new Error('IPXE_PENDING_DEVICE_REGISTRAR: atomFetcher.getAtom is not wired on this path');
  },
  readAtom: () => {
    throw new Error('IPXE_PENDING_DEVICE_REGISTRAR: atomFetcher.readAtom is not wired on this path');
  },
};

const pendingDeviceGetLiveNetplanStub: GetLiveNetplanFn = () => {
  throw new Error('IPXE_PENDING_DEVICE_REGISTRAR: getLiveNetplan is not wired on this path');
};

const pendingDeviceRegistrarProvider: Provider = {
  provide: IPXE_PENDING_DEVICE_REGISTRAR,
  useFactory: (redis: RedisService): PendingDeviceRegistrar => {
    return async (jobId, facts): Promise<boolean> => {
      const svc = new DeviceService(jobId, {
        cache: redis,
        atomFetcher: pendingDeviceAtomFetcherStub,
        getLiveNetplan: pendingDeviceGetLiveNetplanStub,
      });
      return svc.registerPendingDevice({ ...facts });
    };
  },
  inject: [RedisService],
};

const CHAIN_HIT_TTL_S = 86_400;

const chainHitRecorderProvider: Provider = {
  provide: IPXE_CHAIN_HIT_RECORDER,
  useFactory: (redis: RedisService): ChainHitRecorder => {
    return async (jobId, mac, deviceId): Promise<void> => {
      await redis.set(
        ipxeChainHit(normalizeDiscoveryMac(mac)),
        JSON.stringify({ atMs: Date.now(), deviceId }),
        CHAIN_HIT_TTL_S,
        jobId,
      );
    };
  },
  inject: [RedisService],
};

const deviceRecordCacheProvider: Provider = {
  provide: DEVICE_RECORD_CACHE,
  useExisting: RedisService,
};

const deviceRecordEnqueuerProvider: Provider = {
  provide: DEVICE_RECORD_RENDER_ENQUEUER,
  useExisting: IPXE_RENDER_REQUEST_ENQUEUER,
};

const redisServicePlaceholderProvider: Provider = {
  provide: RedisService,
  useValue: new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(
          `RedisService accessed without a real provider: import RedisModule.forRoot(...) at the app root or override RedisService in tests (called: ${String(prop)})`,
        );
      },
    },
  ) as unknown as RedisService,
};

const bullmqQueueFactoryProvider: Provider = {
  provide: BULLMQ_QUEUE_FACTORY,
  useFactory: () => createRealBullmqQueueFactory(),
};

const bullmqQueueServiceProvider: Provider = {
  provide: BullmqQueueService,
  useFactory: (factory: BullmqQueueFactory, zoneCrypto: ZoneCryptoService, planPersister?: PlanPersisterProvider) =>
    new BullmqQueueService(factory, undefined, zoneCrypto, planPersister),
  inject: [BULLMQ_QUEUE_FACTORY, ZoneCryptoService, { token: PLAN_PERSISTER_PROVIDER, optional: true }],
};

@Module({})
export class IpxeModule {
  static forRoot(options: IpxeModuleOptions): DynamicModule {
    if (options.enqueueRenderRequest === undefined && options.enqueueRenderRequestToken === undefined) {
      throw new Error(
        'IpxeModule.forRoot: exactly one of `enqueueRenderRequest` (value) or `enqueueRenderRequestToken` (DI token) must be supplied',
      );
    }

    const renderRequestEnqueuerProvider: Provider =
      options.enqueueRenderRequestToken !== undefined
        ? {
            provide: IPXE_RENDER_REQUEST_ENQUEUER,
            useFactory: (enqueuer: EnqueueRenderRequest) => enqueuer,
            inject: [options.enqueueRenderRequestToken],
          }
        : {
            provide: IPXE_RENDER_REQUEST_ENQUEUER,
            useValue: options.enqueueRenderRequest as EnqueueRenderRequest,
          };

    const providers: Provider[] = [
      ...(options.enqueueRenderRequestToken !== undefined ? [] : [redisServicePlaceholderProvider]),
      bullmqQueueFactoryProvider,
      bullmqQueueServiceProvider,
      renderRequestEnqueuerProvider,
      deviceRecordCacheProvider,
      deviceRecordEnqueuerProvider,
      DeviceRecordService,
      ipxeRendererProvider,
      redisIpxeUrlLookupProvider,
      kernelNetworkBuilderProvider,
      inventoryTriggerProvider,
      inventoryTriggerLoggerProvider,
      pendingDeviceRegistrarProvider,
      chainHitRecorderProvider,
      ChainService,
    ];

    const exports: DynamicModule['exports'] =
      options.enqueueRenderRequestToken !== undefined ? [ChainService] : [ChainService, RedisService];

    return {
      module: IpxeModule,
      imports: [ZoneCryptoModule],
      controllers: [IpxeController],
      providers,
      exports,
    };
  }
}
