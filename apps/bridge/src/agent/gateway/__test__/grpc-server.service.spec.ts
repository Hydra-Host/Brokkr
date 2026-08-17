import { afterEach, describe, expect, it, vi } from 'vitest';

import * as bridgeLogger from '../../../core/logging/bridge-logger';
import { AgentServicer } from '../agent.servicer';
import type { AgentServicerDeps } from '../agent.servicer.types';
import {
  DeviceAuthInterceptor,
  type AuthContextBinder,
  type AuthInterceptorLogger,
  type TokenVerifierPort,
} from '../auth.interceptor';
import {
  buildInterceptors,
  DEFAULT_GRPC_SERVER_OPTIONS,
  GrpcServerService,
  type AgentServicerFactory,
  type AuthInterceptorFactory,
  type GrpcTransportBindArgs,
  type GrpcTransportFactory,
  type GrpcTransportServer,
} from '../grpc-server.service';
import { resetGrpcConfigForTests } from '../grpc.config';

function buildAuthInterceptor(): DeviceAuthInterceptor {
  const tokenService: TokenVerifierPort = { verify: vi.fn().mockResolvedValue(null) };
  const binder: AuthContextBinder = {
    bind: vi.fn().mockImplementation(async <T>(_s, fn: () => Promise<T>) => fn()),
  };
  const logger: AuthInterceptorLogger = { warning: vi.fn().mockResolvedValue(undefined) };
  return new DeviceAuthInterceptor(tokenService, binder, logger);
}

function buildAgentServicer(): AgentServicer {
  return new AgentServicer({} as unknown as AgentServicerDeps);
}

interface Captured {
  args: GrpcTransportBindArgs | null;
  closeCalls: { graceSeconds: number }[];
  transport: GrpcTransportServer;
}

function buildTransportFactory(): { factory: GrpcTransportFactory; captured: Captured } {
  const captured: Captured = {
    args: null,
    closeCalls: [],
    transport: { close: vi.fn() } as unknown as GrpcTransportServer,
  };
  const transport: GrpcTransportServer = {
    close: vi.fn().mockImplementation(async (opts: { graceSeconds: number }) => {
      captured.closeCalls.push(opts);
    }),
  };
  captured.transport = transport;
  const factory: GrpcTransportFactory = {
    startServer: vi.fn().mockImplementation(async (args: GrpcTransportBindArgs) => {
      captured.args = args;
      return transport;
    }),
  };
  return { factory, captured };
}

describe('buildInterceptors', () => {
  it('returns a list whose entries include DeviceAuthInterceptor', () => {
    const built = buildInterceptors({
      build: () => buildAuthInterceptor(),
    });
    expect(built.some((i) => i instanceof DeviceAuthInterceptor)).toBe(true);
  });

  it('returns an Array', () => {
    const built = buildInterceptors({ build: () => buildAuthInterceptor() });
    expect(Array.isArray(built)).toBe(true);
  });

  it('DeviceAuthInterceptor entry is a real instance, not a class reference', () => {
    const built = buildInterceptors({ build: () => buildAuthInterceptor() });
    expect(built[0]).toBeInstanceOf(DeviceAuthInterceptor);
  });

  it('puts the auth interceptor FIRST in the chain', () => {
    const built = buildInterceptors({ build: () => buildAuthInterceptor() });
    expect(built[0]).toBeInstanceOf(DeviceAuthInterceptor);
  });

  it('invokes the factory on every call', () => {
    const factory: AuthInterceptorFactory = { build: vi.fn(() => buildAuthInterceptor()) };
    buildInterceptors(factory);
    buildInterceptors(factory);
    expect(factory.build).toHaveBeenCalledTimes(2);
  });
});

