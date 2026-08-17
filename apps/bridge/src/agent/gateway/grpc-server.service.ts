import { Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';

import { NIL_JOB_ID } from '../../constants';
import { logError, logInfo } from '../../core/logging/bridge-logger';

import { AgentServicer } from './agent.servicer';
import { DeviceAuthInterceptor } from './auth.interceptor';
import { getGrpcConfig } from './grpc.config';

const APP_CLASS_NAME = 'grpc-server';

const KEEPALIVE_TIME_MS = 30_000;
const KEEPALIVE_TIMEOUT_MS = 10_000;
const HTTP2_MIN_PING_INTERVAL_WITHOUT_DATA_MS = 10_000;
const HTTP2_MAX_PINGS_WITHOUT_DATA = 0;
const MAX_RECEIVE_MESSAGE_BYTES = 16 * 1024 * 1024;
const SO_REUSEPORT = 0;

const DEFAULT_BIND_HOST = '127.0.0.1';

export interface GrpcServerOptions {
  readonly keepaliveTimeMs: number;
  readonly keepaliveTimeoutMs: number;
  readonly http2MinPingIntervalWithoutDataMs: number;
  readonly http2MaxPingsWithoutData: number;
  readonly maxReceiveMessageBytes: number;
  readonly soReuseport: number;
}

export const DEFAULT_GRPC_SERVER_OPTIONS: GrpcServerOptions = {
  keepaliveTimeMs: KEEPALIVE_TIME_MS,
  keepaliveTimeoutMs: KEEPALIVE_TIMEOUT_MS,
  http2MinPingIntervalWithoutDataMs: HTTP2_MIN_PING_INTERVAL_WITHOUT_DATA_MS,
  http2MaxPingsWithoutData: HTTP2_MAX_PINGS_WITHOUT_DATA,
  maxReceiveMessageBytes: MAX_RECEIVE_MESSAGE_BYTES,
  soReuseport: SO_REUSEPORT,
};

export interface GrpcServerHandle {
  close(opts: { graceSeconds: number }): Promise<void>;
}

// Transport contract: auth interceptor MUST be installed first; listener is insecure — nginx terminates TLS.
export interface GrpcTransportServer {
  close(opts: { graceSeconds: number }): Promise<void>;
}

export interface GrpcTransportBindArgs {
  readonly bindHost: string;
  readonly port: number;
  readonly options: GrpcServerOptions;
  readonly interceptors: readonly DeviceAuthInterceptor[];
  readonly servicer: AgentServicer;
}

export interface GrpcTransportFactory {
  startServer(args: GrpcTransportBindArgs): Promise<GrpcTransportServer>;
}

export interface AgentServicerFactory {
  build(): AgentServicer;
}

export interface AuthInterceptorFactory {
  build(): DeviceAuthInterceptor;
}

export interface GrpcServerServiceDeps {
  servicerFactory: AgentServicerFactory;
  authInterceptorFactory: AuthInterceptorFactory;
  transportFactory: GrpcTransportFactory;
  options?: GrpcServerOptions;
}

export function buildInterceptors(authInterceptorFactory: AuthInterceptorFactory): DeviceAuthInterceptor[] {
  return [authInterceptorFactory.build()];
}

@Injectable()
export class GrpcServerService implements OnModuleInit, OnApplicationShutdown {
  private handle: GrpcServerHandle | null = null;

  constructor(private readonly deps: GrpcServerServiceDeps) {}

  async onModuleInit(): Promise<void> {
    const config = getGrpcConfig();
    if (!config.enabled) {
      setGrpcServerStatus({
        bound: false,
        internalHost: config.internalHost,
        internalPort: config.internalPort,
      });
      logInfo('gRPC server disabled via GRPC_ENABLED=false', {
        appClassName: APP_CLASS_NAME,
        jobId: NIL_JOB_ID,
      });
      return;
    }
    try {
      this.handle = await this.startServer({
        internalPort: config.internalPort,
        internalHost: config.internalHost,
      });
      setGrpcServerStatus({
        bound: true,
        internalHost: config.internalHost,
        internalPort: config.internalPort,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setGrpcServerStatus({
        bound: false,
        internalHost: config.internalHost,
        internalPort: config.internalPort,
      });

      logError(
        `FATAL: gRPC AgentService failed to bind ${config.internalHost}:${config.internalPort} (${message}); exiting non-zero so the orchestrator restarts this process`,
        { appClassName: APP_CLASS_NAME, jobId: NIL_JOB_ID },
      );
      process.exit(1);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    try {
      if (this.handle !== null) {
        logInfo('gRPC server shutdown signal received; stopping gracefully', {
          appClassName: APP_CLASS_NAME,
          jobId: NIL_JOB_ID,
        });
        await this.handle.close({ graceSeconds: 5 });
        this.handle = null;
      }
    } finally {
      setGrpcServerStatus(null);
    }
  }

  async startServer(opts: { internalPort: number; internalHost?: string; jobId?: string }): Promise<GrpcServerHandle> {
    const bindHost = opts.internalHost ?? DEFAULT_BIND_HOST;
    const port = opts.internalPort;
    const options = this.deps.options ?? DEFAULT_GRPC_SERVER_OPTIONS;

    const interceptors = buildInterceptors(this.deps.authInterceptorFactory);
    const servicer = this.deps.servicerFactory.build();

    const transport = await this.deps.transportFactory.startServer({
      bindHost,
      port,
      options,
      interceptors,
      servicer,
    });

    logInfo(`gRPC server listening on ${bindHost}:${port} (plaintext; TLS terminated by nginx)`, {
      appClassName: APP_CLASS_NAME,
      jobId: opts.jobId ?? NIL_JOB_ID,
    });

    return {
      close: (closeOpts) => transport.close(closeOpts),
    };
  }
}

export interface GrpcServerStatus {
  bound: boolean;
  internalHost: string;
  internalPort: number;
}

let grpcServerStatus: GrpcServerStatus | null = null;

export function getGrpcServerStatus(): GrpcServerStatus | null {
  return grpcServerStatus;
}

export function setGrpcServerStatus(status: GrpcServerStatus | null): void {
  grpcServerStatus = status;
}
