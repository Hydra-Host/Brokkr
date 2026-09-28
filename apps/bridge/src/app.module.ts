// JobIdMiddleware must run first to bind the AsyncLocalStorage frame that downstream logging/timing reads from.

import {
  type DynamicModule,
  Global,
  Inject,
  Injectable,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  type OnApplicationBootstrap,
  type Provider,
  RequestMethod,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { ZodType, ZodTypeDef } from 'zod';

import bridgePluginsConfig from './plugins.config.js';

import { AdminModule } from './admin/admin.module.js';
import { ConnectionRegistryModule } from './agent/connection-registry/connection-registry.module.js';
import { ConnectionRegistry } from './agent/connection-registry/connection-registry.service.js';
import { DispatchModule } from './agent/dispatch/dispatch.module.js';
import { Dispatcher } from './agent/dispatch/dispatcher.service.js';
import { GatewayModule } from './agent/gateway/gateway.module.js';
import { ResultPublisherModule } from './agent/result-publisher/result-publisher.module.js';
import { ResultPublisherService } from './agent/result-publisher/result-publisher.service.js';
import { TopologyBroadcasterModule } from './agent/topology-broadcaster/topology-broadcaster.module.js';
import type { BridgeRegistryReaderPort } from './agent/topology-broadcaster/topology-broadcaster.types.js';
import { setUpgradeTrigger } from './agent/upgrade/agent-upgrade-trigger.js';
import { AgentTokenService } from './auth/agent-token.service.js';
import { AuthContextService } from './auth/auth-context.service.js';
import { AuthModule } from './auth/auth.module.js';
import { AutoCollectionModule } from './auto-collection/auto-collection.module.js';
import {
  cooldownKey as autoCollectionCooldownKey,
  AutoCollectionService,
} from './auto-collection/auto-collection.service.js';
import { BenchmarksModule } from './benchmarks/benchmarks.module.js';
import { BridgeNetworkModule } from './bridge-network/bridge-network.module.js';
import { ATOM_FETCHER, type AtomFetcher } from './bridge-network/netplan-atom.service.js';
import { PeerAnchorResolver } from './bridge-network/peer-anchor-resolver.js';
import { BridgeStatusModule } from './bridge-status/bridge-status.module.js';
import { BrokkrLiveModule } from './brokkr-live/brokkr-live.module.js';
import { getBullmqConfig } from './bullmq/bullmq.config.js';
import { BullmqModule } from './bullmq/bullmq.module.js';
import { BULLMQ_QUEUE_FACTORY, BullmqQueueService } from './bullmq/queue.service.js';
import { ResultsService } from './bullmq/results.service.js';
import { CollectionModule } from './collection/collection.module.js';
import { CommissionModule } from './commission/commission.module.js';
import { RpcExceptionFilter } from './common/errors/rpc-exception.filter.js';
import { HttpSessionModule } from './common/http-session.module.js';
import { JobIdModule } from './common/job-id.module.js';
import { AccessLogMiddleware } from './common/middleware/access-log.middleware.js';
import { ClientIpMiddleware } from './common/middleware/client-ip.middleware.js';
import { JobIdMiddleware } from './common/middleware/job-id.middleware.js';
import { ResponseTimingMiddleware } from './common/middleware/response-timing.middleware.js';
import { BufferRedisModule } from './common/redis/buffer-redis.module.js';
import { BUFFER_REDIS } from './common/redis/redis-buffer-adapter.js';
import { loadRedisConfig, RedisEncryptor } from './common/redis/redis-client/index.js';
import { RedisModule } from './common/redis/redis.module.js';
import { RedisService } from './common/redis/redis.service.js';
import { buildRedisModuleOptions } from './composition/app-root-providers.js';
import { BmcCacheBinder } from './composition/bmc-cache-binder.js';
import { setBmcSecretSource } from './composition/bmc-secret-source-holder.js';
import {
  createCollectionJobEnqueuer,
  createRealBullmqQueueFactory,
  createRenderRequestEnqueuer,
} from './composition/bullmq-factories.js';
import {
  BULLMQ_COLLECTION_JOB_ENQUEUER,
  BULLMQ_RENDER_REQUEST_ENQUEUER,
  BULLMQ_RESULTS_SERVICE,
} from './composition/composition-tokens.js';
import { isDhcpLeaseCacheBound, setDhcpLeaseCache } from './composition/dhcp-lease-cache-holder.js';
import { isDhcpRegistryRedisBound, setDhcpRegistryRedis } from './composition/dhcp-registry-redis-holder.js';
import { RedisServiceLeaseCache } from './composition/dhcp-server-factory.js';
import {
  adaptBridgeRegistryReader,
  AGENT_UPGRADE_SERVICE,
  BRIDGE_REGISTRY_READER,
  buildAgentUpgradeService,
  buildDispatchModuleOptions,
  buildGatewayModuleOptions,
  PEER_ANCHOR_RESOLVER,
} from './composition/grpc-server-factory.js';
import {
  buildLeaderElectionModuleOptions,
  LEADER_CACHE,
  LEADER_INTERFACE_ENUMERATOR,
  leaderCacheProvider,
  leaderInterfaceEnumeratorProvider,
} from './composition/leader-election-factory.js';
import { buildResultsService } from './composition/results-service-factory.js';
import { getTelegrafFactoryHandle } from './composition/telegraf-singleton.js';
import {
  buildBridgeRegistryReaderFromRedis,
  getTopologyBroadcasterComposition,
} from './composition/topology-broadcaster-factory.js';
import { CronsModule } from './crons/crons.module.js';
import { DeprovisionModule } from './deprovision/deprovision.module.js';
import { DeviceHealthCheckModule } from './device-health-check/device-health-check.module.js';
import {
  type AtomCache,
  type EnqueueRenderRequest,
  getAtom,
  readAtom,
  readAtom as readAtomFromCache,
} from './device-record/atom/atom-fetcher.js';
import { DeviceRecordModule } from './device-record/device-record.module.js';
import { NetplanAtomService } from './device-record/netplan/netplan-atom.service.js';
import { NetplanModule } from './device-record/netplan/netplan.module.js';
import { createDeviceService } from './devices/device.service.js';
import { DevicesModule } from './devices/devices.module.js';
import { DiagnosticsModule } from './diagnostics/diagnostics.module.js';
import { DocsModule } from './docs/docs.module.js';
import { DiscoveryModule } from './download/discovery.module.js';
import { GrubModule } from './download/grub.module.js';
import { OsImageModule } from './download/os-image.module.js';
import { EnrichViaPxeModule } from './enrich-via-pxe/enrich-via-pxe.module.js';
import { InitrdModule } from './initrd/initrd.module.js';
import { IpxeModule } from './ipxe/ipxe.module.js';
import { JobLogSinkModule } from './job-logs/job-log-sink.module.js';
import { getLeaderConfig } from './leader-election/leader-election.config.js';
import { LeaderElectionModule } from './leader-election/leader-election.module.js';
import { LifecycleDeployModule } from './lifecycle-deploy/lifecycle-deploy.module.js';
import { ContextLogger } from './logger/logger.service.js';
import { DeviceHealthModule } from './monitoring/device-health/device-health.module.js';
import { DeviceSensorsModule } from './monitoring/device-sensors/device-sensors.module.js';
import { MonitoringIcmpModule } from './monitoring/icmp/icmp.module.js';
import { MonitoringIpmiModule } from './monitoring/ipmi/ipmi.module.js';
import { MonitoringModule } from './monitoring/monitoring.module.js';
import { MonitoringPrometheusModule } from './monitoring/prometheus/prometheus.module.js';
import { MonitoringRedfishModule } from './monitoring/redfish/redfish.module.js';
import { MonitoringSnmpModule } from './monitoring/snmp/snmp.module.js';
import { TelegrafModule } from './monitoring/telegraf/telegraf.module.js';
import { NetworkScanModule } from './network-scan/network-scan.module.js';
import { OobModule } from './oob/oob.module.js';
import { BridgePluginHostModule } from './plugin-host/bridge-plugin-host.module.js';
import { resolveBridgePluginBackends } from './plugin-host/resolve-plugin-backends.js';
import { PowerOpsModule } from './power-ops/power-ops.module.js';
import { ProvisionModule } from './provision/provision.module.js';
import { RedfishWorkflowModule } from './redfish-workflow/redfish-workflow.module.js';
import { getPlanManager, PLAN_PERSISTER_PROVIDER } from './saga-framework/plan-manager-holder.js';
import { PlanManagerService, type RedisLike } from './saga-framework/plan-manager.service.js';
import { SagaFrameworkModule } from './saga-framework/saga-framework.module.js';
import { getSagaDef } from './saga-framework/saga-registry.js';
import { SagaRunnerService } from './saga-framework/saga-runner.service.js';
import { SecretRevealModule } from './secret-reveal/secret-reveal.module.js';
import { SnmpModule } from './snmp/snmp.module.js';
import { getCronSupervisor } from './startup/cron-supervisor-singleton.js';
import { SyncModule } from './sync/sync.module.js';
import { TftpServerModule } from './tftp/tftp.module.js';
import { VrrpModule } from './vrrp/vrrp.module.js';
import { DeviceSecretAtomFetcher } from './zone-crypto/device-secret-atom.service.js';
import { ZoneCryptoModule } from './zone-crypto/zone-crypto.module.js';
import { ZoneCryptoService } from './zone-crypto/zone-crypto.service.js';

const contextLoggerProvider: Provider = {
  provide: ContextLogger,
  useFactory: () => new ContextLogger(),
};

@Global()
@Module({
  providers: [contextLoggerProvider],
  exports: [ContextLogger],
})
class AppLoggerModule {}

@Injectable()
class DhcpLeaseCacheBinder implements OnApplicationBootstrap {
  constructor(private readonly redis: RedisService) {}

  onApplicationBootstrap(): void {
    if (!isDhcpLeaseCacheBound()) {
      setDhcpLeaseCache(new RedisServiceLeaseCache(this.redis));
    }
    if (!isDhcpRegistryRedisBound()) {
      setDhcpRegistryRedis(this.redis);
    }
  }
}

@Module({
  providers: [BmcCacheBinder, DhcpLeaseCacheBinder],
})
class CacheBindingModule {}

@Injectable()
class BmcSecretSourceBinder implements OnApplicationBootstrap {
  constructor(
    private readonly redis: RedisService,
    @Inject(BULLMQ_RENDER_REQUEST_ENQUEUER) private readonly enqueueRenderRequest: EnqueueRenderRequest,
  ) {}

  onApplicationBootstrap(): void {
    setBmcSecretSource(
      new DeviceSecretAtomFetcher(this.redis, this.enqueueRenderRequest, getLeaderConfig().instanceId),
    );
  }
}

@Module({
  providers: [BmcSecretSourceBinder],
})
class BmcSecretSourceBindingModule {}

@Global()
@Module({
  providers: [leaderCacheProvider, leaderInterfaceEnumeratorProvider],
  exports: [LEADER_CACHE, LEADER_INTERFACE_ENUMERATOR],
})
class LeaderElectionCompositionModule {}

const topologyComposition = getTopologyBroadcasterComposition();

const BRIDGE_REGISTRY_READER_PORT = Symbol('BRIDGE_REGISTRY_READER_PORT');

@Global()
@Module({
  providers: [
    {
      provide: BRIDGE_REGISTRY_READER_PORT,
      useFactory: (redis: RedisService) => buildBridgeRegistryReaderFromRedis(redis),
      inject: [RedisService],
    },
    {
      provide: BRIDGE_REGISTRY_READER,
      useFactory: (reader: BridgeRegistryReaderPort) => adaptBridgeRegistryReader(reader),
      inject: [BRIDGE_REGISTRY_READER_PORT],
    },
    {
      provide: PEER_ANCHOR_RESOLVER,
      useFactory: () => new PeerAnchorResolver(),
    },
  ],
  exports: [BRIDGE_REGISTRY_READER_PORT, BRIDGE_REGISTRY_READER, PEER_ANCHOR_RESOLVER],
})
class BridgeRegistryReaderModule {}

const renderRequestEnqueuerProvider: Provider = {
  provide: BULLMQ_RENDER_REQUEST_ENQUEUER,
  useFactory: (queueService: BullmqQueueService, zoneCrypto: ZoneCryptoService) =>
    createRenderRequestEnqueuer(queueService, zoneCrypto),
  inject: [BullmqQueueService, ZoneCryptoService],
};

const collectionJobEnqueuerProvider: Provider = {
  provide: BULLMQ_COLLECTION_JOB_ENQUEUER,
  useFactory: (queueService: BullmqQueueService) => createCollectionJobEnqueuer(queueService),
  inject: [BullmqQueueService],
};

const realAtomFetcherProvider: Provider = {
  provide: ATOM_FETCHER,
  useFactory: (cache: AtomCache, enqueueRenderRequest: EnqueueRenderRequest): AtomFetcher => ({
    getAtom: <T>(args: {
      domain: string;
      entityId: string;
      atomKey: string;
      valueSchema: { parse(input: unknown): T };
      timeoutS?: number;
      jobId?: string;
    }) =>
      getAtom({
        cache,
        enqueueRenderRequest,
        bridgeId: getLeaderConfig().instanceId,
        domain: args.domain,
        entityId: args.entityId,
        atomKey: args.atomKey,
        valueSchema: args.valueSchema as unknown as ZodType<T, ZodTypeDef, unknown>,
        timeoutS: args.timeoutS,
        jobId: args.jobId,
      }),
  }),
  inject: [RedisService, BULLMQ_RENDER_REQUEST_ENQUEUER],
};

const bullmqQueueFactoryProvider: Provider = {
  provide: BULLMQ_QUEUE_FACTORY,
  useFactory: () => createRealBullmqQueueFactory(),
};

@Global()
@Module({
  imports: [ZoneCryptoModule],
  providers: [
    bullmqQueueFactoryProvider,
    { provide: PLAN_PERSISTER_PROVIDER, useValue: getPlanManager },
    BullmqQueueService,
    renderRequestEnqueuerProvider,
    collectionJobEnqueuerProvider,
    realAtomFetcherProvider,
  ],
  exports: [
    BullmqQueueService,
    PLAN_PERSISTER_PROVIDER,
    BULLMQ_RENDER_REQUEST_ENQUEUER,
    BULLMQ_COLLECTION_JOB_ENQUEUER,
    ATOM_FETCHER,
  ],
})
class BullmqProducersModule {}

const AUTO_COLLECTION_READ_ATOM_BINDING = Symbol('AUTO_COLLECTION_READ_ATOM_BINDING');

const autoCollectionReadAtomProvider: Provider = {
  provide: AUTO_COLLECTION_READ_ATOM_BINDING,
  useValue: readAtom,
};

@Global()
@Module({
  providers: [autoCollectionReadAtomProvider],
  exports: [AUTO_COLLECTION_READ_ATOM_BINDING],
})
class AutoCollectionReadAtomModule {}

const autoCollectionModule = AutoCollectionModule.forRoot({
  enqueueCollectionJobToken: BULLMQ_COLLECTION_JOB_ENQUEUER,
  cacheToken: RedisService,
  readAtomToken: AUTO_COLLECTION_READ_ATOM_BINDING,
});

const bullmqResultsServiceProvider: Provider = {
  provide: BULLMQ_RESULTS_SERVICE,
  useFactory: (
    queueService: BullmqQueueService,
    redis: RedisService,
    zoneCrypto: ZoneCryptoService,
    logger: ContextLogger,
  ): ResultsService => buildResultsService(queueService, redis, zoneCrypto, logger),
  inject: [BullmqQueueService, RedisService, ZoneCryptoService, ContextLogger],
};

@Global()
@Module({
  imports: [ZoneCryptoModule],
  providers: [bullmqResultsServiceProvider],
  exports: [BULLMQ_RESULTS_SERVICE],
})
class BullmqResultsServiceModule {}

const RESULTS_ADAPTER = Symbol('RESULTS_ADAPTER');

const resultsAdapterProvider: Provider = {
  provide: RESULTS_ADAPTER,
  useFactory: (results: ResultsService) => ({
    enqueuePhoneHome: (args: { deviceId: string; bootId: string }) => results.enqueuePhoneHome(args),
    writeCollectorToResultsCache: async (args: { deviceId: string; collector: string; data: unknown }) => {
      const [ok, kept] = await results.writeCollectorToResultsCache(args);
      return { ok, kept };
    },
  }),
  inject: [BULLMQ_RESULTS_SERVICE],
};

@Global()
@Module({
  imports: [BullmqResultsServiceModule],
  providers: [resultsAdapterProvider],
  exports: [RESULTS_ADAPTER],
})
class ResultsAdapterModule {}

const bullmqHandlerConfig = ((): {
  bullmqQueueName: string;
  deviceLockTimeoutSeconds: number;
  deviceLockRenewIntervalSeconds: number;
  lockWaitWarningSeconds: number;
  lockWaitHardCapSeconds: number;
} => {
  const cfg = getBullmqConfig();
  return {
    bullmqQueueName: cfg.bullmqQueueName,
    deviceLockTimeoutSeconds: cfg.deviceLockTimeoutSeconds,
    deviceLockRenewIntervalSeconds: cfg.deviceLockRenewIntervalSeconds,
    lockWaitWarningSeconds: cfg.lockWaitWarningSeconds,
    lockWaitHardCapSeconds: cfg.lockWaitHardCapSeconds,
  };
})();

const PLAN_MANAGER_REDIS = Symbol('PLAN_MANAGER_REDIS');

const planManagerRedisProvider: Provider = {
  provide: PLAN_MANAGER_REDIS,
  useFactory: (redis: RedisService): RedisLike => ({
    get: (key) => redis.get(key),
    set: (key, value, opts) => redis.set(key, value, opts?.ex),
    scan: (pattern) => redis.scan(pattern),
  }),
  inject: [RedisService],
};

@Global()
@Module({
  providers: [planManagerRedisProvider],
  exports: [PLAN_MANAGER_REDIS],
})
class PlanManagerRedisModule {}

const sagaFrameworkModule = SagaFrameworkModule.forRoot({
  planManagerConfig: {
    redisKeyPrefix: getBullmqConfig().redisKeyPrefix,
    defaultJobTtlSeconds: getBullmqConfig().defaultJobTtlSeconds,
  },
  redisToken: PLAN_MANAGER_REDIS,
  resultsQueueProducerToken: BULLMQ_RESULTS_SERVICE,
  encryptor: new RedisEncryptor(loadRedisConfig().encryptionKey),
});

const authModule = AuthModule.forRoot({ cacheToken: RedisService });
const resultPublisherModule = ResultPublisherModule.forRoot({
  redisToken: BUFFER_REDIS,
  zonePrefix: (process.env.BROKKR_ZONE_ID ?? '').trim(),
});
const connectionRegistryModule = ConnectionRegistryModule.forRoot({
  registry: topologyComposition.registry,
  global: true,
});
const dispatchModule = DispatchModule.forRoot({
  ...buildDispatchModuleOptions({
    connectionRegistryToken: ConnectionRegistry,
    resultPublisherToken: ResultPublisherService,
    imports: [connectionRegistryModule, resultPublisherModule],
  }),
  global: true,
});

const bullmqModule = BullmqModule.forRoot({
  imports: [autoCollectionModule, sagaFrameworkModule, dispatchModule, connectionRegistryModule],
  sagaHandlerCacheToken: RedisService,
  sagaHandlerPlanManagerToken: PlanManagerService,
  sagaHandlerRunnerToken: SagaRunnerService,
  sagaHandlerSagaProvider: { getSagaDef },
  sagaHandlerConfig: bullmqHandlerConfig,
  processorConfig: getBullmqConfig(),
  collectionHandlerDispatcherToken: Dispatcher,
  collectionHandlerRegistryToken: ConnectionRegistry,
  collectionHandlerResultsToken: BULLMQ_RESULTS_SERVICE,
  collectionHandlerCacheToken: RedisService,
  collectionHandlerCooldown: { cooldownKey: autoCollectionCooldownKey },
  diagnosticsHandlerDispatcherToken: Dispatcher,
  diagnosticsHandlerRegistryToken: ConnectionRegistry,
  testingHandlerDispatcherToken: Dispatcher,
  testingHandlerRegistryToken: ConnectionRegistry,
  sagaCooldownClearerCacheToken: RedisService,
  inboundEnvelopeOpenerZoneIdProvider: {
    getZoneId: () => (process.env.BROKKR_ZONE_ID ?? '').trim(),
  },
});

const ipxeModule = IpxeModule.forRoot({
  enqueueRenderRequestToken: BULLMQ_RENDER_REQUEST_ENQUEUER,
});

const initrdModule = InitrdModule.forRoot({
  enqueueRenderRequestToken: BULLMQ_RENDER_REQUEST_ENQUEUER,
  bridgeId: getLeaderConfig().instanceId,
});

const deviceRecordModule = DeviceRecordModule.forRoot({
  cacheToken: RedisService,
  enqueueRenderRequestToken: BULLMQ_RENDER_REQUEST_ENQUEUER,
});

const netplanModule = NetplanModule.forRoot({
  cacheToken: RedisService,
  enqueueRenderRequestToken: BULLMQ_RENDER_REQUEST_ENQUEUER,
  bridgeId: getLeaderConfig().instanceId,
});

const agentUpgradeServiceProvider: Provider = {
  provide: AGENT_UPGRADE_SERVICE,
  useFactory: (
    redis: RedisService,
    dispatcher: Dispatcher,
    agentTokenService: AgentTokenService,
    atomFetcher: AtomFetcher,
    netplanAtom: NetplanAtomService,
    bridgeRegistry: BridgeRegistryReaderPort,
  ) => {
    const atomFetcherLike = {
      getAtom: atomFetcher.getAtom.bind(atomFetcher),
      readAtom: <T>(key: string, valueSchema: Parameters<typeof readAtomFromCache<T>>[2], jobId?: string) =>
        readAtomFromCache(redis, key, valueSchema, { jobId }),
    };
    const service = buildAgentUpgradeService({
      cache: redis,
      dispatch: (deviceId, operation, input, options) =>
        dispatcher.dispatch(deviceId, operation, input, {
          jobId: options?.jobId ?? null,
          timeoutS: options?.timeoutS ?? null,
        }),
      deviceService: {
        getDeviceById: async (deviceId: string) => {
          const svc = await createDeviceService('', {
            cache: redis,
            atomFetcher: atomFetcherLike,
            getLiveNetplan: (id, netplanJobId) => netplanAtom.getLiveNetplan(id, { jobId: netplanJobId }),
          });
          return svc.getDeviceById(deviceId);
        },
      },
      tokenService: agentTokenService,
      bridgeRegistry,
    });
    setUpgradeTrigger((args) => service.upgradeAgent(args));
    return service;
  },
  inject: [RedisService, Dispatcher, AgentTokenService, ATOM_FETCHER, NetplanAtomService, BRIDGE_REGISTRY_READER_PORT],
};

@Global()
@Module({
  imports: [authModule, dispatchModule, deviceRecordModule, netplanModule],
  providers: [agentUpgradeServiceProvider],
  exports: [AGENT_UPGRADE_SERVICE],
})
class AgentUpgradeServiceModule {}

@Module({
  imports: [
    AppLoggerModule,
    BufferRedisModule,
    JobIdModule,
    RedisModule.forRoot(buildRedisModuleOptions()),
    JobLogSinkModule,
    BridgePluginHostModule,
    BmcSecretSourceBindingModule,
    CacheBindingModule,
    LeaderElectionCompositionModule,
    BridgeStatusModule,
    DiagnosticsModule,
    CronsModule,
    TftpServerModule,
    AdminModule.forRoot({ cronSupervisor: () => getCronSupervisor() }),
    authModule,
    BridgeNetworkModule.forRoot(),
    LeaderElectionModule.forRoot(buildLeaderElectionModuleOptions()),
    // Must come AFTER LeaderElectionModule — shutdown runs in reverse init order, so VrrpModule detaches VIPs before the leader key is released (see vrrp.module.ts).
    VrrpModule.forRoot(),
    PlanManagerRedisModule,
    sagaFrameworkModule,
    resultPublisherModule,
    BullmqProducersModule,
    BullmqResultsServiceModule,
    AutoCollectionReadAtomModule,
    autoCollectionModule,
    bullmqModule,
    deviceRecordModule,
    netplanModule,
    ipxeModule,
    initrdModule,
    TelegrafModule.forRoot(getTelegrafFactoryHandle().moduleOptions),
    DocsModule,
    DiscoveryModule,
    GrubModule,
    OsImageModule,
    DeviceSensorsModule,
    MonitoringIcmpModule,
    MonitoringIpmiModule,
    MonitoringModule,
    MonitoringPrometheusModule,
    MonitoringRedfishModule,
    MonitoringSnmpModule,
    DeviceHealthModule,
    SnmpModule,
    DevicesModule,
    ZoneCryptoModule,
    connectionRegistryModule,
    TopologyBroadcasterModule.forRoot({
      ...topologyComposition.moduleOptions,
      readerToken: BRIDGE_REGISTRY_READER_PORT,
      anchorResolverToken: PEER_ANCHOR_RESOLVER,
    }),
    BridgeRegistryReaderModule,
    AgentUpgradeServiceModule,
    GatewayModule.forRoot(
      buildGatewayModuleOptions({
        tokenServiceToken: AgentTokenService,
        authContextServiceToken: AuthContextService,
        connectionRegistryToken: ConnectionRegistry,
        resultPublisherToken: ResultPublisherService,
        bridgeRegistryReaderToken: BRIDGE_REGISTRY_READER,
        peerAnchorResolverToken: PEER_ANCHOR_RESOLVER,
        redisCacheToken: RedisService,
        resultsAdapterToken: RESULTS_ADAPTER,
        agentUpgradeServiceToken: AGENT_UPGRADE_SERVICE,
        autoCollectionServiceToken: AutoCollectionService,
        imports: [
          authModule,
          connectionRegistryModule,
          resultPublisherModule,
          BridgeRegistryReaderModule,
          ResultsAdapterModule,
          AgentUpgradeServiceModule,
          autoCollectionModule,
        ],
      }),
    ),
    dispatchModule,
    OobModule,
    CollectionModule,
    BrokkrLiveModule,
    LifecycleDeployModule,
    BenchmarksModule,
    DeprovisionModule,
    DeviceHealthCheckModule,
    EnrichViaPxeModule,
    RedfishWorkflowModule,
    NetworkScanModule,
    CommissionModule,
    PowerOpsModule,
    ProvisionModule,
    SecretRevealModule,
    SyncModule,
    HttpSessionModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: RpcExceptionFilter }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(JobIdMiddleware, ClientIpMiddleware, ResponseTimingMiddleware, AccessLogMiddleware)
      .forRoutes({ path: '*', method: RequestMethod.ALL });
  }

  static async withPluginBackends(): Promise<DynamicModule> {
    return {
      module: AppModule,
      imports: await resolveBridgePluginBackends(bridgePluginsConfig),
    };
  }
}

export { BULLMQ_COLLECTION_JOB_ENQUEUER, BULLMQ_RENDER_REQUEST_ENQUEUER } from './composition/composition-tokens.js';

void NetplanAtomService;
void ConnectionRegistry;
void AutoCollectionService;