describe('GrpcServerService.startServer', () => {
  const authInterceptorFactory: AuthInterceptorFactory = {
    build: () => buildAuthInterceptor(),
  };
  const servicerFactory: AgentServicerFactory = {
    build: () => buildAgentServicer(),
  };

  it('binds the transport on the requested host:port with default options', async () => {
    const { factory, captured } = buildTransportFactory();
    const service = new GrpcServerService({
      authInterceptorFactory,
      servicerFactory,
      transportFactory: factory,
    });

    await service.startServer({ internalPort: 50051, internalHost: '127.0.0.1' });

    expect(factory.startServer).toHaveBeenCalledTimes(1);
    expect(captured.args).not.toBeNull();
    expect(captured.args?.bindHost).toBe('127.0.0.1');
    expect(captured.args?.port).toBe(50051);
    expect(captured.args?.options).toEqual(DEFAULT_GRPC_SERVER_OPTIONS);
  });

  it('defaults bindHost to 127.0.0.1 when not provided', async () => {
    const { factory, captured } = buildTransportFactory();
    const service = new GrpcServerService({
      authInterceptorFactory,
      servicerFactory,
      transportFactory: factory,
    });

    await service.startServer({ internalPort: 9082 });

    expect(captured.args?.bindHost).toBe('127.0.0.1');
  });

  it('passes the built interceptors (auth first) and a fresh servicer to the transport', async () => {
    const { factory, captured } = buildTransportFactory();
    const buildAuthSpy = vi.fn(() => buildAuthInterceptor());
    const buildServicerSpy = vi.fn(() => buildAgentServicer());
    const service = new GrpcServerService({
      authInterceptorFactory: { build: buildAuthSpy },
      servicerFactory: { build: buildServicerSpy },
      transportFactory: factory,
    });

    await service.startServer({ internalPort: 50051 });

    expect(buildAuthSpy).toHaveBeenCalledTimes(1);
    expect(buildServicerSpy).toHaveBeenCalledTimes(1);
    expect(captured.args?.interceptors).toHaveLength(1);
    expect(captured.args?.interceptors[0]).toBeInstanceOf(DeviceAuthInterceptor);
    expect(captured.args?.servicer).toBeInstanceOf(AgentServicer);
  });

  it('honours an override option block', async () => {
    const { factory, captured } = buildTransportFactory();
    const customOptions = {
      ...DEFAULT_GRPC_SERVER_OPTIONS,
      keepaliveTimeMs: 1234,
      maxReceiveMessageBytes: 4096,
    };
    const service = new GrpcServerService({
      authInterceptorFactory,
      servicerFactory,
      transportFactory: factory,
      options: customOptions,
    });

    await service.startServer({ internalPort: 50051 });

    expect(captured.args?.options).toEqual(customOptions);
  });

  it('returns a handle whose close() delegates to the transport with graceSeconds', async () => {
    const { factory, captured } = buildTransportFactory();
    const service = new GrpcServerService({
      authInterceptorFactory,
      servicerFactory,
      transportFactory: factory,
    });

    const handle = await service.startServer({ internalPort: 50051 });
    await handle.close({ graceSeconds: 5 });

    expect(captured.transport.close).toHaveBeenCalledWith({ graceSeconds: 5 });
    expect(captured.closeCalls).toEqual([{ graceSeconds: 5 }]);
  });

  it('default options match the expected server options block', () => {
    expect(DEFAULT_GRPC_SERVER_OPTIONS).toEqual({
      keepaliveTimeMs: 30_000,
      keepaliveTimeoutMs: 10_000,
      http2MinPingIntervalWithoutDataMs: 10_000,
      http2MaxPingsWithoutData: 0,
      maxReceiveMessageBytes: 16 * 1024 * 1024,
      soReuseport: 0,
    });
  });
});

describe('GrpcServerService.onModuleInit', () => {
  const authInterceptorFactory: AuthInterceptorFactory = { build: () => buildAuthInterceptor() };
  const servicerFactory: AgentServicerFactory = { build: () => buildAgentServicer() };

  afterEach(() => {
    resetGrpcConfigForTests();
    vi.restoreAllMocks();
  });

  it('exits the process non-zero when the gRPC listener fails to bind', async () => {
    const failingFactory: GrpcTransportFactory = {
      startServer: vi
        .fn()
        .mockRejectedValue(new Error('failed to bind gRPC AgentService listener (port already in use?)')),
    };
    const logErrorSpy = vi.spyOn(bridgeLogger, 'logError');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const service = new GrpcServerService({
      authInterceptorFactory,
      servicerFactory,
      transportFactory: failingFactory,
    });

    await service.onModuleInit();

    expect(failingFactory.startServer).toHaveBeenCalledTimes(1);
    expect(logErrorSpy).toHaveBeenCalledWith(expect.stringMatching(/FATAL/), expect.anything());
    expect(logErrorSpy.mock.invocationCallOrder[0]).toBeLessThan(exitSpy.mock.invocationCallOrder[0]);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
