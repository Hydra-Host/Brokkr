import * as path from 'node:path';

import { Injectable } from '@nestjs/common';

import { NIL_JOB_ID } from '../../constants';
import { logDebug, logWarning } from '../../core/logging/bridge-logger';

import type { GrpcMetadata, InterceptableCall } from './auth.interceptor';
import type {
  GrpcServerOptions,
  GrpcTransportBindArgs,
  GrpcTransportFactory,
  GrpcTransportServer,
} from './grpc-server.service';

const APP_CLASS_NAME = 'grpc-transport';

const PROTO_PACKAGE = 'brokkr.agent.v1';
const SERVICE_NAME = 'AgentService';

const DEFAULT_AGENT_PROTO_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'proto',
  'brokkr',
  'agent',
  'v1',
  'agent.proto',
);

const DEFAULT_PROTO_INCLUDE_DIRS = [
  path.dirname(DEFAULT_AGENT_PROTO_PATH),
  path.resolve(__dirname, '..', '..', '..', '..', '..', 'proto'),
];

export interface GrpcServerLike {
  addService(definition: GrpcServiceDefinitionLike, implementation: GrpcServiceImplementation): void;
  bindAsync(addr: string, creds: GrpcServerCredentialsLike, cb: (err: Error | null, port: number) => void): void;
  tryShutdown(cb: (err?: Error | null) => void): void;
  forceShutdown(): void;
}

export interface GrpcServerCredentialsLike {
  readonly _credentials: true;
}

export interface GrpcMethodDefinitionLike {
  readonly path: string;
  readonly requestStream: boolean;
  readonly responseStream: boolean;
  requestSerialize: (value: unknown) => Buffer;
  requestDeserialize: (bytes: Buffer) => unknown;
  responseSerialize: (value: unknown) => Buffer;
  responseDeserialize: (bytes: Buffer) => unknown;
}

export type GrpcServiceDefinitionLike = Record<string, GrpcMethodDefinitionLike>;

export type GrpcServiceImplementation = Record<string, GrpcUnaryHandler | GrpcServerStreamHandler>;

export interface GrpcMetadataLike {
  get(key: string): readonly (string | Buffer)[];
  getMap(): Readonly<Record<string, string | Buffer>>;
}

export interface GrpcServerUnaryCallLike<TRequest, _TResponse = unknown> {
  readonly request: TRequest;
  readonly metadata: GrpcMetadataLike;
  getPeer(): string;
}

export interface GrpcServerWritableStreamLike<TRequest, TResponse> {
  readonly request: TRequest;
  readonly metadata: GrpcMetadataLike;
  getPeer(): string;
  write(msg: TResponse, cb?: (err?: Error | null) => void): boolean;
  end(): void;
  on(event: 'cancelled', cb: () => void): void;
  emit(event: 'error', err: GrpcServerErrorLike): boolean;
}

export type GrpcSendUnaryData<TResponse> = (err: GrpcServerErrorLike | null, value?: TResponse) => void;

export interface GrpcServerErrorLike extends Error {
  code: number;
  details?: string;
  metadata?: GrpcMetadataLike;
}

export type GrpcUnaryHandler = (
  call: GrpcServerUnaryCallLike<unknown, unknown>,
  cb: GrpcSendUnaryData<unknown>,
) => void;

export type GrpcServerStreamHandler = (call: GrpcServerWritableStreamLike<unknown, unknown>) => void;

export interface GrpcRuntimeBindings {
  buildServer(options: GrpcServerNativeOptions): GrpcServerLike;
  insecureCreds(): GrpcServerCredentialsLike;
  loadServiceDefinition(args: {
    protoPath: string;
    includeDirs: readonly string[];
    packageName: string;
    serviceName: string;
  }): GrpcServiceDefinitionLike;
  makeError(code: number, details: string): GrpcServerErrorLike;
}

export type GrpcServerNativeOptions = Record<string, number>;

