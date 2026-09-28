import {
  DynamicModule,
  type ForwardReference,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  Provider,
  type Type,
} from '@nestjs/common';

import { getErrorMessage } from '../../common/error-utils';
import { logWarning } from '../../logger/logger.service';
import { getGrpcConfig } from '../gateway/grpc.config';

import { ConnectionRegistry } from '../connection-registry/connection-registry.service';
import {
  QueueFullError,
  type SessionHandle as RegistrySessionHandle,
} from '../connection-registry/connection-registry.types';

import { DEFAULT_POLL_INTERVAL_MS, TopologyBroadcasterService } from './topology-broadcaster.service';
import type {
  BridgeRegistryReaderPort,
  SessionHandle as BroadcasterSessionHandle,
  ConnectionRegistryPort,
  GrpcConfigPort,
  PeerAnchorPort,
  TopologyBroadcasterLogger,
  TopologyServerMessage,
} from './topology-broadcaster.types';

export function adaptHandleForBroadcaster(handle: RegistrySessionHandle): BroadcasterSessionHandle {
  return {
    peerIp: handle.peerIp,
    enqueue(msg: TopologyServerMessage): boolean {
      try {
        handle.queue.putNowait(msg);
        return true;
      } catch (error) {
        if (error instanceof QueueFullError) return false;
        throw error;
      }
    },
  };
}

export function adaptConnectionRegistryForBroadcaster(registry: ConnectionRegistry): ConnectionRegistryPort {
  return {
    async snapshotSessionHandles(): Promise<readonly BroadcasterSessionHandle[]> {
      const handles = await registry.snapshotSessionHandles();
      return handles.map(adaptHandleForBroadcaster);
    },
  };
}

const SHUTDOWN_JOIN_TIMEOUT_MS = 5_000;

export type BridgeRegistryReaderInjectToken = Type<BridgeRegistryReaderPort> | string | symbol;

export type PeerAnchorInjectToken = Type<PeerAnchorPort> | string | symbol;

export interface TopologyBroadcasterModuleOptions {
  registry: ConnectionRegistry;
  reader?: BridgeRegistryReaderPort;
  readerToken?: BridgeRegistryReaderInjectToken;
  anchorResolver?: PeerAnchorPort;
  anchorResolverToken?: PeerAnchorInjectToken;
  readerImports?: Array<Type<unknown> | DynamicModule | Promise<DynamicModule> | ForwardReference>;
  grpcConfig: GrpcConfigPort;
  logger: TopologyBroadcasterLogger;
  pollIntervalMs?: number;
}

@Module({})
export class TopologyBroadcasterModule implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(private readonly service: TopologyBroadcasterService) {}

  static forRoot(options: TopologyBroadcasterModuleOptions): DynamicModule {
    const buildService = (
      reader: BridgeRegistryReaderPort,
      anchorResolver: PeerAnchorPort,
    ): TopologyBroadcasterService =>
      new TopologyBroadcasterService(
        adaptConnectionRegistryForBroadcaster(options.registry),
        reader,
        anchorResolver,
        options.grpcConfig,
        options.logger,
        options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      );
    const directReader = options.reader;
    const directAnchorResolver = options.anchorResolver;
    const readerToken = options.readerToken;
    const anchorResolverToken = options.anchorResolverToken;
    let serviceProvider: Provider;
    if (directReader !== undefined && directAnchorResolver !== undefined) {
      serviceProvider = {
        provide: TopologyBroadcasterService,
        useFactory: () => buildService(directReader, directAnchorResolver),
      };
    } else if (readerToken !== undefined && anchorResolverToken !== undefined) {
      serviceProvider = {
        provide: TopologyBroadcasterService,
        useFactory: (reader: BridgeRegistryReaderPort, anchorResolver: PeerAnchorPort) =>
          buildService(reader, anchorResolver),
        inject: [readerToken, anchorResolverToken],
      };
    } else {
      throw new Error(
        'TopologyBroadcasterModule.forRoot requires either `reader` + `anchorResolver` (test wiring) or `readerToken` + `anchorResolverToken` (DI wiring)',
      );
    }
    return {
      module: TopologyBroadcasterModule,
      imports: options.readerImports,
      providers: [serviceProvider],
      exports: [TopologyBroadcasterService],
    };
  }

  private runPromise: Promise<void> | null = null;

  onApplicationBootstrap(): void {
    if (!getGrpcConfig().enabled) return;
    this.runPromise = this.service.runForever().catch((error: unknown) => {
      void logWarning(`topology broadcaster runForever exited unexpectedly: ${getErrorMessage(error)}`, {
        appClassName: 'topology-broadcaster',
      });
    });
  }

  // joined, not fire-and-forget: an unjoined loop outlives app.close() with its poll timer still
  // referenced. Bounded, so a tick wedged on a network call can't abort Nest's shutdown sweep.
  async onApplicationShutdown(): Promise<void> {
    this.service.stop();
    const pending = this.runPromise;
    this.runPromise = null;
    if (pending === null) return;
    if (!(await joinWithin(pending, SHUTDOWN_JOIN_TIMEOUT_MS))) {
      void logWarning(
        `topology broadcaster did not exit within ${SHUTDOWN_JOIN_TIMEOUT_MS}ms of stop; abandoning the join`,
        { appClassName: 'topology-broadcaster' },
      );
    }
  }
}

function joinWithin(pending: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
    void pending.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
