import type { AuthSubject } from '../../auth/agent-token.service';
import type { SessionHandle } from '../connection-registry/connection-registry.types';
import type {
  BridgeEndpoint,
  BridgeSnapshot,
  HostsEntry,
  PeerAnchorPort,
} from '../topology-broadcaster/topology-broadcaster.types';

export type { PeerAnchorPort };

export enum GrpcStatusCode {
  OK = 0,
  CANCELLED = 1,
  UNKNOWN = 2,
  INVALID_ARGUMENT = 3,
  DEADLINE_EXCEEDED = 4,
  NOT_FOUND = 5,
  ALREADY_EXISTS = 6,
  PERMISSION_DENIED = 7,
  RESOURCE_EXHAUSTED = 8,
  FAILED_PRECONDITION = 9,
  ABORTED = 10,
  OUT_OF_RANGE = 11,
  UNIMPLEMENTED = 12,
  INTERNAL = 13,
  UNAVAILABLE = 14,
  DATA_LOSS = 15,
  UNAUTHENTICATED = 16,
}

export interface ServicerContextLike {
  abort(code: GrpcStatusCode, message: string): Promise<never>;
  peer(): string | null | undefined;
  metadata?(key: string): readonly unknown[];
  onCancelled?(cb: () => void): void;
}

export enum WorkResponseStatus {
  STATUS_UNSPECIFIED = 0,
  STATUS_SUCCESS = 1,
  STATUS_FAILURE = 2,
  STATUS_ALREADY_IN_PROGRESS = 3,
}

export enum PartialResultStatus {
  STATUS_UNSPECIFIED = 0,
  STATUS_SUCCESS = 1,
  STATUS_FAILURE = 2,
}

export enum Readiness {
  READINESS_UNSPECIFIED = 0,
  READINESS_READY = 1,
  READINESS_BUSY = 2,
  READINESS_DEGRADED = 3,
}

export enum BundleArtifact {
  ARTIFACT_UNSPECIFIED = 0,
  ARTIFACT_BUNDLE = 1,
  ARTIFACT_UNIT = 2,
  ARTIFACT_CONFIG = 3,
}

export interface AgentRegistrationRequest {
  protocolVersion: number;
  deviceId: string;
  agentVersion: string;
  readiness: number;
}

export interface OperationErrorWire {
  code: string;
  message: string;
  detailsJson: string;
}

export interface WorkResponseRequest {
  workId: string;
  status: number;
  output?: Uint8Array;
  error?: OperationErrorWire;
}

export interface WorkProgressRequest {
  workId: string;
  progress: number;
  message: string;
}

export interface PartialResultRequest {
  workId: string;
  status: number;
  unit: string;
  data: string;
  error?: OperationErrorWire;
  duration?: { seconds: string | number; nanos: number };
}

export interface LogEntryRequest {
  level: string;
  message: string;
  fieldsJson: string;
}

export interface LogBatchRequest {
  deviceId: string;
  entries: readonly LogEntryRequest[];
}

export interface TraceBatchRequest {
  deviceId: string;
  otlpTraces: Uint8Array;
}

export interface PhoneHomeRequestMsg {
  bootId: string;
  deviceId?: string;
}

export interface BundleRequestMsg {
  artifact: number;
  sha256: string;
}

export interface RenewTokenRequestMsg {
  _empty?: never;
}

export interface SessionAcceptedMsg {
  bridgeId: string;
  topology: readonly { address: string; bridgeId: string }[];
  agentVersion: string;
}

export interface ServerMessage {
  sessionAccepted?: SessionAcceptedMsg;
}

export interface BundleChunkMsg {
  data: Uint8Array;
}

export interface ReportResultAck {
  _empty?: never;
}
export interface ReportProgressAck {
  _empty?: never;
}
export interface ReportPartialResultAck {
  _empty?: never;
}
export interface ReportLogsAck {
  _empty?: never;
}
export interface ReportTracesAck {
  _empty?: never;
}
export interface PhoneHomeAck {
  _empty?: never;
}
export interface RenewTokenAck {
  newExpiresInS: number;
}

export interface AuthContextPort {
  currentSubject(): AuthSubject | null;
}

