import { createHash } from 'node:crypto';

import { describe, expect, it, vi, type Mock } from 'vitest';

import type { AuthSubject, DeviceSubject, DiscoverySubject } from '../../../auth/agent-token.service';
import { NIL_DEVICE_ID } from '../../../constants';
import { ConnectionRegistry } from '../../connection-registry/connection-registry.service';
import { buildEndpoints } from '../../topology-broadcaster/topology-broadcaster.service';
import type { BridgeSnapshot } from '../../topology-broadcaster/topology-broadcaster.types';
import { AgentServicer, classifyCollectorPartial } from '../agent.servicer';
import {
  BundleArtifact,
  GrpcStatusCode,
  PartialResultStatus,
  Readiness,
  WorkResponseStatus,
  type AgentRegistrationRequest,
  type AgentServicerDeps,
  type BundleRequestMsg,
  type LogBatchRequest,
  type LogEntryRequest,
  type PartialResultRequest,
  type PhoneHomeRequestMsg,
  type ResultPublisherPort,
  type ServicerContextLike,
  type WorkProgressRequest,
  type WorkResponseRequest,
} from '../agent.servicer.types';

class AbortError extends Error {
  constructor(
    public readonly code: GrpcStatusCode,
    message: string,
  ) {
    super(message);
    this.name = 'AbortError';
  }
}

function abortContext(): {
  context: ServicerContextLike;
  abort: Mock<(...args: any[]) => any>;
} {
  const abort = vi.fn(async (code: GrpcStatusCode, message: string): Promise<never> => {
    throw new AbortError(code, message);
  });
  const context: ServicerContextLike = {
    abort: abort as unknown as ServicerContextLike['abort'],
    peer: () => 'ipv4:127.0.0.1:0',
  };
  return { context, abort };
}

class StubAuthContext {
  subject: AuthSubject | null = null;
  currentSubject(): AuthSubject | null {
    return this.subject;
  }
}

function fakeSerializeable(workId: string): { serializeToString: () => Uint8Array } {
  return { serializeToString: () => new TextEncoder().encode(`bytes:${workId}`) };
}

function workResponseReq(args: { workId: string; status?: number }): WorkResponseRequest {
  return {
    workId: args.workId,
    status: args.status ?? WorkResponseStatus.STATUS_SUCCESS,
    output: fakeSerializeable(args.workId).serializeToString(),
  };
}

function workProgressReq(workId: string, progress = 0.5, message = 'halfway'): WorkProgressRequest {
  return { workId, progress, message };
}

function partialResultReq(args: {
  workId: string;
  unit?: string;
  status?: number;
  data?: string;
}): PartialResultRequest {
  return {
    workId: args.workId,
    unit: args.unit ?? 'cpu',
    status: args.status ?? PartialResultStatus.STATUS_SUCCESS,
    data: args.data ?? '',
  };
}

function logBatchReq(deviceId: string, entries: LogEntryRequest[] = []): LogBatchRequest {
  return { deviceId, entries };
}

function bundleReq(sha256: string, artifact: number = BundleArtifact.ARTIFACT_BUNDLE): BundleRequestMsg {
  return { sha256, artifact };
}

interface DepsOverrides {
  authContext?: StubAuthContext;
  publisher?: AgentServicerDeps['publisher'];
  tokenService?: AgentServicerDeps['tokenService'];
  logger?: AgentServicerDeps['logger'];
  readFile?: AgentServicerDeps['readFile'];
  bundleConfig?: AgentServicerDeps['bundleConfig'];
  redisCache?: AgentServicerDeps['redisCache'];
  results?: AgentServicerDeps['results'];
  bridgeRegistryReader?: AgentServicerDeps['bridgeRegistryReader'];
  registry?: AgentServicerDeps['registry'];
  agentVersionConfig?: AgentServicerDeps['agentVersionConfig'];
  upgradeService?: AgentServicerDeps['upgradeService'];
  maybeEnqueueCollectionOnRegister?: AgentServicerDeps['maybeEnqueueCollectionOnRegister'];
  buildSessionAcceptedMessage?: AgentServicerDeps['buildSessionAcceptedMessage'];
  buildTopologyUpdateMessage?: AgentServicerDeps['buildTopologyUpdateMessage'];
  buildEndpoints?: AgentServicerDeps['buildEndpoints'];
  buildBundleChunk?: AgentServicerDeps['buildBundleChunk'];
  grpcConfig?: AgentServicerDeps['grpcConfig'];
  leaderConfig?: AgentServicerDeps['leaderConfig'];
  traceRelay?: AgentServicerDeps['traceRelay'];
}

