import { describe, expect, it, vi } from 'vitest';

import {
  DeviceAuthInterceptor,
  type AuthContextBinder,
  type AuthInterceptorLogger,
  type InterceptableCall,
  type TokenVerifierPort,
} from '../auth.interceptor';
import { DEFAULT_GRPC_SERVER_OPTIONS, type GrpcServerOptions } from '../grpc-server.service';
import {
  AGENT_SERVICE_RPC_TO_HANDLER,
  buildServiceImplementation,
  composeInterceptors,
  GrpcTransportFactoryImpl,
  metadataToIterable,
  renderGrpcServerNativeOptions,
  type AgentServicerHandlersLike,
  type GrpcMetadataLike,
  type GrpcRuntimeBindings,
  type GrpcSendUnaryData,
  type GrpcServerCredentialsLike,
  type GrpcServerErrorLike,
  type GrpcServerLike,
  type GrpcServerStreamHandler,
  type GrpcServerUnaryCallLike,
  type GrpcServerWritableStreamLike,
  type GrpcServiceDefinitionLike,
  type GrpcServiceImplementation,
  type GrpcUnaryHandler,
} from '../grpc-transport.factory';

function makeAuthInterceptor(): DeviceAuthInterceptor {
  const tokenService: TokenVerifierPort = { verify: vi.fn().mockResolvedValue(null) };
  const binder: AuthContextBinder = {
    bind: vi.fn().mockImplementation(async <T>(_s, fn: () => Promise<T>) => fn()),
  };
  const logger: AuthInterceptorLogger = { warning: vi.fn().mockResolvedValue(undefined) };
  return new DeviceAuthInterceptor(tokenService, binder, logger);
}

function makeMetadata(entries: ReadonlyArray<[string, string]> = []): GrpcMetadataLike {
  const map: Record<string, string> = {};
  for (const [k, v] of entries) map[k] = v;
  return {
    get: (key: string) => (map[key] !== undefined ? [map[key]] : []),
    getMap: () => map,
  };
}

interface FakeStream extends GrpcServerWritableStreamLike<unknown, unknown> {
  readonly writes: unknown[];
  readonly cancelHandlers: Array<() => void>;
  readonly emittedErrors: GrpcServerErrorLike[];
  ended: boolean;
  fireCancelled(): void;
}

function makeFakeStream(options: { metadata?: GrpcMetadataLike; peer?: string } = {}): FakeStream {
  const writes: unknown[] = [];
  const cancelHandlers: Array<() => void> = [];
  const emittedErrors: GrpcServerErrorLike[] = [];
  const stream: FakeStream = {
    writes,
    cancelHandlers,
    emittedErrors,
    ended: false,
    request: {},
    metadata: options.metadata ?? makeMetadata(),
    getPeer: () => options.peer ?? 'ipv4:127.0.0.1:5050',
    write: (msg) => {
      writes.push(msg);
      return true;
    },
    end: () => {
      stream.ended = true;
    },
    on: (event, cb) => {
      if (event === 'cancelled') cancelHandlers.push(cb);
    },
    emit: (event, err) => {
      if (event === 'error') emittedErrors.push(err);
      return true;
    },
    fireCancelled: () => {
      for (const handler of cancelHandlers) handler();
    },
  };
  return stream;
}

