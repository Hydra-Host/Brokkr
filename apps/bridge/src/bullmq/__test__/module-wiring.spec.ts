import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import {
  AUTO_COLLECTION_CACHE,
  AUTO_COLLECTION_ENQUEUE,
  AUTO_COLLECTION_LOGGER,
  AUTO_COLLECTION_READ_ATOM,
  AutoCollectionService,
  type AutoCollectionCache,
  type AutoCollectionLogger,
  type EnqueueCollectionJob,
  type ReadAtom,
} from '../../auto-collection/auto-collection.service';
import { ContextLogger } from '../../logger/logger.service';
import { NotificationsService } from '../../saga-framework/notifications.service';
import { SealedEnvelopeService } from '../../zone-crypto/sealed-envelope.service';
import { ZoneCryptoService } from '../../zone-crypto/zone-crypto.service';
import { BullmqModule, INBOUND_ENVELOPE_ZONE_ID_PROVIDER } from '../bullmq.module';
import { JOB_NAME } from '../bullmq.types';
import type {
  CollectionCacheLike,
  CollectionCooldownKey,
  CollectionDispatcherLike,
  CollectionRegistryLike,
  CollectionResultsLike,
} from '../collection.handler';
import type { DiagnosticsDispatcherLike, DiagnosticsRegistryLike } from '../diagnostics.handler';
import {
  BullmqProcessorService,
  type InboundEnvelopeOpener,
  type LockWaitCache,
  type ProcessableJob,
} from '../handlers.service';
import { InboundEnvelopeOpenerService } from '../inbound-envelope.service';
import { BullmqRegistryService } from '../registry.service';
import { SagaCooldownClearerService } from '../saga-cooldown-clearer.service';
import type {
  SagaDefProvider,
  SagaHandlerCache,
  SagaHandlerConfig,
  SagaPlanManagerLike,
  SagaRunnerLike,
} from '../saga.handler';
import { SagaJobHandler } from '../saga.handler';
import type { TestingDispatcherLike, TestingRegistryLike } from '../testing.handler';

const STUB_TOKENS = {
  sagaCache: Symbol('test:sagaCache'),
  sagaPlanManager: Symbol('test:sagaPlanManager'),
  sagaRunner: Symbol('test:sagaRunner'),
  collDispatcher: Symbol('test:collDispatcher'),
  collRegistry: Symbol('test:collRegistry'),
  collResults: Symbol('test:collResults'),
  collCache: Symbol('test:collCache'),
  diagDispatcher: Symbol('test:diagDispatcher'),
  diagRegistry: Symbol('test:diagRegistry'),
  testDispatcher: Symbol('test:testDispatcher'),
  testRegistry: Symbol('test:testRegistry'),
  cooldownCache: Symbol('test:cooldownCache'),
};

interface StubDepsBundle {
  sagaProvider: SagaDefProvider;
  sagaConfig: SagaHandlerConfig;
  collectionCooldown: CollectionCooldownKey;
  depsModule: typeof StubHandlerDepsModule;
}

const STUB_SAGA_CACHE: SagaHandlerCache & LockWaitCache = {
  acquireLock: async () => 'token-stub',
  releaseLock: async () => true,
  renewLockIfOwner: async () => true,
  readLockInfo: async () => null,
  get: async () => null,
  set: async () => undefined,
  delete: async () => 0,
};
const STUB_SAGA_PLAN: SagaPlanManagerLike = {
  start: async () => {},
  getPlan: async () => ({ exists: true }),
  failPlan: async () => {},
  createPlanFromSaga: async () => ({}),
  backfillOriginalPayload: async () => {},
};
const STUB_SAGA_RUNNER: SagaRunnerLike = {
  execute: async () => ({ plan_id: 'plan-stub', status: 'completed' }),
};
const STUB_COLL_CACHE: CollectionCacheLike = {
  isCollectionInFlight: async () => false,
  markCollectionInFlight: async () => undefined,
} as unknown as CollectionCacheLike;
const STUB_COLL_DISPATCHER: CollectionDispatcherLike = {} as unknown as CollectionDispatcherLike;
const STUB_COLL_REGISTRY: CollectionRegistryLike = {} as unknown as CollectionRegistryLike;
const STUB_COLL_RESULTS: CollectionResultsLike = {} as unknown as CollectionResultsLike;
const STUB_DIAG_DISPATCHER: DiagnosticsDispatcherLike = { dispatchTyped: async () => ({}) };
const STUB_DIAG_REGISTRY: DiagnosticsRegistryLike = { isConnected: () => true };
const STUB_TEST_DISPATCHER: TestingDispatcherLike = { dispatchTyped: async () => ({}) };
const STUB_TEST_REGISTRY: TestingRegistryLike = { isConnected: () => true };
const STUB_COOLDOWN_CACHE = { delete: async () => 1, setNxOwned: async () => true };