export function renderGrpcServerNativeOptions(opts: GrpcServerOptions): GrpcServerNativeOptions {
  return {
    'grpc.so_reuseport': opts.soReuseport,
    'grpc.keepalive_time_ms': opts.keepaliveTimeMs,
    'grpc.keepalive_timeout_ms': opts.keepaliveTimeoutMs,
    'grpc.http2.min_ping_interval_without_data_ms': opts.http2MinPingIntervalWithoutDataMs,
    'grpc.http2.max_pings_without_data': opts.http2MaxPingsWithoutData,
    'grpc.max_receive_message_length': opts.maxReceiveMessageBytes,
  };
}

export function metadataToIterable(metadata: GrpcMetadataLike): GrpcMetadata {
  const out: Array<[string, unknown]> = [];
  const map = metadata.getMap();
  for (const [k, v] of Object.entries(map)) {
    out.push([k, v]);
  }
  return out;
}

export function composeInterceptors(
  interceptors: readonly { intercept: <T>(call: InterceptableCall, next: () => Promise<T>) => Promise<T> }[],
  call: InterceptableCall,
  terminal: () => Promise<unknown>,
): Promise<unknown> {
  let next: () => Promise<unknown> = terminal;
  for (let i = interceptors.length - 1; i >= 0; i--) {
    const interceptor = interceptors[i];
    const downstream = next;
    next = () => interceptor.intercept(call, downstream);
  }
  return next();
}

function buildInterceptableCall(args: {
  methodPath: string;
  metadata: GrpcMetadataLike;
  bindings: GrpcRuntimeBindings;
}): InterceptableCall {
  return {
    method: args.methodPath,
    metadata: metadataToIterable(args.metadata),
    abort: async (code: number, message: string): Promise<never> => {
      throw args.bindings.makeError(code, message);
    },
  };
}

const GRPC_STATUS_INTERNAL = 13;

function toServerError(err: unknown, bindings: GrpcRuntimeBindings): GrpcServerErrorLike {
  if (typeof err === 'object' && err !== null && 'code' in err && typeof (err as { code: unknown }).code === 'number') {
    return err as GrpcServerErrorLike;
  }
  const message = err instanceof Error ? err.message : String(err);
  return bindings.makeError(GRPC_STATUS_INTERNAL, message);
}

function buildUnaryContext(
  call: GrpcServerUnaryCallLike<unknown, unknown>,
  bindings: GrpcRuntimeBindings,
): {
  abort: (code: number, message: string) => Promise<never>;
  peer: () => string | null;
  metadata: (key: string) => readonly (string | Buffer)[];
} {
  return {
    abort: async (code, message) => {
      throw bindings.makeError(code, message);
    },
    peer: () => call.getPeer(),
    metadata: (key) => call.metadata.get(key),
  };
}

function buildStreamContext(
  call: GrpcServerWritableStreamLike<unknown, unknown>,
  bindings: GrpcRuntimeBindings,
  registerCancel: (cb: () => void) => void,
): {
  abort: (code: number, message: string) => Promise<never>;
  peer: () => string | null;
  metadata: (key: string) => readonly (string | Buffer)[];
  onCancelled: (cb: () => void) => void;
} {
  return {
    abort: async (code, message) => {
      throw bindings.makeError(code, message);
    },
    peer: () => call.getPeer(),
    metadata: (key) => call.metadata.get(key),
    onCancelled: registerCancel,
  };
}

