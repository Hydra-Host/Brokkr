import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { DynamicModule, ForwardReference, Type } from '@nestjs/common';
import type { ConnectionRegistry } from '../agent/connection-registry/connection-registry.service.js';
import type { SessionHandle } from '../agent/connection-registry/connection-registry.types.js';
import type { DispatchModuleDeps, DispatchModuleOptions } from '../agent/dispatch/dispatch.module.js';
import type {
  AgentVersionGate,
  CancelWorkEncoder,
  ConnectionRegistry as DispatcherConnectionRegistry,
  ResultPublisher as DispatcherResultPublisher,
  DispatchLogger,
} from '../agent/dispatch/dispatcher.service.js';

import { resolveOtlpTracesTarget } from '@repo/telemetry';
import type {
  AgentServicerDeps,
  AgentServicerLogger,
  AgentServicerLoggerContext,
  AgentTokenServicePort,
  AgentUpgradeServicePort,
  AuthContextPort,
  BridgeRegistryReaderPort,
  ConnectionRegistryPort,
  PeerAnchorPort,
  RedisCachePort,
  ResultPublisherPort,
  ResultsAdapterPort,
  TraceRelayPort,
} from '../agent/gateway/agent.servicer.types.js';
import {
  type AuthContextBinder,
  type AuthInterceptorLogger,
  type TokenVerifierPort,
} from '../agent/gateway/auth.interceptor.js';
import {
  GatewayModule,
  type AuthInterceptorDeps,
  type GatewayInjectToken,
  type GatewayModuleOptions,
} from '../agent/gateway/gateway.module.js';
import { getGrpcConfig } from '../agent/gateway/grpc.config.js';
import { buildEndpoints } from '../agent/topology-broadcaster/topology-broadcaster.service.js';
import type {
  BridgeEndpoint,
  BridgeSnapshot,
  HostsEntry,
} from '../agent/topology-broadcaster/topology-broadcaster.types.js';
import { getUpgradeTrigger } from '../agent/upgrade/agent-upgrade-trigger.js';
import {
  AgentUpgradeService,
  type AgentUpgradeCachePort,
  type RenderAgentYamlFn,
  type UpgradeBridgeRegistryPort,
  type UpgradeDeviceServicePort,
  type UpgradeDispatchFn,
  type UpgradeGrpcConfigPort,
  type UpgradeLogger,
  type UpgradeTokenServicePort,
} from '../agent/upgrade/agent-upgrade.service.js';
import { renderAgentYaml } from '../agent/upgrade/agent-yaml-renderer.js';
import type { AuthSubject } from '../auth/agent-token.service.js';
import { getBridgeVersion } from '../bridge-status/bridge.config.js';
import { buildAgentBundleConfig } from '../brokkr-live/agent-unit-render-startup.service.js';
import { getLeaderConfig } from '../leader-election/leader-election.config.js';
import { logDebug, logError, logInfo, logWarning, type LogContext } from '../logger/logger.service.js';
import { traceRelayEnabled } from '../telemetry/trace-relay-gate.js';

export const BRIDGE_REGISTRY_READER = Symbol('BRIDGE_REGISTRY_READER');

export const PEER_ANCHOR_RESOLVER = Symbol('PEER_ANCHOR_RESOLVER');

export const AGENT_UPGRADE_SERVICE = Symbol('AGENT_UPGRADE_SERVICE');

function buildAuthInterceptorLogger(): AuthInterceptorLogger {
  return {
    warning: (message: string) => {
      void logWarning(message, { appClassName: 'grpc-auth-interceptor' });
    },
  };
}

function buildAgentServicerLogger(): AgentServicerLogger {
  const forward =
    (emit: (message: string, context?: LogContext) => Promise<void>) =>
    (message: string, ctx?: AgentServicerLoggerContext) => {
      void emit(message, {
        appClassName: ctx?.appClassName,
        jobId: ctx?.jobId,
        appName: ctx?.appName,
        deviceId: ctx?.deviceId,
        traceId: ctx?.traceId,
        spanId: ctx?.spanId,
      });
    };
  return {
    debug: forward(logDebug),
    info: forward(logInfo),
    warning: forward(logWarning),
    error: forward(logError),
  };
}