@Global()
@Module({
  providers: [
    { provide: STUB_TOKENS.sagaCache, useValue: STUB_SAGA_CACHE },
    { provide: STUB_TOKENS.sagaPlanManager, useValue: STUB_SAGA_PLAN },
    { provide: STUB_TOKENS.sagaRunner, useValue: STUB_SAGA_RUNNER },
    { provide: STUB_TOKENS.collDispatcher, useValue: STUB_COLL_DISPATCHER },
    { provide: STUB_TOKENS.collRegistry, useValue: STUB_COLL_REGISTRY },
    { provide: STUB_TOKENS.collResults, useValue: STUB_COLL_RESULTS },
    { provide: STUB_TOKENS.collCache, useValue: STUB_COLL_CACHE },
    { provide: STUB_TOKENS.diagDispatcher, useValue: STUB_DIAG_DISPATCHER },
    { provide: STUB_TOKENS.diagRegistry, useValue: STUB_DIAG_REGISTRY },
    { provide: STUB_TOKENS.testDispatcher, useValue: STUB_TEST_DISPATCHER },
    { provide: STUB_TOKENS.testRegistry, useValue: STUB_TEST_REGISTRY },
    { provide: STUB_TOKENS.cooldownCache, useValue: STUB_COOLDOWN_CACHE },
    { provide: ContextLogger, useValue: new ContextLogger() },
  ],
  exports: [...Object.values(STUB_TOKENS), ContextLogger],
})
class StubHandlerDepsModule {}

function makeStubOptionsRest(): Omit<StubDepsBundle, 'depsModule'> {
  return {
    sagaProvider: { getSagaDef: () => ({ name: 'stub' }) as never },
    sagaConfig: {
      bullmqQueueName: 'lifecycle',
      deviceLockTimeoutSeconds: 60,
      deviceLockRenewIntervalSeconds: 30,
      lockWaitWarningSeconds: 60,
      lockWaitHardCapSeconds: 0,
    },
    collectionCooldown: ((deviceId: string) => `cooldown:${deviceId}`) as unknown as CollectionCooldownKey,
  };
}

const SILENT_AUTO_COLLECTION_LOGGER: AutoCollectionLogger = {
  debug: async () => {},
  info: async () => {},
  warning: async () => {},
};

@Module({
  providers: [
    AutoCollectionService,
    {
      provide: AUTO_COLLECTION_CACHE,
      useValue: { get: async () => null, set: async () => undefined } as unknown as AutoCollectionCache,
    },
    {
      provide: AUTO_COLLECTION_ENQUEUE,
      useValue: (async () => undefined) as unknown as EnqueueCollectionJob,
    },
    {
      provide: AUTO_COLLECTION_READ_ATOM,
      useValue: (async () => null) as unknown as ReadAtom,
    },
    { provide: AUTO_COLLECTION_LOGGER, useValue: SILENT_AUTO_COLLECTION_LOGGER },
    { provide: NotificationsService, useValue: { notifyStepTransition: async () => undefined } },
    SealedEnvelopeService,
    ZoneCryptoService,
  ],
  exports: [AutoCollectionService, NotificationsService, SealedEnvelopeService, ZoneCryptoService],
})
class WiringTestDepsModule {}

async function compileModule() {
  const rest = makeStubOptionsRest();
  const moduleRef = await Test.createTestingModule({
    imports: [
      StubHandlerDepsModule,
      BullmqModule.forRoot({
        imports: [WiringTestDepsModule],
        sagaHandlerCacheToken: STUB_TOKENS.sagaCache,
        sagaHandlerPlanManagerToken: STUB_TOKENS.sagaPlanManager,
        sagaHandlerRunnerToken: STUB_TOKENS.sagaRunner,
        sagaHandlerSagaProvider: rest.sagaProvider,
        sagaHandlerConfig: rest.sagaConfig,
        processorConfig: {
          lockWaitWarningSeconds: 60,
          lockWaitHardCapSeconds: 0,
          lockLostRedelaySeconds: 90,
        },
        collectionHandlerDispatcherToken: STUB_TOKENS.collDispatcher,
        collectionHandlerRegistryToken: STUB_TOKENS.collRegistry,
        collectionHandlerResultsToken: STUB_TOKENS.collResults,
        collectionHandlerCacheToken: STUB_TOKENS.collCache,
        collectionHandlerCooldown: rest.collectionCooldown,
        diagnosticsHandlerDispatcherToken: STUB_TOKENS.diagDispatcher,
        diagnosticsHandlerRegistryToken: STUB_TOKENS.diagRegistry,
        testingHandlerDispatcherToken: STUB_TOKENS.testDispatcher,
        testingHandlerRegistryToken: STUB_TOKENS.testRegistry,
        sagaCooldownClearerCacheToken: STUB_TOKENS.cooldownCache,
        inboundEnvelopeOpenerZoneIdProvider: { getZoneId: () => 'zone-stub' },
      }),
    ],
  }).compile();
  return moduleRef;
}

