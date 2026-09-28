import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi, type Mock } from 'vitest';

import { ConnectionRegistryModule } from '../../agent/connection-registry/connection-registry.module.js';
import { ConnectionRegistry } from '../../agent/connection-registry/connection-registry.service.js';
import { DispatchModule } from '../../agent/dispatch/dispatch.module.js';
import { Dispatcher } from '../../agent/dispatch/dispatcher.service.js';
import { decodeWorkResponse } from '../../agent/dispatch/protobuf-codec.js';
import { AgentServicer } from '../../agent/gateway/agent.servicer.js';
import {
  GrpcStatusCode,
  WorkResponseStatus,
  type ServicerContextLike,
  type WorkResponseRequest,
} from '../../agent/gateway/agent.servicer.types.js';
import { GatewayModule } from '../../agent/gateway/gateway.module.js';
import { dispatchMetaKey, resultKey } from '../../agent/result-publisher/result-publisher.keys.js';
import {
  ResultPublisherModule,
  type ResultPublisherModuleOptions,
} from '../../agent/result-publisher/result-publisher.module.js';
import { ResultPublisherService } from '../../agent/result-publisher/result-publisher.service.js';
import { AgentTokenService } from '../../auth/agent-token.service.js';
import { AuthContextService, bindSubject } from '../../auth/auth-context.service.js';
import { AuthModule } from '../../auth/auth.module.js';
import { AutoCollectionService } from '../../auto-collection/auto-collection.service.js';
import {
  BUFFER_REDIS,
  RedisBufferAdapter,
  type BufferAwareDriverPipeline,
  type BufferAwareRedisDriver,
} from '../../common/redis/redis-buffer-adapter.js';
import { RedisModule } from '../../common/redis/redis.module.js';
import { RedisService } from '../../common/redis/redis.service.js';
import { ContextLogger } from '../../logger/logger.service.js';
import { buildRedisModuleOptions } from '../app-root-providers.js';
import {
  AGENT_UPGRADE_SERVICE,
  BRIDGE_REGISTRY_READER,
  buildDispatchModuleOptions,
  buildGatewayModuleOptions,
  PEER_ANCHOR_RESOLVER,
} from '../grpc-server-factory.js';

const TEXT_ENCODER = new TextEncoder();

interface SetRecord {
  value: string | Buffer;
  exSeconds: number;
}

class InMemoryBufferDriver implements BufferAwareRedisDriver {
  readonly strings = new Map<string, SetRecord>();
  readonly published: Array<{ channel: string; message: string }> = [];

  async set(key: string, value: string | Buffer, exSeconds: number): Promise<unknown> {
    this.strings.set(key, { value, exSeconds });
    return 'OK';
  }

  async get(key: string): Promise<string | Buffer | null> {
    const rec = this.strings.get(key);
    return rec === undefined ? null : rec.value;
  }

  async del(key: string): Promise<number> {
    return this.strings.delete(key) ? 1 : 0;
  }

  async hgetall(): Promise<Record<string, string>> {
    return {};
  }

  pipeline(): BufferAwareDriverPipeline {
    const ops: Array<() => void> = [];
    const pipe: BufferAwareDriverPipeline = {
      set: (key, value, exSeconds) => {
        ops.push(() => this.strings.set(key, { value, exSeconds }));
        return pipe;
      },
      publish: (channel, message) => {
        ops.push(() => this.published.push({ channel, message }));
        return pipe;
      },
      hset: () => {
        return pipe;
      },
      expire: () => {
        return pipe;
      },
      rpush: () => {
        return pipe;
      },
      exec: async () => {
        for (const op of ops) op();
        return [];
      },
    };
    return pipe;
  }

  subscribePubSub(): never {
    throw new Error('pubsub not exercised in this wiring test');
  }

  async close(): Promise<void> {}
}

function makeBufferRedisModule(driver: InMemoryBufferDriver) {
  @Global()
  @Module({
    providers: [{ provide: BUFFER_REDIS, useValue: new RedisBufferAdapter(driver) }],
    exports: [BUFFER_REDIS],
  })
  class FakeBufferRedisModule {}
  return FakeBufferRedisModule;
}