function buildTraceRelay(): TraceRelayPort {
  return {
    isEnabled: () => traceRelayEnabled(),
    forward: async (otlpTraces) => {
      const target = resolveOtlpTracesTarget();
      if (target === undefined) return;
      const body = new ArrayBuffer(otlpTraces.byteLength);
      new Uint8Array(body).set(otlpTraces);
      const response = await fetch(target.url, {
        method: 'POST',
        headers: { ...target.headers, 'content-type': 'application/x-protobuf' },
        body,
      });
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 200);
        throw new Error(`OTLP traces endpoint returned ${response.status}${detail ? `: ${detail}` : ''}`);
      }
      await response.arrayBuffer().catch(() => undefined);
    },
  };
}

function buildDispatchLogger(): DispatchLogger {
  return {
    debug: (msg, ctx) => {
      void logInfo(msg, { jobId: ctx?.jobId ?? '', appClassName: 'grpc-dispatcher' });
    },
    info: (msg, ctx) => {
      void logInfo(msg, { jobId: ctx?.jobId ?? '', appClassName: 'grpc-dispatcher' });
    },
    warn: (msg, ctx) => {
      void logWarning(msg, { jobId: ctx?.jobId ?? '', appClassName: 'grpc-dispatcher' });
    },
  };
}

function buildNotWiredTokenVerifier(): TokenVerifierPort {
  return {
    verify: async (): Promise<AuthSubject | null> => null,
  };
}

function buildNotWiredAuthContextBinder(): AuthContextBinder {
  return {
    bind: async <T>(_subject: AuthSubject, fn: () => Promise<T>): Promise<T> => fn(),
  };
}

function buildCancelWorkEncoder(): CancelWorkEncoder {
  const TEXT_ENCODER = new TextEncoder();
  return {
    encode(workId: string, reason: string): Uint8Array {
      const w = TEXT_ENCODER.encode(workId);
      const r = TEXT_ENCODER.encode(reason);
      const out = new Uint8Array(2 + w.length + 2 + r.length);
      let off = 0;
      out[off++] = (1 << 3) | 2;
      out[off++] = w.length;
      out.set(w, off);
      off += w.length;
      out[off++] = (2 << 3) | 2;
      out[off++] = r.length;
      out.set(r, off);
      return out;
    },
  };
}

function buildAgentVersionGate(): AgentVersionGate {
  return {
    expectedVersion: () => getBridgeVersion(),
    // Lazy-bind via the upgrade-trigger holder breaks the dispatcher↔upgrade-service DI cycle; AgentUpgradeServiceModule publishes the real upgradeAgent later.
    triggerUpgrade: (args) => {
      const fn = getUpgradeTrigger();
      if (fn === null) {
        void logWarning(
          `dispatcher version-gate: upgrade requested device_id=${args.deviceId} from=${args.currentVersion} to=${args.expectedVersion} — upgrade trigger not yet published`,
          { jobId: args.jobId ?? '', appClassName: 'grpc-dispatcher' },
        );
        return;
      }
      void fn(args).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        void logWarning(
          `dispatcher version-gate: upgradeAgent dispatch failed device_id=${args.deviceId} from=${args.currentVersion} to=${args.expectedVersion}: ${message}`,
          { jobId: args.jobId ?? '', appClassName: 'grpc-dispatcher' },
        );
      });
    },
  };
}

export function adaptBridgeRegistryReader(reader: {
  getAllBridgeHostnames(jobId: string): Promise<readonly string[]>;
  getBridgeRegistrySnapshot(jobId: string): Promise<BridgeSnapshot>;
}): BridgeRegistryReaderPort {
  return {
    getAllBridgeHostnames: () => reader.getAllBridgeHostnames(''),
    getBridgeRegistrySnapshot: () => reader.getBridgeRegistrySnapshot(''),
  };
}

function buildSessionAcceptedMessage(args: {
  bridgeId: string;
  topology: readonly { address: string; bridgeId: string }[];
  agentVersion: string;
}): unknown {
  return {
    sessionAccepted: {
      bridgeId: args.bridgeId,
      topology: args.topology,
      agentVersion: args.agentVersion,
    },
  };
}

function buildTopologyUpdateMessage(args: {
  bridges: readonly BridgeEndpoint[];
  hostsEntries: readonly HostsEntry[];
}): unknown {
  return {
    topologyUpdate: {
      bridges: args.bridges,
      hostsEntries: args.hostsEntries,
    },
  };
}