function makeStubBindings(): GrpcRuntimeBindings & {
  serverLog: Array<{ kind: string; payload: unknown }>;
  fakeServer: GrpcServerLike & {
    addServiceCalls: Array<{ definition: GrpcServiceDefinitionLike; implementation: GrpcServiceImplementation }>;
    bindAsyncCalls: Array<{ addr: string }>;
    tryShutdownCalls: number;
    forceShutdownCalls: number;
    failBind?: Error;
    zeroBind?: boolean;
    tryShutdownError?: Error;
    hangTryShutdown?: boolean;
  };
} {
  const serverLog: Array<{ kind: string; payload: unknown }> = [];
  const fakeServer = {
    addServiceCalls: [] as Array<{ definition: GrpcServiceDefinitionLike; implementation: GrpcServiceImplementation }>,
    bindAsyncCalls: [] as Array<{ addr: string }>,
    tryShutdownCalls: 0,
    forceShutdownCalls: 0,
    failBind: undefined as Error | undefined,
    zeroBind: false,
    tryShutdownError: undefined as Error | undefined,
    hangTryShutdown: false,
    addService(definition: GrpcServiceDefinitionLike, implementation: GrpcServiceImplementation): void {
      this.addServiceCalls.push({ definition, implementation });
      serverLog.push({ kind: 'addService', payload: { definition, implementation } });
    },
    bindAsync(addr: string, _creds: GrpcServerCredentialsLike, cb: (err: Error | null, port: number) => void): void {
      this.bindAsyncCalls.push({ addr });
      if (this.failBind !== undefined) {
        cb(this.failBind, 0);
      } else if (this.zeroBind === true) {
        cb(null, 0);
      } else {
        const port = Number.parseInt(addr.split(':').pop() ?? '1', 10) || 1;
        cb(null, port);
      }
    },
    tryShutdown(cb: (err?: Error | null) => void): void {
      this.tryShutdownCalls += 1;
      if (this.hangTryShutdown) return;
      cb(this.tryShutdownError ?? null);
    },
    forceShutdown(): void {
      this.forceShutdownCalls += 1;
    },
  };

  const fakeCreds: GrpcServerCredentialsLike = { _credentials: true };
  const fakeServiceDef: GrpcServiceDefinitionLike = {};
  for (const route of AGENT_SERVICE_RPC_TO_HANDLER) {
    fakeServiceDef[route.rpc] = {
      path: `/brokkr.agent.v1.AgentService/${route.rpc}`,
      requestStream: false,
      responseStream: route.type === 'serverStream',
      requestSerialize: (v) => Buffer.from(JSON.stringify(v ?? null)),
      requestDeserialize: (b) => JSON.parse(b.toString('utf-8')) as unknown,
      responseSerialize: (v) => Buffer.from(JSON.stringify(v ?? null)),
      responseDeserialize: (b) => JSON.parse(b.toString('utf-8')) as unknown,
    };
  }

  return {
    serverLog,
    fakeServer,
    buildServer: (opts) => {
      serverLog.push({ kind: 'buildServer', payload: opts });
      return fakeServer;
    },
    insecureCreds: () => fakeCreds,
    loadServiceDefinition: (args) => {
      serverLog.push({ kind: 'loadServiceDefinition', payload: args });
      return fakeServiceDef;
    },
    makeError: (code, details) => {
      const err = new Error(details) as GrpcServerErrorLike;
      err.code = code;
      err.details = details;
      return err;
    },
  };
}

function makeServicerStub(): AgentServicerHandlersLike & {
  calls: Array<{ method: string; req: unknown }>;
} {
  const calls: Array<{ method: string; req: unknown }> = [];
  const log = (method: string, req: unknown): void => {
    calls.push({ method, req });
  };
  return {
    calls,
    async *OpenSession() {
      log('OpenSession', undefined);
      yield;
    },
    async ReportResult(req) {
      log('ReportResult', req);
      return {};
    },
    async ReportProgress(req) {
      log('ReportProgress', req);
      return {};
    },
    async ReportPartialResult(req) {
      log('ReportPartialResult', req);
      return {};
    },
    async *FetchBundle() {
      log('FetchBundle', undefined);
      yield;
    },
    async ReportLogs(req) {
      log('ReportLogs', req);
      return {};
    },
    async ReportTraces(req) {
      log('ReportTraces', req);
      return {};
    },
    async RenewToken(req) {
      log('RenewToken', req);
      return { newExpiresInS: 86400 };
    },
    async PhoneHome(req) {
      log('PhoneHome', req);
      return {};
    },
  };
}

describe('renderGrpcServerNativeOptions', () => {
  it('renders the channel-args map line-for-line against expected options', () => {
    const native = renderGrpcServerNativeOptions(DEFAULT_GRPC_SERVER_OPTIONS);
    expect(native).toEqual({
      'grpc.so_reuseport': 0,
      'grpc.keepalive_time_ms': 30_000,
      'grpc.keepalive_timeout_ms': 10_000,
      'grpc.http2.min_ping_interval_without_data_ms': 10_000,
      'grpc.http2.max_pings_without_data': 0,
      'grpc.max_receive_message_length': 16 * 1024 * 1024,
    });
  });

  it('honours overrides on every option field', () => {
    const custom: GrpcServerOptions = {
      keepaliveTimeMs: 1,
      keepaliveTimeoutMs: 2,
      http2MinPingIntervalWithoutDataMs: 3,
      http2MaxPingsWithoutData: 4,
      maxReceiveMessageBytes: 5,
      soReuseport: 6,
    };
    expect(renderGrpcServerNativeOptions(custom)).toEqual({
      'grpc.so_reuseport': 6,
      'grpc.keepalive_time_ms': 1,
      'grpc.keepalive_timeout_ms': 2,
      'grpc.http2.min_ping_interval_without_data_ms': 3,
      'grpc.http2.max_pings_without_data': 4,
      'grpc.max_receive_message_length': 5,
    });
  });
});