function makeBridgeRegistryReaderModule() {
  @Global()
  @Module({
    providers: [
      {
        provide: BRIDGE_REGISTRY_READER,
        useValue: { getAllBridgeHostnames: async (): Promise<readonly string[]> => [] },
      },
      { provide: PEER_ANCHOR_RESOLVER, useValue: { resolve: async (): Promise<string | null> => null } },
    ],
    exports: [BRIDGE_REGISTRY_READER, PEER_ANCHOR_RESOLVER],
  })
  class FakeBridgeRegistryReaderModule {}
  return FakeBridgeRegistryReaderModule;
}

interface InMemoryAgentTokenCache {
  store: Map<string, string>;
  delete(key: string): Promise<number>;
  secretSet(key: string, value: string): Promise<unknown>;
  secretGet(key: string): Promise<string | null>;
  acquireLock(): Promise<string | null>;
  releaseLock(): Promise<boolean>;
}

function makeInMemoryAgentTokenCache(): InMemoryAgentTokenCache {
  const store = new Map<string, string>();
  return {
    store,
    delete: async (key: string) => (store.delete(key) ? 1 : 0),
    secretSet: async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    },
    secretGet: async (key: string) => store.get(key) ?? null,
    acquireLock: async () => 'lock-token',
    releaseLock: async () => true,
  };
}

function workResponseReq(workId: string): WorkResponseRequest {
  const status = WorkResponseStatus.STATUS_SUCCESS;
  const body = TEXT_ENCODER.encode(`bytes:${workId}:status=${status}`);
  return {
    workId,
    status,
    output: body,
  };
}

function abortContext(): {
  context: ServicerContextLike;
  abort: Mock<(...args: any[]) => any>;
} {
  const abort = vi.fn(async (code: GrpcStatusCode, message: string): Promise<never> => {
    throw new Error(`abort ${code}: ${message}`);
  });
  const context: ServicerContextLike = {
    abort: abort as unknown as ServicerContextLike['abort'],
    peer: () => 'ipv4:127.0.0.1:0',
  };
  return { context, abort };
}