function buildServicer(overrides: DepsOverrides = {}): {
  servicer: AgentServicer;
  authContext: StubAuthContext;
  publisher: MockedPublisher;
  logger: {
    warning: Mock<(...args: any[]) => any>;
    info: Mock<(...args: any[]) => any>;
    debug: Mock<(...args: any[]) => any>;
    error: Mock<(...args: any[]) => any>;
  };
  traceRelay: {
    isEnabled: Mock<() => boolean>;
    forward: Mock<(otlpTraces: Uint8Array) => Promise<void>>;
  };
} {
  const authContext = overrides.authContext ?? new StubAuthContext();
  const publisher: MockedPublisher = (overrides.publisher as MockedPublisher | undefined) ?? makePublisher();
  const logger = {
    warning: vi.fn(async () => undefined),
    info: vi.fn(async () => undefined),
    debug: vi.fn(async () => undefined),
    error: vi.fn(async () => undefined),
  };
  const traceRelay = {
    isEnabled: vi.fn(() => true),
    forward: vi.fn(async (_otlpTraces: Uint8Array) => undefined),
  };
  const deps: AgentServicerDeps = {
    registry: overrides.registry ?? {
      register: vi.fn(async () => {
        throw new Error('registry.register not stubbed');
      }) as unknown as AgentServicerDeps['registry']['register'],
      unregister: vi.fn(async () => undefined),
    },
    publisher,
    tokenService: overrides.tokenService ?? {
      slideDeviceTtl: vi.fn(async () => true),
      deviceTtlS: 3600,
    },
    upgradeService: overrides.upgradeService ?? { upgradeAgent: vi.fn(async () => undefined) },
    authContext,
    bridgeRegistryReader: overrides.bridgeRegistryReader ?? {
      getAllBridgeHostnames: vi.fn(async () => []),
      getBridgeRegistrySnapshot: vi.fn(async () => []),
    },
    buildEndpoints: overrides.buildEndpoints ?? (() => []),
    maybeEnqueueCollectionOnRegister: overrides.maybeEnqueueCollectionOnRegister ?? (async () => undefined),
    results: overrides.results ?? {
      enqueuePhoneHome: vi.fn(async () => true),
      writeCollectorToResultsCache: vi.fn(async () => ({ ok: true, kept: 1 })),
    },
    agentVersionConfig: overrides.agentVersionConfig ?? { expectedAgentVersion: '2.5.0' },
    grpcConfig: overrides.grpcConfig ?? { externalPort: 443 },
    leaderConfig: overrides.leaderConfig ?? { instanceId: 'bridge-test' },
    bundleConfig: overrides.bundleConfig ?? { bundlePath: '/nonexistent/main.js', unitPath: '/nonexistent/unit' },
    redisCache: overrides.redisCache ?? { secretGet: vi.fn(async () => null) },
    readFile:
      overrides.readFile ??
      (async () => {
        const err = new Error('ENOENT') as Error & { code?: string };
        err.code = 'ENOENT';
        throw err;
      }),
    logger,
    traceRelay: overrides.traceRelay ?? traceRelay,
    buildSessionAcceptedMessage: overrides.buildSessionAcceptedMessage ?? (() => ({ sessionAccepted: {} })),
    buildTopologyUpdateMessage: overrides.buildTopologyUpdateMessage ?? ((args) => ({ topologyUpdate: args })),
    buildBundleChunk: overrides.buildBundleChunk ?? (({ data }) => ({ data })),
  };
  const servicer = new AgentServicer(deps);
  return { servicer, authContext, publisher, logger, traceRelay };
}

type MockedPublisher = {
  [K in keyof ResultPublisherPort]: Mock<(...args: any[]) => any>;
};

function makePublisher(meta: Record<string, Record<string, unknown> | null> = {}): MockedPublisher {
  const metaMap = new Map<string, Record<string, unknown> | null>(Object.entries(meta));
  return {
    getDispatchMeta: vi.fn(async (workId: string) => metaMap.get(workId) ?? null),
    publishResult: vi.fn(async () => undefined),
    publishProgress: vi.fn(async () => undefined),
    publishPartial: vi.fn(async () => undefined),
  };
}

function dev(id: string): DeviceSubject {
  return { kind: 'device', deviceId: id, issuedAt: 1 };
}

function discovery(id = 'aa:bb'): DiscoverySubject {
  return { kind: 'discovery', discoveryId: id, issuedAt: 1, expiresAt: 2 };
}

function regReq(args: Partial<AgentRegistrationRequest> = {}): AgentRegistrationRequest {
  return {
    protocolVersion: 1,
    deviceId: args.deviceId ?? 'dev-1',
    agentVersion: args.agentVersion ?? '1.0.0',
    readiness: args.readiness ?? Readiness.READINESS_READY,
  };
}

async function drainSession(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const m of stream) out.push(m);
  return out;
}

describe('AgentServicer.OpenSession — auth-subject enforcement', () => {
  it('rejects device_id mismatch with PERMISSION_DENIED (CLAIMED + AUTHED in msg)', async () => {
    const { servicer, authContext } = buildServicer();
    authContext.subject = dev('AUTHED');
    const { context, abort } = abortContext();
    const stream = servicer.OpenSession(regReq({ deviceId: 'CLAIMED' }), context);
    await expect(drainSession(stream)).rejects.toBeInstanceOf(AbortError);
    expect(abort).toHaveBeenCalledOnce();
    expect(abort.mock.calls[0][0]).toBe(GrpcStatusCode.PERMISSION_DENIED);
    expect(abort.mock.calls[0][1]).toMatch(/CLAIMED.*AUTHED/);
  });

  it('rejects discovery token registering as non-nil device_id', async () => {
    const { servicer, authContext } = buildServicer();
    authContext.subject = discovery();
    const { context, abort } = abortContext();
    const stream = servicer.OpenSession(regReq({ deviceId: 'whatever' }), context);
    await expect(drainSession(stream)).rejects.toBeInstanceOf(AbortError);
    expect(abort.mock.calls[0][0]).toBe(GrpcStatusCode.PERMISSION_DENIED);
    expect(abort.mock.calls[0][1]).toContain('discovery tokens may only register as the nil UUID');
    expect(abort.mock.calls[0][1]).toContain('whatever');
  });

  it('rejects when no subject is bound', async () => {
    const { servicer } = buildServicer();
    const { context, abort } = abortContext();
    const stream = servicer.OpenSession(regReq({ deviceId: 'dev-1' }), context);
    await expect(drainSession(stream)).rejects.toBeInstanceOf(AbortError);
    expect(abort.mock.calls[0][0]).toBe(GrpcStatusCode.PERMISSION_DENIED);
  });
});