describe('metadataToIterable', () => {
  it('returns the metadata getMap entries as [key, value] tuples', () => {
    const md = makeMetadata([
      ['authorization', 'Bearer tok'],
      ['x-trace', 'abc'],
    ]);
    const entries = [...metadataToIterable(md)];
    expect(entries).toEqual([
      ['authorization', 'Bearer tok'],
      ['x-trace', 'abc'],
    ]);
  });
});

describe('composeInterceptors', () => {
  it('runs interceptors in array order (outermost-first)', async () => {
    const order: string[] = [];
    const a = {
      intercept: async <T>(_call: InterceptableCall, next: () => Promise<T>): Promise<T> => {
        order.push('a:before');
        const v = await next();
        order.push('a:after');
        return v;
      },
    };
    const b = {
      intercept: async <T>(_call: InterceptableCall, next: () => Promise<T>): Promise<T> => {
        order.push('b:before');
        const v = await next();
        order.push('b:after');
        return v;
      },
    };
    const call: InterceptableCall = {
      method: '/test/Method',
      metadata: [],
      abort: async () => {
        throw new Error('abort');
      },
    };
    const result = await composeInterceptors([a, b], call, async () => {
      order.push('terminal');
      return 42;
    });
    expect(result).toBe(42);
    expect(order).toEqual(['a:before', 'b:before', 'terminal', 'b:after', 'a:after']);
  });

  it('an empty chain invokes terminal directly', async () => {
    const call: InterceptableCall = {
      method: '/test/Empty',
      metadata: [],
      abort: async () => {
        throw new Error('abort');
      },
    };
    const result = await composeInterceptors([], call, async () => 'direct');
    expect(result).toBe('direct');
  });
});