describe('grpc-agent-servicer + Dispatcher wired with real collaborators', () => {
  it('ReportResult routes to the real ResultPublisherService and persists bytes to the buffer driver', async () => {
    const driver = new InMemoryBufferDriver();
    const FakeBufferRedisModule = makeBufferRedisModule(driver);
    const FakeBridgeRegistryReaderModule = makeBridgeRegistryReaderModule();
    const agentTokenCache = makeInMemoryAgentTokenCache();

    const CACHE_TOKEN = Symbol('test-agent-token-cache');
    const authModule = AuthModule.forRoot({ cacheToken: CACHE_TOKEN });
    const resultPublisherModule = ResultPublisherModule.forRoot({
      redisToken: BUFFER_REDIS,
      zonePrefix: '',
    } satisfies ResultPublisherModuleOptions);
    const registryModule = ConnectionRegistryModule.forRoot();

    @Global()
    @Module({
      providers: [
        { provide: CACHE_TOKEN, useValue: agentTokenCache },
        { provide: ContextLogger, useValue: new ContextLogger() },
      ],
      exports: [CACHE_TOKEN, ContextLogger],
    })
    class FakeAgentTokenCacheModule {}

    const FAKE_RESULTS_ADAPTER = Symbol('test-results-adapter');
    const fakeResultsAdapter = {
      enqueuePhoneHome: async () => true,
      writeCollectorToResultsCache: async () => ({ ok: true, kept: 0 }),
    };
    @Global()
    @Module({
      providers: [{ provide: FAKE_RESULTS_ADAPTER, useValue: fakeResultsAdapter }],
      exports: [FAKE_RESULTS_ADAPTER],
    })
    class FakeResultsAdapterModule {}

    const fakeUpgradeService = {
      upgradeAgent: async () => undefined,
    };
    @Global()
    @Module({
      providers: [{ provide: AGENT_UPGRADE_SERVICE, useValue: fakeUpgradeService }],
      exports: [AGENT_UPGRADE_SERVICE],
    })
    class FakeAgentUpgradeServiceModule {}

    const fakeAutoCollection = {
      maybeEnqueueCollectionOnRegister: async () => undefined,
    };
    @Global()
    @Module({
      providers: [{ provide: AutoCollectionService, useValue: fakeAutoCollection }],
      exports: [AutoCollectionService],
    })
    class FakeAutoCollectionModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        FakeBufferRedisModule,
        FakeBridgeRegistryReaderModule,
        FakeAgentTokenCacheModule,
        FakeResultsAdapterModule,
        FakeAgentUpgradeServiceModule,
        FakeAutoCollectionModule,
        registryModule,
        authModule,
        resultPublisherModule,
        GatewayModule.forRoot(
          buildGatewayModuleOptions({
            tokenServiceToken: AgentTokenService,
            authContextServiceToken: AuthContextService,
            connectionRegistryToken: ConnectionRegistry,
            resultPublisherToken: ResultPublisherService,
            bridgeRegistryReaderToken: BRIDGE_REGISTRY_READER,
            peerAnchorResolverToken: PEER_ANCHOR_RESOLVER,
            redisCacheToken: RedisService,
            resultsAdapterToken: FAKE_RESULTS_ADAPTER,
            agentUpgradeServiceToken: AGENT_UPGRADE_SERVICE,
            autoCollectionServiceToken: AutoCollectionService,
            imports: [
              authModule,
              registryModule,
              resultPublisherModule,
              FakeBridgeRegistryReaderModule,
              FakeResultsAdapterModule,
              FakeAgentUpgradeServiceModule,
              FakeAutoCollectionModule,
              RedisModule.forRoot(buildRedisModuleOptions()),
            ],
          }),
        ),
        DispatchModule.forRoot(
          buildDispatchModuleOptions({
            connectionRegistryToken: ConnectionRegistry,
            resultPublisherToken: ResultPublisherService,
            imports: [registryModule, resultPublisherModule],
          }),
        ),
        RedisModule.forRoot(buildRedisModuleOptions()),
      ],
    }).compile();

    const servicer = moduleRef.get(AgentServicer);
    expect(servicer).toBeInstanceOf(AgentServicer);

    const dispatcher = moduleRef.get(Dispatcher);
    expect(dispatcher).toBeInstanceOf(Dispatcher);

    const publisher = moduleRef.get(ResultPublisherService);
    expect(publisher).toBeInstanceOf(ResultPublisherService);

    const servicerDeps = (servicer as unknown as { deps: { upgradeService: unknown } }).deps;
    expect(servicerDeps.upgradeService).toBe(fakeUpgradeService);

    const workId = 'w-roundtrip-1';
    const deviceId = 'device-A';
    await publisher.publishDispatchMeta({
      workId,
      deviceId,
      operation: 'agent.upgrade',
      ttl: 300,
    });
    expect(driver.strings.has(dispatchMetaKey('', workId))).toBe(true);

    const { context } = abortContext();
    const ack = await bindSubject({ kind: 'device', deviceId, issuedAt: Math.floor(Date.now() / 1000) }, async () =>
      servicer.ReportResult(workResponseReq(workId), context),
    );
    expect(ack).toEqual({});

    const stored = driver.strings.get(resultKey('', workId));
    expect(stored).toBeDefined();
    const expectedOutput = TEXT_ENCODER.encode(`bytes:${workId}:status=${WorkResponseStatus.STATUS_SUCCESS}`);
    const storedBytes =
      stored!.value instanceof Buffer
        ? new Uint8Array(stored!.value)
        : new TextEncoder().encode(stored!.value as string);
    const decoded = decodeWorkResponse(storedBytes);
    expect(decoded.workId).toBe(workId);
    expect(decoded.status).toBe(WorkResponseStatus.STATUS_SUCCESS);
    expect(Array.from(decoded.output ?? new Uint8Array())).toEqual(Array.from(expectedOutput));
    expect(driver.published.some((p) => p.message === workId)).toBe(true);

    const metaRec = driver.strings.get(dispatchMetaKey('', workId));
    expect(metaRec).toBeDefined();
    const metaText = metaRec!.value instanceof Buffer ? metaRec!.value.toString('utf-8') : (metaRec!.value as string);
    expect(metaText).toBe(JSON.stringify({ device_id: deviceId, operation: 'agent.upgrade' }));

    await moduleRef.close();
  });
});