function buildBundleChunk(args: { data: Uint8Array }): unknown {
  return { data: args.data };
}

export interface AutoCollectionPort {
  maybeEnqueueCollectionOnRegister(deviceId: string, options?: { jobId?: string }): Promise<void>;
}

export interface AgentServicerCollaborators {
  registry: ConnectionRegistryPort;
  publisher: ResultPublisherPort;
  tokenService: AgentTokenServicePort;
  authContext: AuthContextPort;
  bridgeRegistryReader: BridgeRegistryReaderPort;
  peerAnchorResolver: PeerAnchorPort;
  redisCache: RedisCachePort;
  results: ResultsAdapterPort;
  upgradeService: AgentUpgradeServicePort;
  autoCollection: AutoCollectionPort;
}

export function buildAgentServicerDepsFromInjected(collaborators: AgentServicerCollaborators): AgentServicerDeps {
  return {
    registry: collaborators.registry,
    publisher: collaborators.publisher,
    tokenService: collaborators.tokenService,
    upgradeService: collaborators.upgradeService,
    authContext: collaborators.authContext,
    bridgeRegistryReader: collaborators.bridgeRegistryReader,
    peerAnchorResolver: collaborators.peerAnchorResolver,
    buildEndpoints,
    maybeEnqueueCollectionOnRegister: (deviceId) =>
      collaborators.autoCollection.maybeEnqueueCollectionOnRegister(deviceId),
    results: collaborators.results,
    agentVersionConfig: { expectedAgentVersion: getBridgeVersion() },
    grpcConfig: getGrpcConfig(),
    leaderConfig: { instanceId: getLeaderConfig().instanceId },
    bundleConfig: buildAgentBundleConfig(),
    redisCache: collaborators.redisCache,
    readFile: (path: string) => readFile(path),
    logger: buildAgentServicerLogger(),
    traceRelay: buildTraceRelay(),
    buildSessionAcceptedMessage,
    buildTopologyUpdateMessage,
    buildBundleChunk,
  };
}

export interface AgentUpgradeServiceCollaborators {
  cache: AgentUpgradeCachePort;
  dispatch: UpgradeDispatchFn;
  deviceService: UpgradeDeviceServicePort;
  tokenService: UpgradeTokenServicePort;
  bridgeRegistry: UpgradeBridgeRegistryPort;
  grpcConfig?: UpgradeGrpcConfigPort;
  renderAgentYaml?: RenderAgentYamlFn;
  bundleSha256?: () => Promise<string>;
  unitSha256?: () => Promise<string>;
  logger?: UpgradeLogger;
}