export interface ConnectionRegistryPort {
  register(
    deviceId: string,
    opts: { agentVersion: string; readiness: string; peerIp: string | null },
  ): Promise<SessionHandle>;
  unregister(deviceId: string, handle: SessionHandle): Promise<void>;
}

export interface ResultPublisherPort {
  getDispatchMeta(workId: string): Promise<Record<string, unknown> | null>;
  publishResult(workId: string, responseBytes: Buffer | Uint8Array): Promise<void>;
  publishProgress(workId: string, progress: number, message: string): Promise<void>;
  publishPartial(workId: string, partialBytes: Buffer | Uint8Array): Promise<void>;
}

export interface AgentTokenServicePort {
  slideDeviceTtl(deviceId: string): Promise<boolean>;
  readonly deviceTtlS: number;
}

export { AgentUpgradeRateLimited } from '../upgrade/agent-upgrade.service';

export interface AgentUpgradeServicePort {
  upgradeAgent(args: {
    deviceId: string;
    currentVersion: string;
    expectedVersion: string;
    jobId: string | null;
  }): Promise<void>;
}

export interface BridgeRegistryReaderPort {
  getAllBridgeHostnames(): Promise<readonly string[]>;
  getBridgeRegistrySnapshot(): Promise<BridgeSnapshot>;
}

export type BuildEndpointsFn = (hostnames: Iterable<string>, port: number) => readonly BridgeEndpoint[];

export type MaybeEnqueueCollectionFn = (deviceId: string) => Promise<void>;

export interface ResultsAdapterPort {
  enqueuePhoneHome(args: { deviceId: string; bootId: string }): Promise<boolean>;
  writeCollectorToResultsCache(args: {
    deviceId: string;
    collector: string;
    data: unknown;
  }): Promise<{ ok: boolean; kept: number }>;
}

export interface AgentVersionConfigPort {
  readonly expectedAgentVersion: string;
}
export interface GrpcConfigPort {
  readonly externalPort: number;
}
export interface LeaderConfigPort {
  readonly instanceId: string;
}
export interface AgentBundleConfigPort {
  readonly bundlePath: string;
  readonly unitPath: string;
}

export interface RedisCachePort {
  secretGet(key: string): Promise<string | null>;
}

export type ReadFileFn = (path: string) => Promise<Buffer>;

export interface AgentServicerLoggerContext {
  appClassName?: string;
  jobId?: string;
  appName?: string;
  deviceId?: string;
  traceId?: string;
  spanId?: string;
}

export interface AgentServicerLogger {
  debug(msg: string, ctx?: AgentServicerLoggerContext): void | Promise<void>;
  info(msg: string, ctx?: AgentServicerLoggerContext): void | Promise<void>;
  warning(msg: string, ctx?: AgentServicerLoggerContext): void | Promise<void>;
  error(msg: string, ctx?: AgentServicerLoggerContext): void | Promise<void>;
}

export interface TraceRelayPort {
  isEnabled(): boolean;
  forward(otlpTraces: Uint8Array): Promise<void>;
}

export interface AgentServicerDeps {
  registry: ConnectionRegistryPort;
  publisher: ResultPublisherPort;
  tokenService: AgentTokenServicePort;
  upgradeService: AgentUpgradeServicePort;
  authContext: AuthContextPort;
  bridgeRegistryReader: BridgeRegistryReaderPort;
  peerAnchorResolver: PeerAnchorPort;
  buildEndpoints: BuildEndpointsFn;
  maybeEnqueueCollectionOnRegister: MaybeEnqueueCollectionFn;
  results: ResultsAdapterPort;
  agentVersionConfig: AgentVersionConfigPort;
  grpcConfig: GrpcConfigPort;
  leaderConfig: LeaderConfigPort;
  bundleConfig: AgentBundleConfigPort;
  redisCache: RedisCachePort;
  readFile: ReadFileFn;
  logger: AgentServicerLogger;
  traceRelay: TraceRelayPort;
  buildSessionAcceptedMessage(args: {
    bridgeId: string;
    topology: readonly BridgeEndpoint[];
    agentVersion: string;
  }): unknown;
  buildTopologyUpdateMessage(args: {
    bridges: readonly BridgeEndpoint[];
    hostsEntries: readonly HostsEntry[];
  }): unknown;
  buildBundleChunk(args: { data: Uint8Array }): unknown;
}