describe('BullmqModule.forRoot wiring', () => {
  it('injects NotificationsService into BullmqProcessorService', async () => {
    const moduleRef = await compileModule();
    const processor = moduleRef.get(BullmqProcessorService);
    const notifications = moduleRef.get(NotificationsService);
    expect(Reflect.get(processor, 'notifications')).toBe(notifications);
    await moduleRef.close();
  });

  it('registers all four job handlers in the registry at boot', async () => {
    const moduleRef = await compileModule();
    const registry = moduleRef.get(BullmqRegistryService);

    const handlers = registry.getHandlers();
    expect(Object.keys(handlers).sort()).toEqual(
      [JOB_NAME.COLLECTION_RUN, JOB_NAME.DIAGNOSTICS_RUN, JOB_NAME.SAGA_RUN, JOB_NAME.TESTING_RUN].sort(),
    );
    await moduleRef.close();
  });

  it('resolves BullmqProcessorService with all four handlers populated from the registry', async () => {
    const moduleRef = await compileModule();
    const processor = moduleRef.get(BullmqProcessorService);
    expect(processor).toBeInstanceOf(BullmqProcessorService);

    const opener = moduleRef.get<InboundEnvelopeOpener>(InboundEnvelopeOpenerService);
    expect(opener).toBeDefined();

    for (const name of [JOB_NAME.SAGA_RUN, JOB_NAME.COLLECTION_RUN, JOB_NAME.DIAGNOSTICS_RUN, JOB_NAME.TESTING_RUN]) {
      const job: ProcessableJob<Record<string, unknown>> = {
        id: `job-${name}`,
        name,
        data: {},
        queue: { name: 'lifecycle', opts: {} },
        scripts: { moveToDelayed: async () => undefined },
      };
      await expect(processor.process(job, 'token')).rejects.toThrow();
      await expect(processor.process(job, 'token')).rejects.not.toThrow(/No handler registered/);
    }
    await moduleRef.close();
  });

  it('routes a saga.run job through the wired stub handler', async () => {
    const moduleRef = await compileModule();
    const processor = moduleRef.get(BullmqProcessorService);

    const job: ProcessableJob<Record<string, unknown>> = {
      id: 'job-saga-1',
      name: JOB_NAME.SAGA_RUN,
      data: {
        plan_id: 'plan-stub',
        saga_name: 'stub',
        payload: { device_id: 'dev-stub' },
      },
      queue: { name: 'lifecycle', opts: {} },
      scripts: { moveToDelayed: async () => undefined },
    };
    const result = await processor.process(job, 'token');
    expect(result).toMatchObject({ plan_id: 'plan-stub', status: 'completed' });
    await moduleRef.close();
  });

  it('overriding the zone-id provider via deps wins over the default getZoneId fallback', async () => {
    const moduleRef = await compileModule();
    const opener = moduleRef.get<InboundEnvelopeOpener>(InboundEnvelopeOpenerService);
    expect(opener).toBeDefined();
    const zoneIdProvider = moduleRef.get<{ getZoneId: () => string }>(INBOUND_ENVELOPE_ZONE_ID_PROVIDER);
    expect(zoneIdProvider.getZoneId()).toBe('zone-stub');
    await moduleRef.close();
  });
});

class MockSagaCacheImpl {
  acquired: string[] = [];
  async get(_key: string, _jobId?: string): Promise<string | null> {
    return null;
  }
  async set(_key: string, _value: string, _ttl?: number, _jobId?: string): Promise<void> {}
  async delete(_key: string, _jobId?: string): Promise<number> {
    return 0;
  }
  async acquireLock(lockKey: string, _timeout: number, _jobId?: string): Promise<string | null> {
    this.acquired.push(lockKey);
    return 'mock-token';
  }
  async releaseLock(_lockKey: string, _token: string, _jobId?: string): Promise<boolean> {
    return true;
  }
  async renewLockIfOwner(_lockKey: string, _expectedValue: string, _ttl: number, _jobId?: string): Promise<boolean> {
    return true;
  }
  async readLockInfo(_lockKey: string, _jobId?: string): Promise<Record<string, string> | null> {
    return null;
  }
}

class MockCollectionCacheImpl {
  deleted: string[] = [];
  async exists(_key: string, _jobId?: string | null): Promise<boolean> {
    return false;
  }
  async delete(key: string, _jobId?: string | null): Promise<number> {
    this.deleted.push(key);
    return 1;
  }
  async setNxOwned(_key: string, _value: string, _ttl: number, _jobId?: string | null): Promise<boolean> {
    return true;
  }
}

