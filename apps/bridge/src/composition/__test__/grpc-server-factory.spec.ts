import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { ConnectionRegistry } from '../../agent/connection-registry/connection-registry.service.js';
import { AgentServicer } from '../../agent/gateway/agent.servicer.js';
import { DeviceAuthInterceptor } from '../../agent/gateway/auth.interceptor.js';
import { GatewayModule } from '../../agent/gateway/gateway.module.js';
import {
  GrpcServerService,
  type GrpcTransportBindArgs,
  type GrpcTransportFactory,
  type GrpcTransportServer,
} from '../../agent/gateway/grpc-server.service.js';
import { ResultPublisherService } from '../../agent/result-publisher/result-publisher.service.js';
import type { BridgeSnapshot } from '../../agent/topology-broadcaster/topology-broadcaster.types.js';
import { AgentTokenService } from '../../auth/agent-token.service.js';
import { AuthContextService } from '../../auth/auth-context.service.js';
import { AutoCollectionService } from '../../auto-collection/auto-collection.service.js';
import { RedisService } from '../../common/redis/redis.service.js';
import {
  adaptBridgeRegistryReader,
  AGENT_UPGRADE_SERVICE,
  BRIDGE_REGISTRY_READER,
  buildAgentServicerDepsFromInjected,
  buildAuthInterceptorDepsFromInjected,
  buildGatewayModuleOptions,
  PEER_ANCHOR_RESOLVER,
  type AgentServicerCollaborators,
} from '../grpc-server-factory.js';