describe('AgentServicer.OpenSession — initial topology', () => {
  it('uses one registry snapshot for SessionAccepted and a subnet-matched TopologyUpdate', async () => {
    const registry = new ConnectionRegistry();
    const getAllBridgeHostnames = vi.fn(async () => ['unstable-bridge']);
    const getBridgeRegistrySnapshot = vi.fn(
      async (): Promise<BridgeSnapshot> => [
        ['bridge-a', [{ iface: 'eth0', subnet: '10.0.0.0/24', ip: '10.0.0.231' }]],
        ['bridge-b', [{ iface: 'eth0', subnet: '10.0.0.0/24', ip: '10.0.0.232' }]],
      ],
    );
    const { servicer, authContext } = buildServicer({
      registry: registry as unknown as AgentServicerDeps['registry'],
      bridgeRegistryReader: { getAllBridgeHostnames, getBridgeRegistrySnapshot },
      buildEndpoints,
      buildSessionAcceptedMessage: (args) => ({ sessionAccepted: args }),
    });
    authContext.subject = dev('dev-1');
    const { context } = abortContext();
    context.metadata = (key) => (key === 'x-real-ip' ? ['10.0.0.5'] : []);

    const iterator = servicer.OpenSession(regReq(), context)[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({
      value: {
        sessionAccepted: {
          bridgeId: 'bridge-test',
          topology: [
            { address: 'bridge-a:443', bridgeId: 'bridge-a' },
            { address: 'bridge-b:443', bridgeId: 'bridge-b' },
          ],
          agentVersion: '2.5.0',
        },
      },
      done: false,
    });
    expect(await iterator.next()).toEqual({
      value: {
        topologyUpdate: {
          bridges: [
            { address: 'bridge-a:443', bridgeId: 'bridge-a' },
            { address: 'bridge-b:443', bridgeId: 'bridge-b' },
          ],
          hostsEntries: [
            { ip: '10.0.0.231', hostname: 'bridge-a' },
            { ip: '10.0.0.232', hostname: 'bridge-b' },
          ],
        },
      },
      done: false,
    });
    expect(getBridgeRegistrySnapshot).toHaveBeenCalledOnce();
    expect(getAllBridgeHostnames).not.toHaveBeenCalled();

    await iterator.return?.();
  });

  it('sends a TopologyUpdate without host rows when no bridge subnet matches', async () => {
    const registry = new ConnectionRegistry();
    const { servicer, authContext } = buildServicer({
      registry: registry as unknown as AgentServicerDeps['registry'],
      bridgeRegistryReader: {
        getAllBridgeHostnames: vi.fn(async () => []),
        getBridgeRegistrySnapshot: vi.fn(
          async (): Promise<BridgeSnapshot> => [
            ['bridge-a', [{ iface: 'eth0', subnet: '192.168.1.0/24', ip: '192.168.1.231' }]],
          ],
        ),
      },
      buildEndpoints,
    });
    authContext.subject = dev('dev-1');
    const { context } = abortContext();
    context.metadata = (key) => (key === 'x-forwarded-for' ? ['invalid, 10.0.0.5'] : []);

    const iterator = servicer.OpenSession(regReq(), context)[Symbol.asyncIterator]();
    await iterator.next();
    expect(await iterator.next()).toEqual({
      value: {
        topologyUpdate: {
          bridges: [{ address: 'bridge-a:443', bridgeId: 'bridge-a' }],
          hostsEntries: [],
        },
      },
      done: false,
    });

    await iterator.return?.();
  });
});

describe('AgentServicer.OpenSession — transport cancel reaps the session', () => {
  it('unregisters when the call is cancelled while the stream is parked', async () => {
    const registry = new ConnectionRegistry();
    const { servicer, authContext } = buildServicer({
      registry: registry as unknown as AgentServicerDeps['registry'],
    });
    authContext.subject = dev('dev-1');

    let cancelCb: (() => void) | undefined;
    const context: ServicerContextLike = {
      abort: (async () => {
        throw new Error('unexpected abort');
      }) as ServicerContextLike['abort'],
      peer: () => 'ipv4:127.0.0.1:0',
      onCancelled: (cb) => {
        cancelCb = cb;
      },
    };

    const iterator = servicer.OpenSession(regReq({ deviceId: 'dev-1' }), context)[Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(registry.isConnected('dev-1')).toBe(true);
    expect(cancelCb).toBeDefined();

    const topology = await iterator.next();
    expect(topology.done).toBe(false);

    const parked = iterator.next();
    cancelCb!();
    const after = await parked;

    expect(after.done).toBe(true);
    expect(registry.isConnected('dev-1')).toBe(false);
  });
});

describe('AgentServicer.ReportResult — auth + work_id ownership', () => {
  it('rejects discovery subject with "device-kind token required"', async () => {
    const { servicer, authContext } = buildServicer();
    authContext.subject = discovery();
    const { context, abort } = abortContext();
    await expect(servicer.ReportResult(workResponseReq({ workId: 'w-1' }), context)).rejects.toBeInstanceOf(AbortError);
    expect(abort.mock.calls[0][0]).toBe(GrpcStatusCode.PERMISSION_DENIED);
    expect(abort.mock.calls[0][1]).toContain('device-kind token required');
  });

  it('rejects when no subject is bound', async () => {
    const { servicer } = buildServicer();
    const { context, abort } = abortContext();
    await expect(servicer.ReportResult(workResponseReq({ workId: 'w-1' }), context)).rejects.toBeInstanceOf(AbortError);
    expect(abort.mock.calls[0][0]).toBe(GrpcStatusCode.PERMISSION_DENIED);
  });

  it('accepts a valid device subject and publishes the result', async () => {
    const publisher = makePublisher({
      'w-1': { device_id: 'dev-ok', operation: 'agent.upgrade' },
    });
    const { servicer, authContext } = buildServicer({ publisher });
    authContext.subject = dev('dev-ok');
    const { context, abort } = abortContext();
    const ack = await servicer.ReportResult(workResponseReq({ workId: 'w-1' }), context);
    expect(ack).toEqual({});
    expect(abort).not.toHaveBeenCalled();
    expect(publisher.publishResult).toHaveBeenCalledOnce();
  });

  it('rejects when work_id was dispatched to a different device (F-11)', async () => {
    const publisher = makePublisher({
      'w-1': { device_id: 'device-B', operation: 'agent.upgrade' },
    });
    const { servicer, authContext } = buildServicer({ publisher });
    authContext.subject = dev('device-A');
    const { context, abort } = abortContext();
    await expect(servicer.ReportResult(workResponseReq({ workId: 'w-1' }), context)).rejects.toBeInstanceOf(AbortError);
    expect(abort.mock.calls[0][0]).toBe(GrpcStatusCode.PERMISSION_DENIED);
    expect(publisher.publishResult).not.toHaveBeenCalled();
  });

  it('rejects when dispatch meta carries a present non-scalar object device_id (fail-closed)', async () => {
    const publisher = makePublisher({
      'w-1': { device_id: { x: 1 }, operation: 'agent.upgrade' },
    });
    const { servicer, authContext } = buildServicer({ publisher });
    authContext.subject = dev('device-A');
    const { context, abort } = abortContext();
    await expect(servicer.ReportResult(workResponseReq({ workId: 'w-1' }), context)).rejects.toBeInstanceOf(AbortError);
    expect(abort.mock.calls[0][0]).toBe(GrpcStatusCode.PERMISSION_DENIED);
    expect(publisher.publishResult).not.toHaveBeenCalled();
  });

  it('rejects when dispatch meta carries a present non-scalar array device_id (fail-closed)', async () => {
    const publisher = makePublisher({
      'w-1': { device_id: ['x'], operation: 'agent.upgrade' },
    });
    const { servicer, authContext } = buildServicer({ publisher });
    authContext.subject = dev('device-A');
    const { context, abort } = abortContext();
    await expect(servicer.ReportResult(workResponseReq({ workId: 'w-1' }), context)).rejects.toBeInstanceOf(AbortError);
    expect(abort.mock.calls[0][0]).toBe(GrpcStatusCode.PERMISSION_DENIED);
    expect(publisher.publishResult).not.toHaveBeenCalled();
  });

  it('accepts when dispatch meta device_id is an empty object/array (python-falsy, no abort)', async () => {
    for (const emptyId of [{}, []] as unknown[]) {
      const publisher = makePublisher({
        'w-1': { device_id: emptyId, operation: 'agent.upgrade' },
      });
      const { servicer, authContext } = buildServicer({ publisher });
      authContext.subject = dev('device-A');
      const { context, abort } = abortContext();
      const ack = await servicer.ReportResult(workResponseReq({ workId: 'w-1' }), context);
      expect(ack).toEqual({});
      expect(abort).not.toHaveBeenCalled();
      expect(publisher.publishResult).toHaveBeenCalledOnce();
    }
  });

  it('rejects when dispatch meta is missing (F-1 fail-closed)', async () => {
    const publisher = makePublisher();
    const { servicer, authContext } = buildServicer({ publisher });
    authContext.subject = dev('device-A');
    const { context, abort } = abortContext();
    await expect(servicer.ReportResult(workResponseReq({ workId: 'w-no-meta' }), context)).rejects.toBeInstanceOf(
      AbortError,
    );
    expect(abort.mock.calls[0][0]).toBe(GrpcStatusCode.PERMISSION_DENIED);
    expect(publisher.publishResult).not.toHaveBeenCalled();
  });

  it('skips persistence for STATUS_ALREADY_IN_PROGRESS', async () => {
    const publisher = makePublisher({
      'w-aip': { device_id: 'dev-aip', operation: 'agent.upgrade' },
    });
    const { servicer, authContext } = buildServicer({ publisher });
    authContext.subject = dev('dev-aip');
    const { context, abort } = abortContext();
    const ack = await servicer.ReportResult(
      workResponseReq({ workId: 'w-aip', status: WorkResponseStatus.STATUS_ALREADY_IN_PROGRESS }),
      context,
    );
    expect(ack).toEqual({});
    expect(abort).not.toHaveBeenCalled();
    expect(publisher.publishResult).not.toHaveBeenCalled();
  });
});

describe('AgentServicer.ReportProgress — auth + ownership + best-effort persistence', () => {
  it('rejects discovery subject', async () => {
    const { servicer, authContext } = buildServicer();
    authContext.subject = discovery();
    const { context, abort } = abortContext();
    await expect(servicer.ReportProgress(workProgressReq('w-1'), context)).rejects.toBeInstanceOf(AbortError);
    expect(abort.mock.calls[0][0]).toBe(GrpcStatusCode.PERMISSION_DENIED);
  });

  it('rejects when no subject is bound', async () => {
    const { servicer } = buildServicer();
    const { context, abort } = abortContext();
    await expect(servicer.ReportProgress(workProgressReq('w-1'), context)).rejects.toBeInstanceOf(AbortError);
    expect(abort.mock.calls[0][0]).toBe(GrpcStatusCode.PERMISSION_DENIED);
  });

  it('accepts device subject', async () => {
    const publisher = makePublisher({
      'w-1': { device_id: 'dev-ok', operation: 'agent.upgrade' },
    });
    const { servicer, authContext } = buildServicer({ publisher });
    authContext.subject = dev('dev-ok');
    const { context, abort } = abortContext();
    const ack = await servicer.ReportProgress(workProgressReq('w-1'), context);
    expect(ack).toEqual({});
    expect(abort).not.toHaveBeenCalled();
    expect(publisher.publishProgress).toHaveBeenCalledOnce();
  });

  it('returns ack even when persistence raises (progress is best-effort)', async () => {
    const publisher = makePublisher({
      'w-prog': { device_id: 'dev-prog', operation: 'agent.upgrade' },
    });
    publisher.publishProgress = vi.fn(async () => {
      throw new Error('redis down');
    });
    const { servicer, authContext } = buildServicer({ publisher });
    authContext.subject = dev('dev-prog');
    const { context, abort } = abortContext();
    const ack = await servicer.ReportProgress(workProgressReq('w-prog'), context);
    expect(ack).toEqual({});
    expect(abort).not.toHaveBeenCalled();
  });

  it('rejects cross-device work_id', async () => {
    const publisher = makePublisher({
      'w-progress-B': { device_id: 'device-B', operation: 'benchmark.gpuBurn' },
    });
    const { servicer, authContext } = buildServicer({ publisher });
    authContext.subject = dev('device-A');
    const { context, abort } = abortContext();
    await expect(servicer.ReportProgress(workProgressReq('w-progress-B'), context)).rejects.toBeInstanceOf(AbortError);
    expect(abort.mock.calls[0][0]).toBe(GrpcStatusCode.PERMISSION_DENIED);
  });
});

describe('AgentServicer.ReportPartialResult — auth + ownership + persistence', () => {
  it('rejects discovery subject', async () => {
    const { servicer, authContext } = buildServicer();
    authContext.subject = discovery();
    const { context, abort } = abortContext();
    await expect(servicer.ReportPartialResult(partialResultReq({ workId: 'w-1' }), context)).rejects.toBeInstanceOf(
      AbortError,
    );
    expect(abort.mock.calls[0][0]).toBe(GrpcStatusCode.PERMISSION_DENIED);
  });

  it('rejects when no subject is bound', async () => {
    const { servicer } = buildServicer();
    const { context, abort } = abortContext();
    await expect(servicer.ReportPartialResult(partialResultReq({ workId: 'w-1' }), context)).rejects.toBeInstanceOf(
      AbortError,
    );
    expect(abort.mock.calls[0][0]).toBe(GrpcStatusCode.PERMISSION_DENIED);
  });

  it('accepts a valid device subject and publishes the partial', async () => {
    const publisher = makePublisher({
      'w-1': { device_id: 'dev-ok', operation: 'agent.upgrade' },
    });
    const { servicer, authContext } = buildServicer({ publisher });
    authContext.subject = dev('dev-ok');
    const { context, abort } = abortContext();
    const ack = await servicer.ReportPartialResult(
      partialResultReq({ workId: 'w-1', unit: 'arch', data: '{"k":"v"}' }),
      context,
    );
    expect(ack).toEqual({});
    expect(abort).not.toHaveBeenCalled();
    expect(publisher.publishPartial).toHaveBeenCalledOnce();
  });

  it('rejects cross-device work_id', async () => {
    const publisher = makePublisher({
      'w-partial-B': { device_id: 'device-B', operation: 'collection.collectAll' },
    });
    const { servicer, authContext } = buildServicer({ publisher });
    authContext.subject = dev('device-A');
    const { context, abort } = abortContext();
    await expect(
      servicer.ReportPartialResult(partialResultReq({ workId: 'w-partial-B', unit: 'lscpu', data: '{}' }), context),
    ).rejects.toBeInstanceOf(AbortError);
    expect(abort.mock.calls[0][0]).toBe(GrpcStatusCode.PERMISSION_DENIED);
  });
});

describe('AgentServicer.ReportLogs — auth + device_id check + entry cap', () => {
  it('rejects discovery subject', async () => {
    const { servicer, authContext } = buildServicer();
    authContext.subject = discovery();
    const { context, abort } = abortContext();
    await expect(servicer.ReportLogs(logBatchReq('dev-1', []), context)).rejects.toBeInstanceOf(AbortError);
    expect(abort.mock.calls[0][0]).toBe(GrpcStatusCode.PERMISSION_DENIED);
    expect(abort.mock.calls[0][1]).toContain('device-kind token required');
  });

  it('rejects mismatched device_id (CLAIMED + AUTHED appear in abort msg)', async () => {
    const { servicer, authContext } = buildServicer();
    authContext.subject = dev('AUTHED');
    const { context, abort } = abortContext();
    await expect(servicer.ReportLogs(logBatchReq('CLAIMED', []), context)).rejects.toBeInstanceOf(AbortError);
    expect(abort.mock.calls[0][0]).toBe(GrpcStatusCode.PERMISSION_DENIED);
    expect(abort.mock.calls[0][1]).toMatch(/CLAIMED.*AUTHED/);
  });

  it('accepts matching device_id with logs forwarded through the bridge logger', async () => {
    const { servicer, authContext, logger } = buildServicer();
    authContext.subject = dev('dev-ok');
    const { context, abort } = abortContext();
    const entries: LogEntryRequest[] = [{ level: 'info', message: 'hello', fieldsJson: '' }];
    const ack = await servicer.ReportLogs(logBatchReq('dev-ok', entries), context);
    expect(ack).toEqual({});
    expect(abort).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledOnce();
  });

  it('forwards device id and agent trace correlation into the logger context', async () => {
    const { servicer, authContext, logger } = buildServicer();
    authContext.subject = dev('dev-ctx');
    const { context } = abortContext();
    const fieldsJson = JSON.stringify({
      app_class_name: 'dispatcher',
      job_id: 'j-1',
      trace_id: '0af7651916cd43dd8448eb211c80319c',
      span_id: 'b7ad6b7169203331',
    });
    await servicer.ReportLogs(logBatchReq('dev-ctx', [{ level: 'error', message: 'boom', fieldsJson }]), context);
    expect(logger.error).toHaveBeenCalledExactlyOnceWith('[agent device=dev-ctx] boom', {
      appClassName: 'dispatcher',
      jobId: 'j-1',
      appName: 'bridge-agent',
      deviceId: 'dev-ctx',
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
    });
  });

  it('accepts empty device_id in payload (identity from subject)', async () => {
    const { servicer, authContext } = buildServicer();
    authContext.subject = dev('dev-ok');
    const { context, abort } = abortContext();
    const ack = await servicer.ReportLogs(
      logBatchReq('', [{ level: 'info', message: 'hello', fieldsJson: '' }]),
      context,
    );
    expect(ack).toEqual({});
    expect(abort).not.toHaveBeenCalled();
  });

  it('emits warning for fields_json over cap; small entries parse normally (F-5)', async () => {
    const { servicer, authContext, logger } = buildServicer();
    authContext.subject = dev('dev-cap');
    const { context } = abortContext();

    const REPORTLOGS_MAX_FIELDS_JSON_BYTES = 64 * 1024;
    const huge = '{"x":"' + 'a'.repeat(REPORTLOGS_MAX_FIELDS_JSON_BYTES + 100) + '"}';
    const small = '{"job_id":"j-1"}';
    await servicer.ReportLogs(
      logBatchReq('dev-cap', [
        { level: 'info', message: 'huge', fieldsJson: huge },
        { level: 'info', message: 'small', fieldsJson: small },
      ]),
      context,
    );
    const warnings = logger.warning.mock.calls.map((c) => c[0] as string);
    expect(warnings.some((m) => m.includes('fields_json byte cap'))).toBe(true);
  });
});

describe('AgentServicer.ReportTraces — auth + device_id check + byte cap + best-effort relay', () => {
  const traceBatch = (deviceId: string, bytes = 16): { deviceId: string; otlpTraces: Uint8Array } => ({
    deviceId,
    otlpTraces: new Uint8Array(bytes),
  });

  it('rejects discovery subject', async () => {
    const { servicer, authContext } = buildServicer();
    authContext.subject = discovery();
    const { context, abort } = abortContext();
    await expect(servicer.ReportTraces(traceBatch('dev-1'), context)).rejects.toBeInstanceOf(AbortError);
    expect(abort.mock.calls[0][0]).toBe(GrpcStatusCode.PERMISSION_DENIED);
    expect(abort.mock.calls[0][1]).toContain('device-kind token required');
  });

  it('rejects mismatched device_id', async () => {
    const { servicer, authContext, traceRelay } = buildServicer();
    authContext.subject = dev('AUTHED');
    const { context, abort } = abortContext();
    await expect(servicer.ReportTraces(traceBatch('CLAIMED'), context)).rejects.toBeInstanceOf(AbortError);
    expect(abort.mock.calls[0][0]).toBe(GrpcStatusCode.PERMISSION_DENIED);
    expect(abort.mock.calls[0][1]).toMatch(/CLAIMED.*AUTHED/);
    expect(traceRelay.forward).not.toHaveBeenCalled();
  });

  it('aborts RESOURCE_EXHAUSTED over the byte cap without forwarding', async () => {
    const { servicer, authContext, traceRelay } = buildServicer();
    authContext.subject = dev('dev-big');
    const { context, abort } = abortContext();
    await expect(servicer.ReportTraces(traceBatch('dev-big', 1024 * 1024 + 1), context)).rejects.toBeInstanceOf(
      AbortError,
    );
    expect(abort.mock.calls[0][0]).toBe(GrpcStatusCode.RESOURCE_EXHAUSTED);
    expect(traceRelay.forward).not.toHaveBeenCalled();
  });

  it('drops and acks when the relay is disabled (bridge telemetry off)', async () => {
    const { servicer, authContext, traceRelay } = buildServicer();
    traceRelay.isEnabled.mockReturnValue(false);
    authContext.subject = dev('dev-off');
    const { context, abort } = abortContext();
    const ack = await servicer.ReportTraces(traceBatch('dev-off'), context);
    expect(ack).toEqual({});
    expect(abort).not.toHaveBeenCalled();
    expect(traceRelay.forward).not.toHaveBeenCalled();
  });

  it('still acks when forwarding fails (down collector must not retry-storm agents)', async () => {
    const { servicer, authContext, traceRelay, logger } = buildServicer();
    traceRelay.forward.mockRejectedValue(new Error('collector unreachable'));
    authContext.subject = dev('dev-err');
    const { context, abort } = abortContext();
    const ack = await servicer.ReportTraces(traceBatch('dev-err'), context);
    expect(ack).toEqual({});
    expect(abort).not.toHaveBeenCalled();
    const warnings = logger.warning.mock.calls.map((c) => c[0] as string);
    expect(warnings.some((m) => m.includes('ReportTraces forward failed'))).toBe(true);
  });

  it('forwards the OTLP bytes verbatim on the happy path (empty device_id ok)', async () => {
    const { servicer, authContext, traceRelay } = buildServicer();
    authContext.subject = dev('dev-ok');
    const { context, abort } = abortContext();
    const batch = traceBatch('', 32);
    const ack = await servicer.ReportTraces(batch, context);
    expect(ack).toEqual({});
    expect(abort).not.toHaveBeenCalled();
    expect(traceRelay.forward).toHaveBeenCalledExactlyOnceWith(batch.otlpTraces);
  });
});

describe('AgentServicer.FetchBundle — auth + streaming + sha + artifact', () => {
  it('rejects discovery subject', async () => {
    const { servicer, authContext } = buildServicer();
    authContext.subject = discovery();
    const { context, abort } = abortContext();
    const stream = servicer.FetchBundle(bundleReq('a'.repeat(64)), context);
    await expect(drainSession(stream)).rejects.toBeInstanceOf(AbortError);
    expect(abort.mock.calls[0][0]).toBe(GrpcStatusCode.PERMISSION_DENIED);
  });

  it('rejects when no subject is bound', async () => {
    const { servicer } = buildServicer();
    const { context, abort } = abortContext();
    const stream = servicer.FetchBundle(bundleReq('a'.repeat(64)), context);
    await expect(drainSession(stream)).rejects.toBeInstanceOf(AbortError);
    expect(abort.mock.calls[0][0]).toBe(GrpcStatusCode.PERMISSION_DENIED);
  });

  it('streams a 200KiB bundle in 4 × 64KiB chunks', async () => {
    const bundleBytes = Buffer.alloc(200 * 1024, 0x78);
    const expectedSha = createHash('sha256').update(bundleBytes).digest('hex');
    const { servicer, authContext } = buildServicer({
      bundleConfig: { bundlePath: '/fake/main.js', unitPath: '/fake/unit' },
      readFile: async (path: string) => {
        if (path !== '/fake/main.js') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return bundleBytes;
      },
    });
    authContext.subject = dev('dev-bundle');
    const { context, abort } = abortContext();
    const chunks: Uint8Array[] = [];
    for await (const c of servicer.FetchBundle(bundleReq(expectedSha), context)) {
      chunks.push((c as { data: Uint8Array }).data);
    }
    const assembled = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    expect(assembled.equals(bundleBytes)).toBe(true);
    expect(chunks.length).toBe(4);
    expect(abort).not.toHaveBeenCalled();
  });

  it('rejects sha mismatch with NOT_FOUND', async () => {
    const bytes = Buffer.from('actual');
    const { servicer, authContext } = buildServicer({
      bundleConfig: { bundlePath: '/fake/main.js', unitPath: '/fake/unit' },
      readFile: async () => bytes,
    });
    authContext.subject = dev('dev-sha');
    const { context, abort } = abortContext();
    const stream = servicer.FetchBundle(bundleReq('0'.repeat(64)), context);
    await expect(drainSession(stream)).rejects.toBeInstanceOf(AbortError);
    expect(abort.mock.calls[0][0]).toBe(GrpcStatusCode.NOT_FOUND);
  });

  it('rejects ARTIFACT_UNSPECIFIED with INVALID_ARGUMENT', async () => {
    const { servicer, authContext } = buildServicer();
    authContext.subject = dev('dev-artifact');
    const { context, abort } = abortContext();
    const stream = servicer.FetchBundle(bundleReq('a'.repeat(64), BundleArtifact.ARTIFACT_UNSPECIFIED), context);
    await expect(drainSession(stream)).rejects.toBeInstanceOf(AbortError);
    expect(abort.mock.calls[0][0]).toBe(GrpcStatusCode.INVALID_ARGUMENT);
  });
});

describe('AgentServicer.RenewToken', () => {
  it('slides TTL on happy path and returns deviceTtlS', async () => {
    const tokenService = {
      slideDeviceTtl: vi.fn(async () => true),
      deviceTtlS: 12_345,
    };
    const { servicer, authContext } = buildServicer({ tokenService });
    authContext.subject = dev('dev-renew');
    const { context, abort } = abortContext();
    const ack = await servicer.RenewToken({}, context);
    expect(tokenService.slideDeviceTtl).toHaveBeenCalledWith('dev-renew');
    expect(ack.newExpiresInS).toBe(12_345);
    expect(abort).not.toHaveBeenCalled();
  });

  it('rejects a discovery subject with PERMISSION_DENIED', async () => {
    const { servicer, authContext } = buildServicer();
    authContext.subject = discovery();
    const { context, abort } = abortContext();
    await expect(servicer.RenewToken({}, context)).rejects.toBeInstanceOf(AbortError);
    expect(abort.mock.calls[0][0]).toBe(GrpcStatusCode.PERMISSION_DENIED);
  });

  it('reports UNAUTHENTICATED when device-index record is missing', async () => {
    const tokenService = {
      slideDeviceTtl: vi.fn(async () => false),
      deviceTtlS: 3600,
    };
    const { servicer, authContext } = buildServicer({ tokenService });
    authContext.subject = dev('dev-gone');
    const { context, abort } = abortContext();
    await expect(servicer.RenewToken({}, context)).rejects.toBeInstanceOf(AbortError);
    expect(abort.mock.calls[0][0]).toBe(GrpcStatusCode.UNAUTHENTICATED);
  });
});

describe('AgentServicer.PhoneHome', () => {
  function phoneHomeReq(bootId = 'boot-1'): PhoneHomeRequestMsg {
    return { bootId };
  }

  it('rejects a non-device (discovery) subject with PERMISSION_DENIED', async () => {
    const { servicer, authContext } = buildServicer();
    authContext.subject = discovery();
    const { context, abort } = abortContext();
    await expect(servicer.PhoneHome(phoneHomeReq(), context)).rejects.toBeInstanceOf(AbortError);
    expect(abort.mock.calls[0][0]).toBe(GrpcStatusCode.PERMISSION_DENIED);
    expect(abort.mock.calls[0][1]).toContain('device-kind token required');
  });

  it('rejects when no subject is bound with PERMISSION_DENIED', async () => {
    const { servicer } = buildServicer();
    const { context, abort } = abortContext();
    await expect(servicer.PhoneHome(phoneHomeReq(), context)).rejects.toBeInstanceOf(AbortError);
    expect(abort.mock.calls[0][0]).toBe(GrpcStatusCode.PERMISSION_DENIED);
  });

  it('aborts with UNAVAILABLE when enqueuePhoneHome reports the queue is unavailable', async () => {
    const results = {
      enqueuePhoneHome: vi.fn(async () => false),
      writeCollectorToResultsCache: vi.fn(async () => ({ ok: true, kept: 1 })),
    };
    const { servicer, authContext } = buildServicer({ results });
    authContext.subject = dev('dev-ph');
    const { context, abort } = abortContext();
    await expect(servicer.PhoneHome(phoneHomeReq('boot-x'), context)).rejects.toBeInstanceOf(AbortError);
    expect(results.enqueuePhoneHome).toHaveBeenCalledWith({ deviceId: 'dev-ph', bootId: 'boot-x' });
    expect(abort.mock.calls[0][0]).toBe(GrpcStatusCode.UNAVAILABLE);
    expect(abort.mock.calls[0][1]).toContain('phone-home enqueue failed');
  });

  it('returns an ack on a successful enqueue', async () => {
    const results = {
      enqueuePhoneHome: vi.fn(async () => true),
      writeCollectorToResultsCache: vi.fn(async () => ({ ok: true, kept: 1 })),
    };
    const { servicer, authContext } = buildServicer({ results });
    authContext.subject = dev('dev-ph');
    const { context, abort } = abortContext();
    const ack = await servicer.PhoneHome(phoneHomeReq('boot-ok'), context);
    expect(ack).toEqual({});
    expect(abort).not.toHaveBeenCalled();
    expect(results.enqueuePhoneHome).toHaveBeenCalledWith({ deviceId: 'dev-ph', bootId: 'boot-ok' });
  });

  it('rejects an over-length or control-char boot_id with INVALID_ARGUMENT before enqueue', async () => {
    const results = {
      enqueuePhoneHome: vi.fn(async () => true),
      writeCollectorToResultsCache: vi.fn(async () => ({ ok: true, kept: 1 })),
    };
    for (const bootId of ['', 'a'.repeat(129), 'boot\u0000id', 'boot\nid']) {
      const { servicer, authContext } = buildServicer({ results });
      authContext.subject = dev('dev-ph');
      const { context, abort } = abortContext();
      await expect(servicer.PhoneHome(phoneHomeReq(bootId), context)).rejects.toBeInstanceOf(AbortError);
      expect(abort.mock.calls[0][0]).toBe(GrpcStatusCode.INVALID_ARGUMENT);
    }
    expect(results.enqueuePhoneHome).not.toHaveBeenCalled();
  });
});

describe('AgentServicer._maybe_cache_collector_partial — corrupt dispatch-meta', () => {
  function collectorReq(workId: string): PartialResultRequest {
    return partialResultReq({ workId, unit: 'arch', data: '{"k":"v"}', status: PartialResultStatus.STATUS_SUCCESS });
  }

  function publisherReturning(meta: unknown): AgentServicerDeps['publisher'] {
    return {
      getDispatchMeta: vi.fn(async () => meta),
      publishResult: vi.fn(async () => undefined),
      publishProgress: vi.fn(async () => undefined),
      publishPartial: vi.fn(async () => undefined),
    } as unknown as AgentServicerDeps['publisher'];
  }

  function resultsMock(): AgentServicerDeps['results'] & {
    writeCollectorToResultsCache: Mock<(...args: any[]) => any>;
  } {
    return {
      enqueuePhoneHome: vi.fn(async () => true),
      writeCollectorToResultsCache: vi.fn(async () => ({ ok: true, kept: 1 })),
    };
  }

  it.each([
    ['a bare number', 5],
    ['a boolean', true],
  ])('throws on corrupt non-object meta (%s) instead of silently skipping the cache', async (_label, meta) => {
    const results = resultsMock();
    const { servicer } = buildServicer({ results });
    await expect(
      servicer._maybe_cache_collector_partial(collectorReq('w-corrupt'), publisherReturning(meta)),
    ).rejects.toBeInstanceOf(TypeError);
    expect(results.writeCollectorToResultsCache).not.toHaveBeenCalled();
  });

  it('still caches a well-formed collection.* partial', async () => {
    const results = resultsMock();
    const { servicer } = buildServicer({ results });
    const publisher = publisherReturning({ operation: 'collection.collectAll', device_id: 'dev-9' });
    await servicer._maybe_cache_collector_partial(collectorReq('w-ok'), publisher);
    expect(results.writeCollectorToResultsCache).toHaveBeenCalledWith({
      deviceId: 'dev-9',
      collector: 'arch',
      data: { k: 'v' },
    });
  });

  it('skips without throwing on an empty-object meta', async () => {
    const results = resultsMock();
    const { servicer } = buildServicer({ results });
    await expect(
      servicer._maybe_cache_collector_partial(collectorReq('w-empty'), publisherReturning({})),
    ).resolves.toBeUndefined();
    expect(results.writeCollectorToResultsCache).not.toHaveBeenCalled();
  });

  it.each([
    ['a number', 5],
    ['a boolean', true],
    ['an array', ['collection.x']],
    ['null', null],
  ])('throws TypeError on a present non-string operation (%s) without caching', async (_label, operation) => {
    const results = resultsMock();
    const { servicer } = buildServicer({ results });
    const publisher = publisherReturning({ operation, device_id: 'dev-9' });
    await expect(servicer._maybe_cache_collector_partial(collectorReq('w-badop'), publisher)).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(results.writeCollectorToResultsCache).not.toHaveBeenCalled();
  });
});

describe('classifyCollectorPartial', () => {
  const SUCCESS = PartialResultStatus.STATUS_SUCCESS;
  const FAILURE = PartialResultStatus.STATUS_FAILURE;
  it('returns skip_non_success when status != success', () => {
    expect(classifyCollectorPartial(FAILURE, SUCCESS, 'arch', '{}')).toBe('skip_non_success');
  });
  it('returns skip_empty when unit or data is empty', () => {
    expect(classifyCollectorPartial(SUCCESS, SUCCESS, '', '{}')).toBe('skip_empty');
    expect(classifyCollectorPartial(SUCCESS, SUCCESS, 'arch', '')).toBe('skip_empty');
  });
  it('returns skip_bad_unit when unit fails the regex', () => {
    expect(classifyCollectorPartial(SUCCESS, SUCCESS, '1bad', '{}')).toBe('skip_bad_unit');
    expect(classifyCollectorPartial(SUCCESS, SUCCESS, 'BAD', '{}')).toBe('skip_bad_unit');
  });
  it('returns accept for well-formed unit + data', () => {
    expect(classifyCollectorPartial(SUCCESS, SUCCESS, 'architecture', '{}')).toBe('accept');
    expect(classifyCollectorPartial(SUCCESS, SUCCESS, 'lsblk\n', '{}')).toBe('accept');
  });
});

describe('NIL_DEVICE_ID constant', () => {
  it('is the canonical zero-UUID', () => {
    expect(NIL_DEVICE_ID).toBe('00000000-0000-0000-0000-000000000000');
  });
});