const MOCK_SAGA_CACHE_TOKEN = Symbol('MOCK_SAGA_CACHE_TOKEN');
const MOCK_COLLECTION_CACHE_TOKEN = Symbol('MOCK_COLLECTION_CACHE_TOKEN');

@Global()
@Module({
  providers: [
    MockSagaCacheImpl,
    { provide: MOCK_SAGA_CACHE_TOKEN, useExisting: MockSagaCacheImpl },
    MockCollectionCacheImpl,
    { provide: MOCK_COLLECTION_CACHE_TOKEN, useExisting: MockCollectionCacheImpl },
  ],
  exports: [MockSagaCacheImpl, MOCK_SAGA_CACHE_TOKEN, MockCollectionCacheImpl, MOCK_COLLECTION_CACHE_TOKEN],
})
class MockCacheProvidersModule {}

async function compileModuleWithMockCaches() {
  const rest = makeStubOptionsRest();
  const moduleRef = await Test.createTestingModule({
    imports: [
      MockCacheProvidersModule,
      StubHandlerDepsModule,
      BullmqModule.forRoot({
        imports: [WiringTestDepsModule],
        sagaHandlerCacheToken: MockSagaCacheImpl,
        collectionHandlerCacheToken: MOCK_COLLECTION_CACHE_TOKEN,
        sagaCooldownClearerCacheToken: MOCK_COLLECTION_CACHE_TOKEN,
        sagaHandlerPlanManagerToken: STUB_TOKENS.sagaPlanManager,
        sagaHandlerRunnerToken: STUB_TOKENS.sagaRunner,
        sagaHandlerSagaProvider: rest.sagaProvider,
        sagaHandlerConfig: rest.sagaConfig,
        processorConfig: {
          lockWaitWarningSeconds: 60,
          lockWaitHardCapSeconds: 0,
          lockLostRedelaySeconds: 90,
        },
        collectionHandlerDispatcherToken: STUB_TOKENS.collDispatcher,
        collectionHandlerRegistryToken: STUB_TOKENS.collRegistry,
        collectionHandlerResultsToken: STUB_TOKENS.collResults,
        collectionHandlerCooldown: rest.collectionCooldown,
        diagnosticsHandlerDispatcherToken: STUB_TOKENS.diagDispatcher,
        diagnosticsHandlerRegistryToken: STUB_TOKENS.diagRegistry,
        testingHandlerDispatcherToken: STUB_TOKENS.testDispatcher,
        testingHandlerRegistryToken: STUB_TOKENS.testRegistry,
        inboundEnvelopeOpenerZoneIdProvider: { getZoneId: () => 'zone-stub' },
      }),
    ],
  }).compile();
  return moduleRef;
}

describe('BullmqModule.forRoot DI-aware token refactor', () => {
  it('resolves the `sagaHandlerCacheToken` class symbol to the DI-provided instance', async () => {
    const moduleRef = await compileModuleWithMockCaches();
    try {
      const directCache = moduleRef.get(MockSagaCacheImpl);
      const saga = moduleRef.get(SagaJobHandler);
      expect(directCache).toBeInstanceOf(MockSagaCacheImpl);
      const handlerCache = (saga as unknown as { cache: MockSagaCacheImpl }).cache;
      expect(handlerCache).toBe(directCache);
    } finally {
      await moduleRef.close();
    }
  });

  it('saga handler call into `acquireLock` reaches the DI-resolved mock instance', async () => {
    const moduleRef = await compileModuleWithMockCaches();
    try {
      const directCache = moduleRef.get(MockSagaCacheImpl);
      const processor = moduleRef.get(BullmqProcessorService);

      const job: ProcessableJob<Record<string, unknown>> = {
        id: 'job-mock-1',
        name: JOB_NAME.SAGA_RUN,
        data: {
          plan_id: 'plan-mock-1',
          saga_name: 'stub',
          payload: { device_id: 'dev-mock-1' },
        },
        queue: { name: 'lifecycle', opts: {} },
        scripts: { moveToDelayed: async () => undefined },
      };
      const result = await processor.process(job, 'token');
      expect(result).toMatchObject({ status: 'completed' });
      expect(directCache.acquired.length).toBe(1);
      expect(directCache.acquired[0]).toContain('dev-mock-1');
    } finally {
      await moduleRef.close();
    }
  });

  it('saga cooldown clearer cache slot is the DI-resolved instance shared with collectionHandler.cache', async () => {
    const moduleRef = await compileModuleWithMockCaches();
    try {
      const directCache = moduleRef.get(MockCollectionCacheImpl);
      const cooldownClearer = moduleRef.get(SagaCooldownClearerService);
      expect((cooldownClearer as unknown as { cache: MockCollectionCacheImpl }).cache).toBe(directCache);
    } finally {
      await moduleRef.close();
    }
  });
});
