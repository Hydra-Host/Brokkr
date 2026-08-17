import {
  DynamicModule,
  Inject,
  Injectable,
  Module,
  Optional,
  Provider,
  Type,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';

import { AutoCollectionService } from '../auto-collection/auto-collection.service';
import {
  createCollectionSweepQueue,
  createCollectionWorker,
  createLifecycleSweepQueue,
  createLifecycleWorker,
} from '../composition/bullmq-factories';
import { registerStrandedPlanResumeCron } from '../crons/stranded-plan-resume.cron';
import { ContextLogger } from '../logger/logger.service';
import { NotificationsService } from '../saga-framework/notifications.service';
import { PlanManagerService } from '../saga-framework/plan-manager.service';
import { SealedEnvelopeService } from '../zone-crypto/sealed-envelope.service';
import { ZoneCryptoModule } from '../zone-crypto/zone-crypto.module';
import { ZoneCryptoService } from '../zone-crypto/zone-crypto.service';

import { setBullmqProcessor } from './bullmq-processor-singleton';
import { BullmqSupervisorService } from './bullmq-supervisor.service';
import { getBullmqConfig } from './bullmq.config';
import { JOB_NAME } from './bullmq.types';
import type {
  CollectionCacheLike,
  CollectionCooldownKey,
  CollectionDispatcherLike,
  CollectionLogger,
  CollectionRegistryLike,
  CollectionResultsLike,
} from './collection.handler';
import { CollectionJobHandler } from './collection.handler';
import type { DiagnosticsDispatcherLike, DiagnosticsLogger, DiagnosticsRegistryLike } from './diagnostics.handler';
import { DiagnosticsJobHandler } from './diagnostics.handler';
import {
  BullmqProcessorService,
  type BullmqProcessorConfig,
  type InboundEnvelopeOpener,
  type LockWaitCache,
} from './handlers.service';
import {
  InboundEnvelopeOpenerService,
  type InboundEnvelopeLogger,
  type ZoneIdProvider as InboundEnvelopeZoneIdProvider,
} from './inbound-envelope.service';
import { BullmqQueueService } from './queue.service';
import { BullmqRegistryService } from './registry.service';
import {
  SAGA_COOLDOWN_CACHE,
  SAGA_COOLDOWN_LOGGER,
  SagaCooldownClearerService,
  type SagaCooldownCache,
  type SagaCooldownLogger,
} from './saga-cooldown-clearer.service';
import {
  SAGA_PAYLOAD_SCHEMA_REGISTRY,
  productionSagaPayloadSchemaRegistry,
} from './saga-payload-schema-registry.provider';
import type { SagaPayloadSchemaRegistry } from './saga-payload-validate';
import type {
  SagaCooldownClearer,
  SagaDefProvider,
  SagaHandlerCache,
  SagaHandlerConfig,
  SagaHandlerLogger,
  SagaPlanManagerLike,
  SagaRunnerLike,
} from './saga.handler';
import { SagaJobHandler } from './saga.handler';
import type { TestingDispatcherLike, TestingLogger, TestingRegistryLike } from './testing.handler';
import { TestingJobHandler } from './testing.handler';

export const SAGA_HANDLER_CACHE = Symbol('SAGA_HANDLER_CACHE');
export const SAGA_HANDLER_PLAN_MANAGER = Symbol('SAGA_HANDLER_PLAN_MANAGER');
export const SAGA_HANDLER_RUNNER = Symbol('SAGA_HANDLER_RUNNER');
export const SAGA_HANDLER_DEF_PROVIDER = Symbol('SAGA_HANDLER_DEF_PROVIDER');
export const SAGA_HANDLER_CONFIG = Symbol('SAGA_HANDLER_CONFIG');
export const SAGA_HANDLER_LOGGER = Symbol('SAGA_HANDLER_LOGGER');

export const COLLECTION_HANDLER_DISPATCHER = Symbol('COLLECTION_HANDLER_DISPATCHER');
export const COLLECTION_HANDLER_REGISTRY = Symbol('COLLECTION_HANDLER_REGISTRY');
export const COLLECTION_HANDLER_RESULTS = Symbol('COLLECTION_HANDLER_RESULTS');
export const COLLECTION_HANDLER_CACHE = Symbol('COLLECTION_HANDLER_CACHE');
export const COLLECTION_HANDLER_COOLDOWN = Symbol('COLLECTION_HANDLER_COOLDOWN');
export const COLLECTION_HANDLER_LOGGER = Symbol('COLLECTION_HANDLER_LOGGER');

export const INBOUND_ENVELOPE_ZONE_ID_PROVIDER = Symbol('INBOUND_ENVELOPE_ZONE_ID_PROVIDER');
export const INBOUND_ENVELOPE_LOGGER = Symbol('INBOUND_ENVELOPE_LOGGER');

export const DIAGNOSTICS_HANDLER_DISPATCHER = Symbol('DIAGNOSTICS_HANDLER_DISPATCHER');
export const DIAGNOSTICS_HANDLER_REGISTRY = Symbol('DIAGNOSTICS_HANDLER_REGISTRY');
export const DIAGNOSTICS_HANDLER_LOGGER = Symbol('DIAGNOSTICS_HANDLER_LOGGER');

export const TESTING_HANDLER_DISPATCHER = Symbol('TESTING_HANDLER_DISPATCHER');
export const TESTING_HANDLER_REGISTRY = Symbol('TESTING_HANDLER_REGISTRY');
export const TESTING_HANDLER_LOGGER = Symbol('TESTING_HANDLER_LOGGER');

export type BullmqDepToken<T = unknown> = Type<T> | symbol | string;

export interface BullmqModuleOptions {
  sagaHandlerCacheToken: BullmqDepToken<SagaHandlerCache & LockWaitCache>;
  sagaHandlerPlanManagerToken: BullmqDepToken<SagaPlanManagerLike>;
  sagaHandlerRunnerToken: BullmqDepToken<SagaRunnerLike>;
  sagaHandlerSagaProvider: SagaDefProvider;
  sagaHandlerConfig: SagaHandlerConfig;
  sagaHandlerLoggerToken?: BullmqDepToken<SagaHandlerLogger>;
  processorConfig?: BullmqProcessorConfig;

  collectionHandlerDispatcherToken: BullmqDepToken<CollectionDispatcherLike>;
  collectionHandlerRegistryToken: BullmqDepToken<CollectionRegistryLike>;
  collectionHandlerResultsToken: BullmqDepToken<CollectionResultsLike>;
  collectionHandlerCacheToken: BullmqDepToken<CollectionCacheLike>;
  collectionHandlerCooldown: CollectionCooldownKey;
  collectionHandlerLoggerToken?: BullmqDepToken<CollectionLogger>;

  diagnosticsHandlerDispatcherToken: BullmqDepToken<DiagnosticsDispatcherLike>;
  diagnosticsHandlerRegistryToken: BullmqDepToken<DiagnosticsRegistryLike>;
  diagnosticsHandlerLoggerToken?: BullmqDepToken<DiagnosticsLogger>;

  testingHandlerDispatcherToken: BullmqDepToken<TestingDispatcherLike>;
  testingHandlerRegistryToken: BullmqDepToken<TestingRegistryLike>;
  testingHandlerLoggerToken?: BullmqDepToken<TestingLogger>;

  sagaCooldownClearerCacheToken: BullmqDepToken<SagaCooldownCache>;
  sagaCooldownClearerLoggerToken?: BullmqDepToken<SagaCooldownLogger>;

  inboundEnvelopeOpenerZoneIdProvider: InboundEnvelopeZoneIdProvider;
  inboundEnvelopeOpenerLoggerToken?: BullmqDepToken<InboundEnvelopeLogger>;

  imports?: DynamicModule['imports'];
}

@Injectable()
export class BullmqHandlerRegistrar {
  constructor(
    private readonly registry: BullmqRegistryService,
    @Optional() sagaHandler?: SagaJobHandler,
    @Optional() collectionHandler?: CollectionJobHandler,
    @Optional() diagnosticsHandler?: DiagnosticsJobHandler,
    @Optional() testingHandler?: TestingJobHandler,
  ) {
    if (sagaHandler) {
      this.registry.register(JOB_NAME.SAGA_RUN, sagaHandler.handle);
    }
    if (collectionHandler) {
      this.registry.register(JOB_NAME.COLLECTION_RUN, collectionHandler.handle);
    }
    if (diagnosticsHandler) {
      this.registry.register(JOB_NAME.DIAGNOSTICS_RUN, diagnosticsHandler.handle);
    }
    if (testingHandler) {
      this.registry.register(JOB_NAME.TESTING_RUN, testingHandler.handle);
    }
  }
}

@Module({
  providers: [
    BullmqSupervisorService,
    BullmqRegistryService,
    { provide: SAGA_PAYLOAD_SCHEMA_REGISTRY, useValue: productionSagaPayloadSchemaRegistry },
  ],
  exports: [BullmqSupervisorService, BullmqRegistryService, SAGA_PAYLOAD_SCHEMA_REGISTRY],
})
export class BullmqModule implements OnModuleInit, OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    private readonly supervisor: BullmqSupervisorService,
    @Optional() @Inject(SAGA_HANDLER_PLAN_MANAGER) private readonly planManager?: PlanManagerService,
    @Optional() private readonly queue?: BullmqQueueService,
  ) {}

  onModuleInit(): void {
    if (this.planManager !== undefined && this.queue !== undefined) {
      registerStrandedPlanResumeCron(this.planManager, this.queue);
    }
  }

  onApplicationBootstrap(): void {
    // Don't await waitForShutdown here — it blocks for the supervisor's lifetime; onApplicationShutdown drains it.
    this.supervisor.start(
      createLifecycleWorker,
      createCollectionWorker,
      createLifecycleSweepQueue(),
      createCollectionSweepQueue(),
      getBullmqConfig().delayedPromoteIntervalSeconds,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    this.supervisor.requestShutdown();
    await this.supervisor.waitForShutdown();
  }

  static forRoot(options: BullmqModuleOptions): DynamicModule {
    const aliasProvider = <T>(privateToken: symbol, callerToken: BullmqDepToken<T>): Provider => ({
      provide: privateToken,
      useFactory: (dep: T) => dep,
      inject: [callerToken],
    });

    const loggerAliasOrContextLogger = <T>(
      privateToken: symbol,
      callerToken: BullmqDepToken<T> | undefined,
    ): Provider => ({
      provide: privateToken,
      useFactory: (dep: T) => dep,
      inject: [callerToken ?? ContextLogger],
    });

    const valueProvider = <T>(token: symbol, value: T): Provider => ({
      provide: token,
      useValue: value,
    });

    const sagaHandlerProvider: Provider = {
      provide: SagaJobHandler,
      useFactory: (
        cache: SagaHandlerCache,
        planManager: SagaPlanManagerLike,
        runner: SagaRunnerLike,
        sagaProvider: SagaDefProvider,
        schemas: SagaPayloadSchemaRegistry,
        config: SagaHandlerConfig,
        cooldownClearer: SagaCooldownClearer,
        logger: SagaHandlerLogger,
      ) => new SagaJobHandler(cache, planManager, runner, sagaProvider, schemas, config, cooldownClearer, logger),
      inject: [
        SAGA_HANDLER_CACHE,
        SAGA_HANDLER_PLAN_MANAGER,
        SAGA_HANDLER_RUNNER,
        SAGA_HANDLER_DEF_PROVIDER,
        SAGA_PAYLOAD_SCHEMA_REGISTRY,
        SAGA_HANDLER_CONFIG,
        SagaCooldownClearerService,
        SAGA_HANDLER_LOGGER,
      ],
    };

    const collectionHandlerProvider: Provider = {
      provide: CollectionJobHandler,
      useFactory: (
        dispatcher: CollectionDispatcherLike,
        registry: CollectionRegistryLike,
        results: CollectionResultsLike,
        cache: CollectionCacheLike,
        cooldown: CollectionCooldownKey,
        logger: CollectionLogger,
      ) => new CollectionJobHandler(dispatcher, registry, results, cache, cooldown, logger),
      inject: [
        COLLECTION_HANDLER_DISPATCHER,
        COLLECTION_HANDLER_REGISTRY,
        COLLECTION_HANDLER_RESULTS,
        COLLECTION_HANDLER_CACHE,
        COLLECTION_HANDLER_COOLDOWN,
        COLLECTION_HANDLER_LOGGER,
      ],
    };

    const diagnosticsHandlerProvider: Provider = {
      provide: DiagnosticsJobHandler,
      useFactory: (
        dispatcher: DiagnosticsDispatcherLike,
        registry: DiagnosticsRegistryLike,
        logger: DiagnosticsLogger,
      ) => new DiagnosticsJobHandler(dispatcher, registry, logger),
      inject: [DIAGNOSTICS_HANDLER_DISPATCHER, DIAGNOSTICS_HANDLER_REGISTRY, DIAGNOSTICS_HANDLER_LOGGER],
    };

    const testingHandlerProvider: Provider = {
      provide: TestingJobHandler,
      useFactory: (dispatcher: TestingDispatcherLike, registry: TestingRegistryLike, logger: TestingLogger) =>
        new TestingJobHandler(dispatcher, registry, logger),
      inject: [TESTING_HANDLER_DISPATCHER, TESTING_HANDLER_REGISTRY, TESTING_HANDLER_LOGGER],
    };

    const sagaCooldownClearerProvider: Provider = {
      provide: SagaCooldownClearerService,
      useFactory: (cache: SagaCooldownCache, autoCollection: AutoCollectionService, logger: ContextLogger) =>
        new SagaCooldownClearerService(cache, autoCollection, logger),
      inject: [SAGA_COOLDOWN_CACHE, AutoCollectionService, SAGA_COOLDOWN_LOGGER],
    };

    const inboundEnvelopeOpenerProvider: Provider = {
      provide: InboundEnvelopeOpenerService,
      useFactory: (
        sealedEnvelope: SealedEnvelopeService,
        zoneCrypto: ZoneCryptoService,
        zoneIdProvider: InboundEnvelopeZoneIdProvider,
        logger: InboundEnvelopeLogger,
      ) =>
        new InboundEnvelopeOpenerService(
          sealedEnvelope,
          zoneCrypto,
          zoneIdProvider,
          logger,
          getBullmqConfig().collectionQueueName,
        ),
      inject: [SealedEnvelopeService, ZoneCryptoService, INBOUND_ENVELOPE_ZONE_ID_PROVIDER, INBOUND_ENVELOPE_LOGGER],
    };

    // Depends on BullmqHandlerRegistrar for boot ordering: its constructor populates the registry before getHandlers().
    const bullmqProcessorProvider: Provider = {
      provide: BullmqProcessorService,
      useFactory: (
        registry: BullmqRegistryService,
        _registrar: BullmqHandlerRegistrar,
        opener: InboundEnvelopeOpener,
        cache: SagaHandlerCache & LockWaitCache,
        planManager: SagaPlanManagerLike,
        notifications: NotificationsService | undefined,
        logger: ContextLogger,
        zoneCrypto: ZoneCryptoService,
      ) => {
        const processor = new BullmqProcessorService(
          registry.getHandlers(),
          opener,
          logger,
          options.processorConfig ?? getBullmqConfig(),
          cache,
          planManager,
          notifications,
          zoneCrypto,
        );
        setBullmqProcessor(processor);
        return processor;
      },
      inject: [
        BullmqRegistryService,
        BullmqHandlerRegistrar,
        InboundEnvelopeOpenerService,
        SAGA_HANDLER_CACHE,
        SAGA_HANDLER_PLAN_MANAGER,
        { token: NotificationsService, optional: true },
        ContextLogger,
        ZoneCryptoService,
      ],
    };

    const loggerProviders: Provider[] = [
      loggerAliasOrContextLogger(SAGA_HANDLER_LOGGER, options.sagaHandlerLoggerToken),
      loggerAliasOrContextLogger(COLLECTION_HANDLER_LOGGER, options.collectionHandlerLoggerToken),
      loggerAliasOrContextLogger(DIAGNOSTICS_HANDLER_LOGGER, options.diagnosticsHandlerLoggerToken),
      loggerAliasOrContextLogger(TESTING_HANDLER_LOGGER, options.testingHandlerLoggerToken),
      loggerAliasOrContextLogger(SAGA_COOLDOWN_LOGGER, options.sagaCooldownClearerLoggerToken),
      loggerAliasOrContextLogger(INBOUND_ENVELOPE_LOGGER, options.inboundEnvelopeOpenerLoggerToken),
    ];

    const providers: Provider[] = [
      BullmqSupervisorService,
      BullmqRegistryService,
      { provide: SAGA_PAYLOAD_SCHEMA_REGISTRY, useValue: productionSagaPayloadSchemaRegistry },
      aliasProvider(SAGA_HANDLER_CACHE, options.sagaHandlerCacheToken),
      aliasProvider(SAGA_HANDLER_PLAN_MANAGER, options.sagaHandlerPlanManagerToken),
      aliasProvider(SAGA_HANDLER_RUNNER, options.sagaHandlerRunnerToken),
      valueProvider(SAGA_HANDLER_DEF_PROVIDER, options.sagaHandlerSagaProvider),
      valueProvider(SAGA_HANDLER_CONFIG, options.sagaHandlerConfig),
      aliasProvider(COLLECTION_HANDLER_DISPATCHER, options.collectionHandlerDispatcherToken),
      aliasProvider(COLLECTION_HANDLER_REGISTRY, options.collectionHandlerRegistryToken),
      aliasProvider(COLLECTION_HANDLER_RESULTS, options.collectionHandlerResultsToken),
      aliasProvider(COLLECTION_HANDLER_CACHE, options.collectionHandlerCacheToken),
      valueProvider(COLLECTION_HANDLER_COOLDOWN, options.collectionHandlerCooldown),
      aliasProvider(DIAGNOSTICS_HANDLER_DISPATCHER, options.diagnosticsHandlerDispatcherToken),
      aliasProvider(DIAGNOSTICS_HANDLER_REGISTRY, options.diagnosticsHandlerRegistryToken),
      aliasProvider(TESTING_HANDLER_DISPATCHER, options.testingHandlerDispatcherToken),
      aliasProvider(TESTING_HANDLER_REGISTRY, options.testingHandlerRegistryToken),
      aliasProvider(SAGA_COOLDOWN_CACHE, options.sagaCooldownClearerCacheToken),
      valueProvider(INBOUND_ENVELOPE_ZONE_ID_PROVIDER, options.inboundEnvelopeOpenerZoneIdProvider),
      ...loggerProviders,
      sagaCooldownClearerProvider,
      sagaHandlerProvider,
      collectionHandlerProvider,
      inboundEnvelopeOpenerProvider,
      diagnosticsHandlerProvider,
      testingHandlerProvider,
      BullmqHandlerRegistrar,
      bullmqProcessorProvider,
    ];
    return {
      module: BullmqModule,
      imports: [ZoneCryptoModule, ...(options.imports ?? [])],
      providers,
      exports: [
        BullmqSupervisorService,
        BullmqRegistryService,
        BullmqProcessorService,
        SAGA_PAYLOAD_SCHEMA_REGISTRY,
        SagaJobHandler,
        CollectionJobHandler,
        DiagnosticsJobHandler,
        TestingJobHandler,
        SagaCooldownClearerService,
        InboundEnvelopeOpenerService,
      ],
    };
  }
}
