import { ConnectionRegistry } from '../agent/connection-registry/connection-registry.service.js';
import { getGrpcConfig } from '../agent/gateway/grpc.config.js';
import {
  adaptConnectionRegistryForBroadcaster,
  type TopologyBroadcasterModuleOptions,
} from '../agent/topology-broadcaster/topology-broadcaster.module.js';
import {
  DEFAULT_POLL_INTERVAL_MS,
  TopologyBroadcasterService,
} from '../agent/topology-broadcaster/topology-broadcaster.service.js';
import type {
  BridgeRegistryReaderPort,
  BridgeSnapshot,
  GrpcConfigPort,
  PeerAnchorPort,
  TopologyBroadcasterLogger,
} from '../agent/topology-broadcaster/topology-broadcaster.types.js';
import {
  getAllBridgeHostnames,
  getBridgeRegistrySnapshot,
  type RegistryRedis,
} from '../bridge-network/bridge-registry-reader.js';
import { PeerAnchorResolver } from '../bridge-network/peer-anchor-resolver.js';
import { logDebug, logInfo, logWarning } from '../logger/logger.service.js';

const APP_CLASS_NAME = 'topology-broadcaster';

const defaultLogger: TopologyBroadcasterLogger = {
  debug: (msg, jobId) => {
    void logDebug(msg, { jobId, appClassName: APP_CLASS_NAME });
  },
  info: (msg, jobId) => {
    void logInfo(msg, { jobId, appClassName: APP_CLASS_NAME });
  },
  warning: (msg, jobId) => {
    void logWarning(msg, { jobId, appClassName: APP_CLASS_NAME });
  },
};

export function buildEmptyBridgeRegistryReader(): BridgeRegistryReaderPort {
  return {
    async getAllBridgeHostnames(): Promise<readonly string[]> {
      return [];
    },
    async getBridgeRegistrySnapshot(): Promise<BridgeSnapshot> {
      return [];
    },
  };
}

export function buildBridgeRegistryReaderFromRedis(redis: RegistryRedis): BridgeRegistryReaderPort {
  return {
    async getAllBridgeHostnames(jobId: string): Promise<readonly string[]> {
      return getAllBridgeHostnames(redis, { jobId });
    },
    async getBridgeRegistrySnapshot(jobId: string): Promise<BridgeSnapshot> {
      const raw = await getBridgeRegistrySnapshot(redis, { jobId });
      const entries: readonly [string, readonly unknown[]][] = raw.map(([hostname, interfaces]) => [
        hostname,
        Array.isArray(interfaces) ? interfaces : [],
      ]);
      return entries;
    },
  };
}

export interface TopologyBroadcasterFactoryOptions {
  reader?: BridgeRegistryReaderPort;
  anchorResolver?: PeerAnchorPort;
  grpcConfig?: GrpcConfigPort;
  logger?: TopologyBroadcasterLogger;
  pollIntervalMs?: number;
  // Inject a pre-built registry so the orchestrator-side broadcaster and AppModule-DI consumers share one session map.
  registry?: ConnectionRegistry;
}

export interface TopologyBroadcasterComposition {
  registry: ConnectionRegistry;
  service: TopologyBroadcasterService | null;
  moduleOptions: TopologyBroadcasterModuleOptions;
}

export function buildTopologyBroadcasterComposition(
  options: TopologyBroadcasterFactoryOptions = {},
): TopologyBroadcasterComposition {
  const registry = options.registry ?? new ConnectionRegistry();
  const grpcConfig = options.grpcConfig ?? getGrpcConfig();
  const logger = options.logger ?? defaultLogger;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const anchorResolver =
    options.anchorResolver ?? (options.reader !== undefined ? new PeerAnchorResolver() : undefined);

  const moduleOptions: TopologyBroadcasterModuleOptions = {
    registry,
    reader: options.reader,
    anchorResolver,
    grpcConfig,
    logger,
    pollIntervalMs,
  };

  const service =
    options.reader !== undefined && anchorResolver !== undefined
      ? new TopologyBroadcasterService(
          adaptConnectionRegistryForBroadcaster(registry),
          options.reader,
          anchorResolver,
          grpcConfig,
          logger,
          pollIntervalMs,
        )
      : null;

  return { registry, service, moduleOptions };
}

let _composition: TopologyBroadcasterComposition | null = null;

export function getTopologyBroadcasterComposition(
  options: TopologyBroadcasterFactoryOptions = {},
): TopologyBroadcasterComposition {
  if (_composition === null) {
    _composition = buildTopologyBroadcasterComposition(options);
  }
  return _composition;
}

export function resetTopologyBroadcasterCompositionForTests(): void {
  _composition = null;
}