/** New RPCs must extend BOTH this map AND EXPECTED_METHODS in __test__/interceptor-coverage.spec.ts. */
export const AGENT_SERVICE_RPC_TO_HANDLER: ReadonlyArray<{
  rpc: string;
  type: 'unary' | 'serverStream';
  servicerMethod:
    | 'OpenSession'
    | 'ReportResult'
    | 'ReportProgress'
    | 'ReportPartialResult'
    | 'FetchBundle'
    | 'ReportLogs'
    | 'ReportTraces'
    | 'RenewToken'
    | 'PhoneHome';
}> = [
  { rpc: 'OpenSession', type: 'serverStream', servicerMethod: 'OpenSession' },
  { rpc: 'ReportResult', type: 'unary', servicerMethod: 'ReportResult' },
  { rpc: 'ReportProgress', type: 'unary', servicerMethod: 'ReportProgress' },
  { rpc: 'ReportPartialResult', type: 'unary', servicerMethod: 'ReportPartialResult' },
  { rpc: 'FetchBundle', type: 'serverStream', servicerMethod: 'FetchBundle' },
  { rpc: 'ReportLogs', type: 'unary', servicerMethod: 'ReportLogs' },
  { rpc: 'ReportTraces', type: 'unary', servicerMethod: 'ReportTraces' },
  { rpc: 'RenewToken', type: 'unary', servicerMethod: 'RenewToken' },
  { rpc: 'PhoneHome', type: 'unary', servicerMethod: 'PhoneHome' },
];

const METHOD_PATH_PREFIX = `/${PROTO_PACKAGE}.${SERVICE_NAME}`;

function methodPath(rpc: string): string {
  return `${METHOD_PATH_PREFIX}/${rpc}`;
}