describe('grpc-server-factory wiring', () => {
  it('startServer delegates to the injected transport factory with the configured bindHost/port', async () => {
    const captured: { args: GrpcTransportBindArgs | null; closeCalls: { graceSeconds: number }[] } = {
      args: null,
      closeCalls: [],
    };
    const transportServer: GrpcTransportServer = {
      close: vi.fn().mockImplementation(async (opts: { graceSeconds: number }) => {
        captured.closeCalls.push(opts);
      }),
    };
    const transportFactory: GrpcTransportFactory = {
      startServer: vi.fn().mockImplementation(async (args: GrpcTransportBindArgs) => {
        captured.args = args;
        return transportServer;
      }),
    };

    const fakeCollaborators = {
      registry: {} as AgentServicerCollaborators['registry'],
      publisher: {} as AgentServicerCollaborators['publisher'],
      tokenService: {} as AgentServicerCollaborators['tokenService'],
      authContext: { currentSubject: () => null } as AgentServicerCollaborators['authContext'],
      bridgeRegistryReader: {
        getAllBridgeHostnames: async () => [],
        getBridgeRegistrySnapshot: async () => [],
      } as AgentServicerCollaborators['bridgeRegistryReader'],
      redisCache: {} as AgentServicerCollaborators['redisCache'],
      results: {
        enqueuePhoneHome: async () => true,
        writeCollectorToResultsCache: async () => ({ ok: true, kept: 0 }),
      } as AgentServicerCollaborators['results'],
      upgradeService: {
        upgradeAgent: async () => undefined,
      } as AgentServicerCollaborators['upgradeService'],
      autoCollection: {
        maybeEnqueueCollectionOnRegister: async () => undefined,
      },
      peerAnchorResolver: { resolve: async () => null },
    } satisfies AgentServicerCollaborators;

    const service = new GrpcServerService({
      servicerFactory: {
        build: () => new AgentServicer(buildAgentServicerDepsFromInjected(fakeCollaborators)),
      },
      authInterceptorFactory: {
        build: () => {
          const deps = buildAuthInterceptorDepsFromInjected();
          return new DeviceAuthInterceptor(deps.tokenService, deps.binder, deps.logger);
        },
      },
      transportFactory,
    });

    const handle = await service.startServer({
      internalPort: 50051,
      internalHost: '127.0.0.1',
      jobId: '00000000-0000-0000-0000-000000000000',
    });

    expect(captured.args).not.toBeNull();
    expect(captured.args?.bindHost).toBe('127.0.0.1');
    expect(captured.args?.port).toBe(50051);
    expect(captured.args?.interceptors[0]).toBeInstanceOf(DeviceAuthInterceptor);
    expect(captured.args?.servicer).toBeInstanceOf(AgentServicer);

    await handle.close({ graceSeconds: 5 });
    expect(captured.closeCalls).toEqual([{ graceSeconds: 5 }]);
  });

  it('buildAuthInterceptorDepsFromInjected default token verifier returns null (every RPC aborts UNAUTHENTICATED)', async () => {
    const interceptorDeps = buildAuthInterceptorDepsFromInjected();
    const subject = await interceptorDeps.tokenService.verify('any-bearer-token');
    expect(subject).toBeNull();
  });

  it('adapts bridge registry snapshots without a job id', async () => {
    const getAllBridgeHostnames = vi.fn(async () => ['bridge-a']);
    const getBridgeRegistrySnapshot = vi.fn(
      async (): Promise<BridgeSnapshot> => [['bridge-a', [{ iface: 'eth0', subnet: '10.0.0.0/24', ip: '10.0.0.231' }]]],
    );
    const reader = adaptBridgeRegistryReader({
      getAllBridgeHostnames,
      getBridgeRegistrySnapshot,
    });

    await expect(reader.getBridgeRegistrySnapshot()).resolves.toEqual([
      ['bridge-a', [{ iface: 'eth0', subnet: '10.0.0.0/24', ip: '10.0.0.231' }]],
    ]);
    expect(getBridgeRegistrySnapshot).toHaveBeenCalledWith('');
  });

  it('GatewayModule.forRoot via buildGatewayModuleOptions resolves GrpcServerService from a Nest DI context', async () => {
    const FAKE_RESULTS_ADAPTER = Symbol('FAKE_RESULTS_ADAPTER');
    const fakeTokenService = {
      verify: vi.fn().mockResolvedValue(null),
    };
    const fakeAuthContextService = {
      bind: vi.fn().mockImplementation(async <T>(_s: unknown, fn: () => Promise<T>) => fn()),
      currentSubject: vi.fn().mockReturnValue(null),
    };
    const fakeRegistry = {} as ConnectionRegistry;
    const fakePublisher = {} as ResultPublisherService;
    const fakeReader = {
      getAllBridgeHostnames: vi.fn().mockResolvedValue([]),
      getBridgeRegistrySnapshot: vi.fn().mockResolvedValue([]),
    };
    const fakeRedis = { secretGet: vi.fn().mockResolvedValue(null) } as unknown as RedisService;
    const fakeResultsAdapter = {
      enqueuePhoneHome: vi.fn().mockResolvedValue(true),
      writeCollectorToResultsCache: vi.fn().mockResolvedValue({ ok: true, kept: 0 }),
    };
    const fakeUpgradeService = {
      upgradeAgent: vi.fn().mockResolvedValue(undefined),
    };
    const fakeAutoCollection = {
      maybeEnqueueCollectionOnRegister: vi.fn().mockResolvedValue(undefined),
    };
    @Global()
    @Module({
      providers: [
        { provide: AgentTokenService, useValue: fakeTokenService },
        { provide: AuthContextService, useValue: fakeAuthContextService },
        { provide: ConnectionRegistry, useValue: fakeRegistry },
        { provide: ResultPublisherService, useValue: fakePublisher },
        { provide: BRIDGE_REGISTRY_READER, useValue: fakeReader },
        { provide: RedisService, useValue: fakeRedis },
        { provide: FAKE_RESULTS_ADAPTER, useValue: fakeResultsAdapter },
        { provide: AGENT_UPGRADE_SERVICE, useValue: fakeUpgradeService },
        { provide: AutoCollectionService, useValue: fakeAutoCollection },
        { provide: PEER_ANCHOR_RESOLVER, useValue: { resolve: async () => null } },
      ],
      exports: [
        AgentTokenService,
        AuthContextService,
        ConnectionRegistry,
        ResultPublisherService,
        BRIDGE_REGISTRY_READER,
        RedisService,
        FAKE_RESULTS_ADAPTER,
        AGENT_UPGRADE_SERVICE,
        AutoCollectionService,
        PEER_ANCHOR_RESOLVER,
      ],
    })
    class TestAuthShimModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        TestAuthShimModule,
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
          }),
        ),
      ],
    }).compile();

    const grpcServer = moduleRef.get(GrpcServerService);
    expect(grpcServer).toBeInstanceOf(GrpcServerService);

    const interceptor = moduleRef.get(DeviceAuthInterceptor);
    expect(interceptor).toBeInstanceOf(DeviceAuthInterceptor);

    const servicer = moduleRef.get(AgentServicer);
    expect(servicer).toBeInstanceOf(AgentServicer);

    const servicerDeps = (
      servicer as unknown as {
        deps: {
          upgradeService: unknown;
          maybeEnqueueCollectionOnRegister: (deviceId: string) => Promise<void>;
          buildTopologyUpdateMessage: (args: {
            bridges: readonly unknown[];
            hostsEntries: readonly unknown[];
          }) => unknown;
        };
      }
    ).deps;
    expect(servicerDeps.upgradeService).toBe(fakeUpgradeService);
    expect(
      servicerDeps.buildTopologyUpdateMessage({
        bridges: [{ address: 'bridge-a:443', bridgeId: 'bridge-a' }],
        hostsEntries: [{ ip: '10.0.0.231', hostname: 'bridge-a' }],
      }),
    ).toEqual({
      topologyUpdate: {
        bridges: [{ address: 'bridge-a:443', bridgeId: 'bridge-a' }],
        hostsEntries: [{ ip: '10.0.0.231', hostname: 'bridge-a' }],
      },
    });

    await servicerDeps.maybeEnqueueCollectionOnRegister('device-xyz');
    expect(fakeAutoCollection.maybeEnqueueCollectionOnRegister).toHaveBeenCalledWith('device-xyz');

    await moduleRef.close();
  });
});