describe('buildServiceImplementation', () => {
  it('registers a handler for every AgentService RPC', () => {
    const servicer = makeServicerStub();
    const bindings = makeStubBindings();
    const impl = buildServiceImplementation({
      servicer,
      interceptors: [],
      bindings,
    });
    for (const route of AGENT_SERVICE_RPC_TO_HANDLER) {
      expect(impl[route.rpc]).toBeTypeOf('function');
    }
    expect(Object.keys(impl).sort()).toEqual(AGENT_SERVICE_RPC_TO_HANDLER.map((r) => r.rpc).sort());
  });

  it('unary wrapper invokes the underlying servicer method and forwards the response', async () => {
    const servicer = makeServicerStub();
    const bindings = makeStubBindings();
    const impl = buildServiceImplementation({ servicer, interceptors: [], bindings });
    const handler = impl.ReportLogs as GrpcUnaryHandler;
    const call: GrpcServerUnaryCallLike<unknown, unknown> = {
      request: { deviceId: 'dev-1', entries: [] },
      metadata: makeMetadata(),
      getPeer: () => 'ipv4:127.0.0.1:1234',
    };
    const ack = await new Promise<unknown>((resolve, reject) => {
      const cb: GrpcSendUnaryData<unknown> = (err, value) => {
        if (err !== null) reject(err);
        else resolve(value);
      };
      handler(call, cb);
    });
    expect(ack).toEqual({});
    expect(servicer.calls.find((c) => c.method === 'ReportLogs')?.req).toEqual({
      deviceId: 'dev-1',
      entries: [],
    });
  });

  it('serverStream wrapper supplies the peer and metadata to the servicer context', async () => {
    const bindings = makeStubBindings();
    let observed: { peer: unknown; realIp: readonly unknown[] } | null = null;
    const servicer: AgentServicerHandlersLike = {
      ...makeServicerStub(),
      async *OpenSession(_req, ctx) {
        if (
          typeof ctx !== 'object' ||
          ctx === null ||
          !('peer' in ctx) ||
          typeof ctx.peer !== 'function' ||
          !('metadata' in ctx) ||
          typeof ctx.metadata !== 'function'
        ) {
          throw new Error('invalid servicer context');
        }
        observed = {
          peer: ctx.peer(),
          realIp: ctx.metadata('x-real-ip'),
        };
        yield { sessionAccepted: {} };
      },
    };
    const impl = buildServiceImplementation({ servicer, interceptors: [], bindings });
    const handler = impl.OpenSession as GrpcServerStreamHandler;
    const stream = makeFakeStream({
      metadata: makeMetadata([['x-real-ip', '10.0.0.5']]),
      peer: 'ipv4:127.0.0.1:5050',
    });

    handler(stream);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(observed).toEqual({
      peer: 'ipv4:127.0.0.1:5050',
      realIp: ['10.0.0.5'],
    });
  });

  it('aborts the chain when an interceptor throws — servicer is not called', async () => {
    const servicer = makeServicerStub();
    const bindings = makeStubBindings();
    const aborting = {
      intercept: async <T>(call: InterceptableCall, _next: () => Promise<T>): Promise<T> => {
        await call.abort(16, 'no token');
        throw new Error('unreachable');
      },
    };
    const impl = buildServiceImplementation({
      servicer,
      interceptors: [aborting],
      bindings,
    });
    const handler = impl.ReportLogs as GrpcUnaryHandler;
    const call: GrpcServerUnaryCallLike<unknown, unknown> = {
      request: {},
      metadata: makeMetadata(),
      getPeer: () => 'ipv4:127.0.0.1:1234',
    };
    const err = await new Promise<GrpcServerErrorLike | null>((resolve) => {
      handler(call, (e) => resolve(e));
    });
    expect(err?.code).toBe(16);
    expect(err?.message).toBe('no token');
    expect(servicer.calls).toHaveLength(0);
  });

  it('serverStream wrapper emits `error` with the status-bearing code when an interceptor aborts', async () => {
    const servicer = makeServicerStub();
    const bindings = makeStubBindings();
    const aborting = {
      intercept: async <T>(call: InterceptableCall, _next: () => Promise<T>): Promise<T> => {
        await call.abort(16, 'no token');
        throw new Error('unreachable');
      },
    };
    const impl = buildServiceImplementation({
      servicer,
      interceptors: [aborting],
      bindings,
    });
    const handler = impl.OpenSession as GrpcServerStreamHandler;
    const stream = makeFakeStream();
    handler(stream);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stream.emittedErrors).toHaveLength(1);
    expect(stream.emittedErrors[0].code).toBe(16);
    expect(stream.emittedErrors[0].message).toBe('no token');
    expect(servicer.calls.find((c) => c.method === 'OpenSession')).toBeUndefined();
    expect(stream.ended).toBe(false);
  });

  it('serverStream wrapper emits `error` when the servicer aborts mid-stream', async () => {
    const bindings = makeStubBindings();
    const servicer: AgentServicerHandlersLike = {
      ...makeServicerStub(),
      // eslint-disable-next-line require-yield
      async *OpenSession() {
        const err = new Error('mismatch') as GrpcServerErrorLike;
        err.code = 7;
        throw err;
      },
    };
    const impl = buildServiceImplementation({ servicer, interceptors: [], bindings });
    const handler = impl.OpenSession as GrpcServerStreamHandler;
    const stream = makeFakeStream();
    handler(stream);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stream.emittedErrors).toHaveLength(1);
    expect(stream.emittedErrors[0].code).toBe(7);
    expect(stream.ended).toBe(false);
  });

  it('serverStream wrapper runs the generator finally on client cancellation', async () => {
    const bindings = makeStubBindings();
    let cleanupRan = false;
    let resolveNext: ((value: IteratorResult<unknown>) => void) | null = null;
    const pendingNext = new Promise<IteratorResult<unknown>>((resolve) => {
      resolveNext = resolve;
    });
    const iterable: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => pendingNext,
          return: async (): Promise<IteratorResult<unknown>> => {
            cleanupRan = true;
            return { value: undefined, done: true };
          },
        };
      },
    };
    const servicer: AgentServicerHandlersLike = {
      ...makeServicerStub(),
      OpenSession: () => iterable,
    };
    const impl = buildServiceImplementation({ servicer, interceptors: [], bindings });
    const handler = impl.OpenSession as GrpcServerStreamHandler;
    const stream = makeFakeStream();
    handler(stream);
    await new Promise<void>((resolve) => setImmediate(resolve));
    stream.fireCancelled();
    if (resolveNext !== null) {
      resolveNext({ value: undefined, done: false });
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cleanupRan).toBe(true);
    expect(stream.ended).toBe(false);
  });
});