export function buildServiceImplementation(args: {
  servicer: AgentServicerHandlersLike;
  interceptors: readonly { intercept: <T>(call: InterceptableCall, next: () => Promise<T>) => Promise<T> }[];
  bindings: GrpcRuntimeBindings;
}): GrpcServiceImplementation {
  const impl: GrpcServiceImplementation = {};
  for (const route of AGENT_SERVICE_RPC_TO_HANDLER) {
    const handlerName = route.servicerMethod;
    const path_ = methodPath(route.rpc);
    if (route.type === 'unary') {
      impl[route.rpc] = ((call: GrpcServerUnaryCallLike<unknown, unknown>, cb: GrpcSendUnaryData<unknown>): void => {
        const interceptable = buildInterceptableCall({
          methodPath: path_,
          metadata: call.metadata,
          bindings: args.bindings,
        });
        const ctx = buildUnaryContext(call, args.bindings);
        const terminal = async (): Promise<unknown> => {
          const method = args.servicer[handlerName] as unknown as (req: unknown, ctx: unknown) => Promise<unknown>;
          return method.call(args.servicer, call.request, ctx);
        };
        composeInterceptors(args.interceptors, interceptable, terminal).then(
          (value) => cb(null, value),
          (err: unknown) => cb(toServerError(err, args.bindings)),
        );
      }) as GrpcUnaryHandler;
    } else {
      impl[route.rpc] = ((call: GrpcServerWritableStreamLike<unknown, unknown>): void => {
        const interceptable = buildInterceptableCall({
          methodPath: path_,
          metadata: call.metadata,
          bindings: args.bindings,
        });
        let cancelled = false;
        const cancelCallbacks: Array<() => void> = [];
        const ctx = buildStreamContext(call, args.bindings, (cb) => {
          if (cancelled) {
            try {
              cb();
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              logWarning(`gRPC stream ${path_} cancel callback failed: ${message}`, {
                appClassName: APP_CLASS_NAME,
                jobId: NIL_JOB_ID,
              });
            }
            return;
          }
          cancelCallbacks.push(cb);
        });
        try {
          call.on('cancelled', () => {
            cancelled = true;
            for (const cb of cancelCallbacks.splice(0)) {
              try {
                cb();
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                logWarning(`gRPC stream ${path_} cancel callback failed: ${message}`, {
                  appClassName: APP_CLASS_NAME,
                  jobId: NIL_JOB_ID,
                });
              }
            }
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logDebug(`gRPC stream ${path_} cancel listener setup failed: ${message}`, {
            appClassName: APP_CLASS_NAME,
            jobId: NIL_JOB_ID,
          });
        }
        const terminal = async (): Promise<unknown> => {
          const method = args.servicer[handlerName] as unknown as (
            req: unknown,
            ctx: unknown,
          ) => AsyncIterable<unknown>;
          const iterable = method.call(args.servicer, call.request, ctx);
          const iterator = (iterable as AsyncIterable<unknown>)[Symbol.asyncIterator]();
          try {
            while (true) {
              if (cancelled) break;
              const next = await iterator.next();
              if (next.done === true) break;
              if (cancelled) break;
              call.write(next.value);
            }
          } finally {
            if (cancelled && typeof iterator.return === 'function') {
              try {
                await iterator.return(undefined);
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                logDebug(`gRPC stream ${path_} iterator cleanup failed: ${message}`, {
                  appClassName: APP_CLASS_NAME,
                  jobId: NIL_JOB_ID,
                });
              }
            }
          }
          if (!cancelled) {
            call.end();
          }
          return undefined;
        };
        composeInterceptors(args.interceptors, interceptable, terminal).catch((err: unknown) => {
          const status = toServerError(err, args.bindings);
          logWarning(`gRPC stream handler ${path_} aborted code=${status.code}: ${status.message}`, {
            appClassName: APP_CLASS_NAME,
            jobId: NIL_JOB_ID,
          });
          let emitted = false;
          try {
            if (typeof call.emit === 'function') {
              call.emit('error', status);
              emitted = true;
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logDebug(`gRPC stream ${path_} error emit failed: ${message}`, {
              appClassName: APP_CLASS_NAME,
              jobId: NIL_JOB_ID,
            });
          }
          if (!emitted) {
            try {
              call.end();
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              logDebug(`gRPC stream ${path_} end failed: ${message}`, {
                appClassName: APP_CLASS_NAME,
                jobId: NIL_JOB_ID,
              });
            }
          }
        });
      }) as GrpcServerStreamHandler;
    }
  }
  return impl;
}

export interface AgentServicerHandlersLike {
  OpenSession(req: unknown, ctx: unknown): AsyncIterable<unknown>;
  ReportResult(req: unknown, ctx: unknown): Promise<unknown>;
  ReportProgress(req: unknown, ctx: unknown): Promise<unknown>;
  ReportPartialResult(req: unknown, ctx: unknown): Promise<unknown>;
  FetchBundle(req: unknown, ctx: unknown): AsyncIterable<unknown>;
  ReportLogs(req: unknown, ctx: unknown): Promise<unknown>;
  ReportTraces(req: unknown, ctx: unknown): Promise<unknown>;
  RenewToken(req: unknown, ctx: unknown): Promise<unknown>;
  PhoneHome(req: unknown, ctx: unknown): Promise<unknown>;
}

export function createDefaultGrpcRuntimeBindings(): GrpcRuntimeBindings {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const grpc = require('@grpc/grpc-js') as {
    Server: new (channelOpts?: Record<string, unknown>) => GrpcServerLike;
    ServerCredentials: { createInsecure: () => GrpcServerCredentialsLike };
    loadPackageDefinition: (def: unknown) => Record<string, unknown>;
    Metadata: new () => GrpcMetadataLike;
    status: Record<string, number>;
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const protoLoader = require('@grpc/proto-loader') as {
    loadSync: (
      file: string | readonly string[],
      opts: {
        keepCase: boolean;
        longs: unknown;
        enums: unknown;
        defaults: boolean;
        oneofs: boolean;
        includeDirs?: readonly string[];
      },
    ) => unknown;
  };

  return {
    buildServer: (options) => new grpc.Server(options),
    insecureCreds: () => grpc.ServerCredentials.createInsecure(),
    loadServiceDefinition: (args) => {
      const packageDef = protoLoader.loadSync(args.protoPath, {
        keepCase: false,
        longs: String,
        enums: Number,
        defaults: true,
        oneofs: true,
        includeDirs: args.includeDirs.slice(),
      });
      const loaded = grpc.loadPackageDefinition(packageDef);
      const parts = args.packageName.split('.');
      let cursor: Record<string, unknown> | undefined = loaded;
      for (const part of parts) {
        if (cursor === undefined) break;
        cursor = cursor[part] as Record<string, unknown> | undefined;
      }
      if (cursor === undefined) {
        throw new Error(`proto package ${args.packageName} not found in ${args.protoPath}`);
      }
      const svc = cursor[args.serviceName] as { service: GrpcServiceDefinitionLike } | undefined;
      if (svc === undefined) {
        throw new Error(`proto service ${args.serviceName} not found in package ${args.packageName}`);
      }
      return svc.service;
    },
    makeError: (code, details) => {
      const err = new Error(details) as GrpcServerErrorLike;
      err.code = code;
      err.details = details;
      return err;
    },
  };
}

export interface GrpcTransportFactoryOptions {
  protoPath?: string;
  includeDirs?: readonly string[];
  bindings?: GrpcRuntimeBindings;
}

@Injectable()
export class GrpcTransportFactoryImpl implements GrpcTransportFactory {
  private readonly bindings: GrpcRuntimeBindings;
  private readonly protoPath: string;
  private readonly includeDirs: readonly string[];

  constructor(options: GrpcTransportFactoryOptions = {}) {
    this.protoPath = options.protoPath ?? DEFAULT_AGENT_PROTO_PATH;
    this.includeDirs = options.includeDirs ?? DEFAULT_PROTO_INCLUDE_DIRS;
    this.bindings = options.bindings ?? createDefaultGrpcRuntimeBindings();
  }

  async startServer(args: GrpcTransportBindArgs): Promise<GrpcTransportServer> {
    const nativeOptions = renderGrpcServerNativeOptions(args.options);
    const server = this.bindings.buildServer(nativeOptions);

    const serviceDefinition = this.bindings.loadServiceDefinition({
      protoPath: this.protoPath,
      includeDirs: this.includeDirs,
      packageName: PROTO_PACKAGE,
      serviceName: SERVICE_NAME,
    });
    const implementation = buildServiceImplementation({
      servicer: args.servicer as unknown as AgentServicerHandlersLike,
      interceptors: args.interceptors,
      bindings: this.bindings,
    });
    server.addService(serviceDefinition, implementation);

    const addr = `${args.bindHost}:${args.port}`;
    await new Promise<number>((resolve, reject) => {
      server.bindAsync(addr, this.bindings.insecureCreds(), (err, port) => {
        if (err) reject(err);
        else if (port === 0)
          reject(new Error(`failed to bind gRPC AgentService listener to ${addr} (port already in use?)`));
        else resolve(port);
      });
    });

    return {
      close: async (closeOpts: { graceSeconds: number }): Promise<void> => {
        await new Promise<void>((resolve) => {
          let settled = false;
          const settle = (): void => {
            if (settled) return;
            settled = true;
            resolve();
          };
          const timer = setTimeout(
            () => {
              if (settled) return;
              try {
                server.forceShutdown();
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                logDebug(`gRPC server force shutdown failed: ${message}`, {
                  appClassName: APP_CLASS_NAME,
                  jobId: NIL_JOB_ID,
                });
              }
              settle();
            },
            Math.max(0, closeOpts.graceSeconds * 1000),
          );
          if (typeof (timer as { unref?: () => void }).unref === 'function') {
            (timer as { unref: () => void }).unref();
          }
          server.tryShutdown((err) => {
            clearTimeout(timer);
            if (err) {
              try {
                server.forceShutdown();
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                logDebug(`gRPC server force shutdown failed: ${message}`, {
                  appClassName: APP_CLASS_NAME,
                  jobId: NIL_JOB_ID,
                });
              }
            }
            settle();
          });
        });
      },
    };
  }
}