async function sha256OfFileOrEmpty(path: string): Promise<string> {
  try {
    const bytes = await readFile(path);
    return createHash('sha256').update(bytes).digest('hex');
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

function buildAgentUpgradeLogger(): UpgradeLogger {
  return {
    info: (message, ctx) => {
      void logInfo(message, { jobId: ctx?.jobId ?? '', appClassName: 'agent-upgrade-service' });
    },
    warning: (message, ctx) => {
      void logWarning(message, { jobId: ctx?.jobId ?? '', appClassName: 'agent-upgrade-service' });
    },
  };
}

export function buildAgentUpgradeService(collaborators: AgentUpgradeServiceCollaborators): AgentUpgradeServicePort {
  const bundleCfg = buildAgentBundleConfig();
  const service = new AgentUpgradeService({
    cache: collaborators.cache,
    dispatch: collaborators.dispatch,
    deviceService: collaborators.deviceService,
    tokenService: collaborators.tokenService,
    bridgeRegistry: collaborators.bridgeRegistry,
    grpcConfig: collaborators.grpcConfig ?? getGrpcConfig(),
    renderAgentYaml: collaborators.renderAgentYaml ?? renderAgentYaml,
    bundleSha256: collaborators.bundleSha256 ?? (() => sha256OfFileOrEmpty(bundleCfg.bundlePath)),
    unitSha256: collaborators.unitSha256 ?? (() => sha256OfFileOrEmpty(bundleCfg.unitPath)),
    logger: collaborators.logger ?? buildAgentUpgradeLogger(),
  });
  return {
    upgradeAgent: async (args) => {
      await service.upgradeAgent(args);
    },
  };
}

export function buildAuthInterceptorDepsFromInjected(
  injected: {
    tokenService?: TokenVerifierPort;
    binder?: AuthContextBinder;
    logger?: AuthInterceptorLogger;
  } = {},
): AuthInterceptorDeps {
  return {
    tokenService: injected.tokenService ?? buildNotWiredTokenVerifier(),
    binder: injected.binder ?? buildNotWiredAuthContextBinder(),
    logger: injected.logger ?? buildAuthInterceptorLogger(),
  };
}

export interface GatewayModuleDeps {
  tokenServiceToken: GatewayInjectToken;
  authContextServiceToken: GatewayInjectToken;
  connectionRegistryToken: GatewayInjectToken;
  resultPublisherToken: GatewayInjectToken;
  bridgeRegistryReaderToken: GatewayInjectToken;
  peerAnchorResolverToken: GatewayInjectToken;
  resultsAdapterToken: GatewayInjectToken;
  redisCacheToken: GatewayInjectToken;
  agentUpgradeServiceToken: GatewayInjectToken;
  autoCollectionServiceToken: GatewayInjectToken;
  imports?: Array<Type<unknown> | DynamicModule | Promise<DynamicModule> | ForwardReference>;
}

export function buildGatewayModuleOptions(deps: GatewayModuleDeps): GatewayModuleOptions {
  return {
    imports: deps.imports,
    agentServicerDeps: (
      registry: unknown,
      publisher: unknown,
      tokenService: unknown,
      authContext: unknown,
      bridgeRegistryReader: unknown,
      redisCache: unknown,
      results: unknown,
      upgradeService: unknown,
      autoCollection: unknown,
      peerAnchorResolver: unknown,
    ) =>
      buildAgentServicerDepsFromInjected({
        registry: registry as ConnectionRegistryPort,
        publisher: publisher as ResultPublisherPort,
        tokenService: tokenService as AgentTokenServicePort,
        authContext: authContext as AuthContextPort,
        bridgeRegistryReader: bridgeRegistryReader as BridgeRegistryReaderPort,
        redisCache: redisCache as RedisCachePort,
        results: results as ResultsAdapterPort,
        upgradeService: upgradeService as AgentUpgradeServicePort,
        autoCollection: autoCollection as AutoCollectionPort,
        peerAnchorResolver: peerAnchorResolver as PeerAnchorPort,
      }),
    agentServicerDepsInject: [
      deps.connectionRegistryToken,
      deps.resultPublisherToken,
      deps.tokenServiceToken,
      deps.authContextServiceToken,
      deps.bridgeRegistryReaderToken,
      deps.redisCacheToken,
      deps.resultsAdapterToken,
      deps.agentUpgradeServiceToken,
      deps.autoCollectionServiceToken,
      deps.peerAnchorResolverToken,
    ],
    authInterceptorDeps: (tokenService: unknown, binder: unknown): AuthInterceptorDeps =>
      buildAuthInterceptorDepsFromInjected({
        tokenService: tokenService as TokenVerifierPort,
        binder: binder as AuthContextBinder,
      }),
    authInterceptorDepsInject: [deps.tokenServiceToken, deps.authContextServiceToken],
  };
}

export interface DispatchModuleDepsTokens {
  connectionRegistryToken: GatewayInjectToken;
  resultPublisherToken: GatewayInjectToken;
  imports?: Array<Type<unknown> | DynamicModule | Promise<DynamicModule> | ForwardReference>;
}

export function buildDispatchModuleOptions(deps: DispatchModuleDepsTokens): DispatchModuleOptions {
  return {
    imports: deps.imports,
    deps: (registry: unknown, publisher: unknown): DispatchModuleDeps => ({
      registry: registry as DispatcherConnectionRegistry,
      publisher: publisher as DispatcherResultPublisher,
      logger: buildDispatchLogger(),
      versionGate: buildAgentVersionGate(),
      cancelEncoder: buildCancelWorkEncoder(),
    }),
    inject: [deps.connectionRegistryToken, deps.resultPublisherToken],
  };
}

export { GatewayModule };
export type { AuthInterceptorDeps, ConnectionRegistry, GatewayModuleOptions, SessionHandle };