describe('GrpcTransportFactoryImpl.startServer', () => {
  it('renders native options, loads the service def, registers handlers, binds the listener', async () => {
    const bindings = makeStubBindings();
    const factory = new GrpcTransportFactoryImpl({ bindings });
    const servicer = makeServicerStub() as unknown;
    const handle = await factory.startServer({
      bindHost: '127.0.0.1',
      port: 50051,
      options: DEFAULT_GRPC_SERVER_OPTIONS,
      interceptors: [makeAuthInterceptor()],
      servicer: servicer as never,
    });

    const buildEvent = bindings.serverLog.find((e) => e.kind === 'buildServer');
    expect(buildEvent?.payload).toEqual(renderGrpcServerNativeOptions(DEFAULT_GRPC_SERVER_OPTIONS));

    const loadEvent = bindings.serverLog.find((e) => e.kind === 'loadServiceDefinition');
    expect(loadEvent?.payload).toMatchObject({
      packageName: 'brokkr.agent.v1',
      serviceName: 'AgentService',
    });

    expect(bindings.fakeServer.addServiceCalls).toHaveLength(1);
    const addCall = bindings.fakeServer.addServiceCalls[0];
    expect(Object.keys(addCall.implementation).sort()).toEqual(AGENT_SERVICE_RPC_TO_HANDLER.map((r) => r.rpc).sort());

    expect(bindings.fakeServer.bindAsyncCalls).toEqual([{ addr: '127.0.0.1:50051' }]);

    expect(typeof handle.close).toBe('function');
  });

  it('propagates bindAsync errors via a rejected startServer promise', async () => {
    const bindings = makeStubBindings();
    bindings.fakeServer.failBind = new Error('EADDRINUSE');
    const factory = new GrpcTransportFactoryImpl({ bindings });
    await expect(
      factory.startServer({
        bindHost: '127.0.0.1',
        port: 50051,
        options: DEFAULT_GRPC_SERVER_OPTIONS,
        interceptors: [],
        servicer: makeServicerStub() as never,
      }),
    ).rejects.toMatchObject({ message: 'EADDRINUSE' });
  });

  it('rejects when bindAsync reports a zero port (failed bind) with no error', async () => {
    const bindings = makeStubBindings();
    bindings.fakeServer.zeroBind = true;
    const factory = new GrpcTransportFactoryImpl({ bindings });
    await expect(
      factory.startServer({
        bindHost: '127.0.0.1',
        port: 8082,
        options: DEFAULT_GRPC_SERVER_OPTIONS,
        interceptors: [],
        servicer: makeServicerStub() as never,
      }),
    ).rejects.toThrow(/failed to bind/);
  });

  it('close() invokes tryShutdown and resolves when the runtime drains', async () => {
    const bindings = makeStubBindings();
    const factory = new GrpcTransportFactoryImpl({ bindings });
    const handle = await factory.startServer({
      bindHost: '127.0.0.1',
      port: 50051,
      options: DEFAULT_GRPC_SERVER_OPTIONS,
      interceptors: [],
      servicer: makeServicerStub() as never,
    });
    await handle.close({ graceSeconds: 5 });
    expect(bindings.fakeServer.tryShutdownCalls).toBe(1);
    expect(bindings.fakeServer.forceShutdownCalls).toBe(0);
  });

  it('close() force-shuts after the grace window elapses with no tryShutdown callback', async () => {
    vi.useFakeTimers();
    try {
      const bindings = makeStubBindings();
      bindings.fakeServer.hangTryShutdown = true;
      const factory = new GrpcTransportFactoryImpl({ bindings });
      const handle = await factory.startServer({
        bindHost: '127.0.0.1',
        port: 50051,
        options: DEFAULT_GRPC_SERVER_OPTIONS,
        interceptors: [],
        servicer: makeServicerStub() as never,
      });
      const closePromise = handle.close({ graceSeconds: 5 });
      vi.advanceTimersByTime(5_000);
      await closePromise;
      expect(bindings.fakeServer.tryShutdownCalls).toBe(1);
      expect(bindings.fakeServer.forceShutdownCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('serverStream wrapper writes each yielded message and ends the stream', async () => {
    const bindings = makeStubBindings();
    const stream = makeFakeStream();
    const yieldedMsgs = [
      { sessionAccepted: { bridgeId: 'b1', topology: [], agentVersion: 'v1' } },
      { topologyUpdate: { bridges: [] } },
    ];
    const servicer: AgentServicerHandlersLike = {
      ...makeServicerStub(),
      async *OpenSession() {
        for (const msg of yieldedMsgs) yield msg;
      },
    } as AgentServicerHandlersLike;
    const impl = buildServiceImplementation({
      servicer,
      interceptors: [],
      bindings,
    });
    const handler = impl.OpenSession as GrpcServerStreamHandler;
    handler(stream);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stream.writes).toEqual(yieldedMsgs);
    expect(stream.ended).toBe(true);
    expect(stream.emittedErrors).toHaveLength(0);
  });
});
