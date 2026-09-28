import { createHash } from 'node:crypto';
import { getErrorMessage } from '../../common/error-utils';

import { Injectable } from '@nestjs/common';

import type { DeviceSubject, DiscoverySubject } from '../../auth/agent-token.service';
import { NIL_DEVICE_ID } from '../../constants';
import { normalizeAgentLogEntry } from '../../logger/context/agent-log-normalize';
import { REPORTLOGS_MAX_FIELDS_JSON_BYTES, type AgentLogEmitter } from '../../logger/context/logging-context.constants';
import { coerceEnvelopeId, hasEnvelopeId } from '../../saga-framework/dispatch-payload';
import { pythonTruthy } from '../../saga-framework/truthiness';
import {
  createSessionHandle,
  QUEUE_GET_CANCELLED,
  type SessionHandle,
} from '../connection-registry/connection-registry.types';
import { encodePartialResult, encodeWorkResponse } from '../dispatch/protobuf-codec';
import { parsePeerIp } from '../servicer/peer-parse';
import { hostsEntriesForPeer } from '../topology-broadcaster/topology-broadcaster.service';
import type { BridgeSnapshot } from '../topology-broadcaster/topology-broadcaster.types';

import {
  AgentUpgradeRateLimited,
  BundleArtifact,
  GrpcStatusCode,
  PartialResultStatus,
  Readiness,
  WorkResponseStatus,
  type AgentRegistrationRequest,
  type AgentServicerDeps,
  type BundleChunkMsg,
  type BundleRequestMsg,
  type LogBatchRequest,
  type PartialResultRequest,
  type PhoneHomeAck,
  type PhoneHomeRequestMsg,
  type RenewTokenAck,
  type RenewTokenRequestMsg,
  type ReportLogsAck,
  type ReportPartialResultAck,
  type ReportProgressAck,
  type ReportResultAck,
  type ReportTracesAck,
  type ServerMessage,
  type ServicerContextLike,
  type TraceBatchRequest,
  type WorkProgressRequest,
  type WorkResponseRequest,
} from './agent.servicer.types';

// Must match the constant in agent.proto; bump in lockstep with envelope changes.
export const SUPPORTED_PROTOCOL_VERSION = 1;

const REPORTLOGS_MAX_ENTRIES = 1000;

const REPORTTRACES_MAX_BYTES = 1024 * 1024;

// boot_id is caller-controlled and forwarded verbatim to hub payloads + logs; reject over-length or control-char values (log/payload injection).
const MAX_BOOT_ID_LENGTH = 128;
// eslint-disable-next-line no-control-regex -- intentional: detect control bytes in boot_id
const BOOT_ID_CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

function isValidBootId(bootId: string): boolean {
  return bootId.length > 0 && bootId.length <= MAX_BOOT_ID_LENGTH && !BOOT_ID_CONTROL_CHAR_RE.test(bootId);
}

const COLLECTOR_UNIT_RE = /^[a-z][a-z0-9_]{0,63}\n?$/;

const FETCH_BUNDLE_CHUNK_SIZE = 64 * 1024;

function wireBytes(v: unknown): Uint8Array {
  if (v === undefined || v === null) return new Uint8Array();
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'string') return new TextEncoder().encode(v);
  return Uint8Array.from(v as ArrayLike<number>);
}

function wireError(e?: { code?: string; message?: string; detailsJson?: string }): {
  code: string;
  message: string;
  detailsJson: string;
} {
  return {
    code: e?.code ?? '',
    message: e?.message ?? '',
    detailsJson: e?.detailsJson ?? '',
  };
}

function wireDuration(d?: { seconds: string | number; nanos: number }): { seconds: number; nanos: number } {
  return { seconds: d ? Number(d.seconds) : 0, nanos: d?.nanos ?? 0 };
}

export function classifyCollectorPartial(
  status: number,
  successStatus: number,
  unit: string,
  data: string,
): 'accept' | 'skip_non_success' | 'skip_empty' | 'skip_bad_unit' {
  if (status !== successStatus) return 'skip_non_success';
  if (!unit || !data) return 'skip_empty';
  if (!COLLECTOR_UNIT_RE.test(unit)) return 'skip_bad_unit';
  return 'accept';
}

const EMITTER_TO_LOGGER_METHOD: Record<AgentLogEmitter, 'debug' | 'info' | 'warning' | 'error'> = {
  log_debug: 'debug',
  log_info: 'info',
  log_warning: 'warning',
  log_error: 'error',
};

function readinessName(value: number): string {
  switch (value) {
    case Readiness.READINESS_UNSPECIFIED:
      return 'READINESS_UNSPECIFIED';
    case Readiness.READINESS_READY:
      return 'READINESS_READY';
    case Readiness.READINESS_BUSY:
      return 'READINESS_BUSY';
    case Readiness.READINESS_DEGRADED:
      return 'READINESS_DEGRADED';
    default:
      throw new RangeError(`unknown Readiness value: ${value}`);
  }
}

function isSubjectDevice(subject: unknown): subject is DeviceSubject {
  return typeof subject === 'object' && subject !== null && (subject as { kind?: unknown }).kind === 'device';
}

function isSubjectDiscovery(subject: unknown): subject is DiscoverySubject {
  return typeof subject === 'object' && subject !== null && (subject as { kind?: unknown }).kind === 'discovery';
}

function sha256Hex(buf: Buffer | Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';
}

@Injectable()
export class AgentServicer {
  constructor(private readonly deps: AgentServicerDeps) {}

  private resolveBridgeId(): string {
    return this.deps.leaderConfig.instanceId;
  }

  async _auto_upgrade(args: { deviceId: string; currentVersion: string; expectedVersion: string }): Promise<void> {
    try {
      await this.deps.upgradeService.upgradeAgent({
        deviceId: args.deviceId,
        currentVersion: args.currentVersion,
        expectedVersion: args.expectedVersion,
        jobId: null,
      });
    } catch (exc) {
      if (exc instanceof AgentUpgradeRateLimited) {
        await this.deps.logger.debug(`auto-upgrade skipped — cooldown active device_id=${args.deviceId}`);
        return;
      }
      await this.deps.logger.warning(
        `auto-upgrade failed device_id=${args.deviceId} from=${args.currentVersion} to=${args.expectedVersion}: ${getErrorMessage(exc)}`,
      );
    }
  }

  async *OpenSession(request: AgentRegistrationRequest, context: ServicerContextLike): AsyncIterable<unknown> {
    if (request.protocolVersion !== SUPPORTED_PROTOCOL_VERSION) {
      await context.abort(
        GrpcStatusCode.FAILED_PRECONDITION,
        `unsupported protocol_version ${request.protocolVersion}; bridge speaks ${SUPPORTED_PROTOCOL_VERSION}`,
      );
      return;
    }

    const subject = this.deps.authContext.currentSubject();
    let effectiveDeviceId: string;
    if (isSubjectDevice(subject)) {
      if (request.deviceId !== subject.deviceId) {
        await context.abort(
          GrpcStatusCode.PERMISSION_DENIED,
          `registration device_id=${request.deviceId} does not match authenticated device_id=${subject.deviceId}`,
        );
        return;
      }
      effectiveDeviceId = subject.deviceId;
    } else if (isSubjectDiscovery(subject)) {
      if (request.deviceId !== NIL_DEVICE_ID) {
        await context.abort(
          GrpcStatusCode.PERMISSION_DENIED,
          `discovery tokens may only register as the nil UUID, got ${request.deviceId}`,
        );
        return;
      }
      effectiveDeviceId = NIL_DEVICE_ID;
    } else {
      await context.abort(GrpcStatusCode.PERMISSION_DENIED, 'OpenSession requires a device or discovery token');
      return;
    }

    let readinessNameValue: string;
    if (request.readiness) {
      try {
        readinessNameValue = readinessName(request.readiness);
      } catch {
        readinessNameValue = 'READINESS_READY';
      }
    } else {
      readinessNameValue = 'READINESS_READY';
    }
    const readinessStr = readinessNameValue.replace(/^READINESS_/, '').toLowerCase();
    const metadata = context.metadata;
    const peerIp = parsePeerIp(context.peer(), metadata === undefined ? undefined : (key) => metadata(key));
    const handle = await this.deps.registry.register(effectiveDeviceId, {
      agentVersion: request.agentVersion,
      readiness: readinessStr,
      peerIp,
    });
    context.onCancelled?.(() => handle.cancelled.set());
    await this.deps.logger.info(
      `host client connected device_id=${effectiveDeviceId} agent_version=${request.agentVersion}`,
    );

    const expectedVersion = this.deps.agentVersionConfig.expectedAgentVersion;
    if (request.agentVersion && expectedVersion && request.agentVersion !== expectedVersion) {
      void this._auto_upgrade({
        deviceId: effectiveDeviceId,
        currentVersion: request.agentVersion,
        expectedVersion,
      });
    }

    this.deps.maybeEnqueueCollectionOnRegister(effectiveDeviceId).catch((exc: unknown) => {
      void this.deps.logger.warning(
        `auto-collection enqueue failed for device ${effectiveDeviceId}: ${getErrorMessage(exc)}`,
      );
    });

    // Discovery tokens deliberately do NOT renew. Best-effort: failure does not block the session.
    if (isSubjectDevice(subject)) {
      try {
        await this.deps.tokenService.slideDeviceTtl(effectiveDeviceId);
      } catch (exc) {
        await this.deps.logger.warning(
          `OpenSession token slide failed device_id=${effectiveDeviceId}: ${getErrorMessage(exc)}`,
        );
      }
    }

    let registrySnapshot: BridgeSnapshot;
    try {
      registrySnapshot = await this.deps.bridgeRegistryReader.getBridgeRegistrySnapshot();
    } catch (exc) {
      await this.deps.logger.warning(`SessionAccepted: failed to fetch bridge topology: ${getErrorMessage(exc)}`);
      registrySnapshot = [];
    }
    const hostnames = [...new Set(registrySnapshot.map(([hostname]) => hostname))].sort();
    const topology = this.deps.buildEndpoints(hostnames, this.deps.grpcConfig.externalPort);
    const { hostsEntries, missingBridges } = await hostsEntriesForPeer(
      peerIp,
      registrySnapshot,
      this.deps.peerAnchorResolver,
    );
    if (missingBridges.length > 0) {
      await this.deps.logger.warning(
        `SessionAccepted: partial hostsEntries device_id=${effectiveDeviceId} peer=${peerIp} unresolved bridges=[${missingBridges.join(', ')}]`,
      );
    }

    try {
      yield this.deps.buildSessionAcceptedMessage({
        bridgeId: this.resolveBridgeId(),
        topology,
        agentVersion: this.deps.agentVersionConfig.expectedAgentVersion,
      });
      yield this.deps.buildTopologyUpdateMessage({ bridges: topology, hostsEntries });

      while (true) {
        if (handle.cancelled.isSet()) {
          await this.deps.logger.debug(`session cancelled externally device_id=${effectiveDeviceId}; closing stream`);
          return;
        }
        const msg = await handle.queue.getOrCancel(handle.cancelled);
        if (msg === QUEUE_GET_CANCELLED) {
          continue;
        }
        if (!isServerMessageShape(msg)) {
          await this.deps.logger.warning(
            `dropping unexpected queue item on device_id=${effectiveDeviceId}: type=${typeName(msg)}`,
          );
          continue;
        }
        yield msg;
      }
    } catch (exc) {
      if (isCancelledError(exc)) {
        await this.deps.logger.info(`agent OpenSession cancelled device_id=${effectiveDeviceId}`);
        throw exc;
      }
      throw exc;
    } finally {
      // Flip cancelled BEFORE unregister so concurrent dispatchers see the handle as stale immediately.
      handle.cancelled.set();
      await this.deps.registry.unregister(effectiveDeviceId, handle);
      await this.deps.logger.info(`agent OpenSession closed device_id=${effectiveDeviceId}`);
    }
  }

  /** Defence-in-depth ownership check; returns false after PERMISSION_DENIED abort — caller must return immediately. */
  async _verify_work_id_owned_by_caller(
    publisher: AgentServicerDeps['publisher'],
    workId: string,
    subject: DeviceSubject,
    context: ServicerContextLike,
    rpcName: string,
  ): Promise<boolean> {
    let meta: unknown;
    try {
      meta = await publisher.getDispatchMeta(workId);
    } catch (exc) {
      await this.deps.logger.warning(
        `${rpcName} dispatch-meta lookup failed work_id=${workId}: ${getErrorMessage(exc)}`,
      );
      return true;
    }
    if (meta === null) {
      await this.deps.logger.warning(
        `${rpcName}: no dispatch meta for work_id=${workId} from device_id=${subject.deviceId}; rejecting (fail closed)`,
      );
      await context.abort(
        GrpcStatusCode.PERMISSION_DENIED,
        `no dispatch metadata found for work_id=${workId}; cannot verify ownership`,
      );
      return false;
    }
    if (typeof meta !== 'object' || Array.isArray(meta)) {
      throw new TypeError(`Expected a plain object but received ${Array.isArray(meta) ? 'array' : typeof meta}`);
    }
    const rawDeviceId = (meta as Record<string, unknown>)['device_id'];
    const metaDevice = coerceEnvelopeId(rawDeviceId);
    if (pythonTruthy(rawDeviceId) && metaDevice !== subject.deviceId) {
      await this.deps.logger.warning(
        `${rpcName}: work_id=${workId} dispatched to device_id=${String(metaDevice)} but caller authenticated as device_id=${subject.deviceId}`,
      );
      await context.abort(
        GrpcStatusCode.PERMISSION_DENIED,
        `work_id does not belong to authenticated device_id=${subject.deviceId}`,
      );
      return false;
    }
    return true;
  }

  async ReportResult(request: WorkResponseRequest, context: ServicerContextLike): Promise<ReportResultAck> {
    const subject = this.deps.authContext.currentSubject();
    if (!isSubjectDevice(subject)) {
      await context.abort(GrpcStatusCode.PERMISSION_DENIED, 'device-kind token required');
      return {};
    }

    const publisher = this.deps.publisher;
    if (!(await this._verify_work_id_owned_by_caller(publisher, request.workId, subject, context, 'ReportResult'))) {
      return {};
    }

    if (request.status === WorkResponseStatus.STATUS_ALREADY_IN_PROGRESS) {
      await this.deps.logger.info(
        `ReportResult: duplicate dispatch deflected work_id=${request.workId} device_id=${subject.deviceId}; not writing to terminal-result key`,
      );
      return {};
    }

    try {
      const responseBytes = encodeWorkResponse({
        workId: request.workId,
        status: request.status,
        output: wireBytes(request.output),
        error: wireError(request.error),
      });
      await publisher.publishResult(request.workId, Buffer.from(responseBytes));
    } catch (exc) {
      await this.deps.logger.warning(`publish_result failed work_id=${request.workId}: ${getErrorMessage(exc)}`);
      await context.abort(GrpcStatusCode.INTERNAL, 'failed to persist result');
    }
    return {};
  }

  async ReportProgress(request: WorkProgressRequest, context: ServicerContextLike): Promise<ReportProgressAck> {
    const subject = this.deps.authContext.currentSubject();
    if (!isSubjectDevice(subject)) {
      await context.abort(GrpcStatusCode.PERMISSION_DENIED, 'device-kind token required');
      return {};
    }

    const publisher = this.deps.publisher;
    if (!(await this._verify_work_id_owned_by_caller(publisher, request.workId, subject, context, 'ReportProgress'))) {
      return {};
    }

    try {
      await publisher.publishProgress(request.workId, request.progress, request.message);
    } catch (exc) {
      await this.deps.logger.debug(
        `publish_progress swallowed error work_id=${request.workId}: ${getErrorMessage(exc)}`,
      );
    }
    return {};
  }

  async ReportPartialResult(
    request: PartialResultRequest,
    context: ServicerContextLike,
  ): Promise<ReportPartialResultAck> {
    const subject = this.deps.authContext.currentSubject();
    if (!isSubjectDevice(subject)) {
      await context.abort(GrpcStatusCode.PERMISSION_DENIED, 'device-kind token required');
      return {};
    }

    const publisher = this.deps.publisher;
    if (
      !(await this._verify_work_id_owned_by_caller(publisher, request.workId, subject, context, 'ReportPartialResult'))
    ) {
      return {};
    }

    try {
      const partialBytes = encodePartialResult({
        workId: request.workId,
        unit: request.unit,
        status: request.status,
        data: wireBytes(request.data),
        error: wireError(request.error),
        duration: wireDuration(request.duration),
      });
      await publisher.publishPartial(request.workId, Buffer.from(partialBytes));
    } catch (exc) {
      await this.deps.logger.warning(
        `publish_partial failed work_id=${request.workId} unit=${request.unit}: ${getErrorMessage(exc)}`,
      );
      await context.abort(GrpcStatusCode.INTERNAL, 'failed to persist partial result');
    }

    await this._maybe_cache_collector_partial(request, publisher);

    return {};
  }

  async RenewToken(_request: RenewTokenRequestMsg, context: ServicerContextLike): Promise<RenewTokenAck> {
    const subject = this.deps.authContext.currentSubject();
    if (!isSubjectDevice(subject)) {
      await context.abort(GrpcStatusCode.PERMISSION_DENIED, 'device-kind token required');
      return { newExpiresInS: 0 };
    }

    let slid: boolean;
    try {
      slid = await this.deps.tokenService.slideDeviceTtl(subject.deviceId);
    } catch (exc) {
      await this.deps.logger.warning(`RenewToken slide failed device_id=${subject.deviceId}: ${getErrorMessage(exc)}`);
      await context.abort(GrpcStatusCode.INTERNAL, 'failed to renew token');
      return { newExpiresInS: 0 };
    }

    if (!slid) {
      // Hash index exists but device index is missing — mid-revoke race or half-successful mint; treat as expired.
      await this.deps.logger.warning(
        `RenewToken: device index missing for device_id=${subject.deviceId}; rejecting as if token were expired`,
      );
      await context.abort(GrpcStatusCode.UNAUTHENTICATED, 'token has no device-index record; reboot to re-bootstrap');
      return { newExpiresInS: 0 };
    }

    return { newExpiresInS: this.deps.tokenService.deviceTtlS };
  }

  async ReportLogs(request: LogBatchRequest, context: ServicerContextLike): Promise<ReportLogsAck> {
    const subject = this.deps.authContext.currentSubject();
    if (!isSubjectDevice(subject)) {
      await context.abort(GrpcStatusCode.PERMISSION_DENIED, 'device-kind token required');
      return {};
    }

    const claimed = request.deviceId;
    if (claimed && claimed !== subject.deviceId) {
      await context.abort(
        GrpcStatusCode.PERMISSION_DENIED,
        `report device_id=${claimed} does not match authenticated device_id=${subject.deviceId}`,
      );
      return {};
    }

    const effectiveDeviceId = subject.deviceId;

    if (request.entries.length > REPORTLOGS_MAX_ENTRIES) {
      await this.deps.logger.warning(
        `ReportLogs batch exceeded entry cap device_id=${effectiveDeviceId} entries=${request.entries.length} cap=${REPORTLOGS_MAX_ENTRIES}`,
      );
      await context.abort(
        GrpcStatusCode.RESOURCE_EXHAUSTED,
        `LogBatch entries ${request.entries.length} exceeds cap ${REPORTLOGS_MAX_ENTRIES}`,
      );
      return {};
    }

    const deviceId = effectiveDeviceId;
    for (const entry of request.entries) {
      const normalized = normalizeAgentLogEntry({
        level: entry.level,
        message: entry.message,
        fieldsJson: entry.fieldsJson,
        deviceId,
      });
      if (normalized.fieldsJsonTruncated) {
        await this.deps.logger.warning(
          `ReportLogs entry exceeded fields_json byte cap device_id=${effectiveDeviceId} bytes=${normalized.fieldsJsonBytes} cap=${REPORTLOGS_MAX_FIELDS_JSON_BYTES}; skipping json.loads`,
        );
      }
      await this.deps.logger[EMITTER_TO_LOGGER_METHOD[normalized.emitter]](normalized.message, {
        appClassName: normalized.appClassName,
        jobId: normalized.jobId,
        appName: 'bridge-agent',
        deviceId: effectiveDeviceId,
        traceId: normalized.traceId,
        spanId: normalized.spanId,
      });
    }
    return {};
  }

  /** Best-effort by design: disabled telemetry and forward failures both ack so a down collector never turns into a device-fleet retry storm. */
  async ReportTraces(request: TraceBatchRequest, context: ServicerContextLike): Promise<ReportTracesAck> {
    const subject = this.deps.authContext.currentSubject();
    if (!isSubjectDevice(subject)) {
      await context.abort(GrpcStatusCode.PERMISSION_DENIED, 'device-kind token required');
      return {};
    }

    const claimed = request.deviceId;
    if (claimed && claimed !== subject.deviceId) {
      await context.abort(
        GrpcStatusCode.PERMISSION_DENIED,
        `trace batch device_id=${claimed} does not match authenticated device_id=${subject.deviceId}`,
      );
      return {};
    }

    if (request.otlpTraces.byteLength > REPORTTRACES_MAX_BYTES) {
      await this.deps.logger.warning(
        `ReportTraces batch exceeded byte cap device_id=${subject.deviceId} bytes=${request.otlpTraces.byteLength} cap=${REPORTTRACES_MAX_BYTES}`,
      );
      await context.abort(
        GrpcStatusCode.RESOURCE_EXHAUSTED,
        `TraceBatch ${request.otlpTraces.byteLength} bytes exceeds cap ${REPORTTRACES_MAX_BYTES}`,
      );
      return {};
    }

    if (!this.deps.traceRelay.isEnabled()) {
      await this.deps.logger.debug(
        `ReportTraces dropped batch device_id=${subject.deviceId}: bridge telemetry disabled`,
      );
      return {};
    }

    try {
      await this.deps.traceRelay.forward(request.otlpTraces);
    } catch (error) {
      await this.deps.logger.warning(
        `ReportTraces forward failed device_id=${subject.deviceId} bytes=${request.otlpTraces.byteLength}: ${getErrorMessage(error)}`,
      );
    }
    return {};
  }

  /** Identity comes from the device-bound token. The hub treats this strictly as a Brokkr Live callback, never "provisioned" — the deployed OS's HTTP phone-home is the sole provisioned signal. */
  async PhoneHome(request: PhoneHomeRequestMsg, context: ServicerContextLike): Promise<PhoneHomeAck> {
    const subject = this.deps.authContext.currentSubject();
    if (!isSubjectDevice(subject)) {
      await context.abort(GrpcStatusCode.PERMISSION_DENIED, 'device-kind token required');
      return {};
    }

    if (!isValidBootId(request.bootId)) {
      await context.abort(
        GrpcStatusCode.INVALID_ARGUMENT,
        `boot_id must be 1-${MAX_BOOT_ID_LENGTH} chars, no control bytes`,
      );
      return {};
    }

    const delivered = await this.deps.results.enqueuePhoneHome({
      deviceId: subject.deviceId,
      bootId: request.bootId,
    });
    if (!delivered) {
      await context.abort(GrpcStatusCode.UNAVAILABLE, 'phone-home enqueue failed; retry');
    }
    return {};
  }

  async _maybe_cache_collector_partial(
    request: PartialResultRequest,
    publisher: AgentServicerDeps['publisher'],
  ): Promise<void> {
    const decision = classifyCollectorPartial(
      request.status,
      PartialResultStatus.STATUS_SUCCESS,
      request.unit,
      request.data,
    );
    if (decision === 'skip_non_success' || decision === 'skip_empty') return;
    if (decision === 'skip_bad_unit') {
      await this.deps.logger.warning(
        `collector partial unit rejected work_id=${request.workId} unit='${request.unit}'`,
      );
      return;
    }

    let meta: Record<string, unknown> | null;
    try {
      meta = await publisher.getDispatchMeta(request.workId);
    } catch (exc) {
      await this.deps.logger.warning(`get_dispatch_meta failed work_id=${request.workId}: ${getErrorMessage(exc)}`);
      return;
    }
    if (meta === null) return;
    // Non-object meta must abort: a corrupt scalar has no own keys, so the empty-object skip below would silently drop the partial.
    if (typeof meta !== 'object' || Array.isArray(meta)) {
      throw new TypeError(`Expected a plain object but received ${Array.isArray(meta) ? 'array' : typeof meta}`);
    }
    if (Object.keys(meta).length === 0) return;
    const operation = meta['operation'];
    if (operation === undefined) return;
    if (typeof operation !== 'string') {
      const tname = operation === null ? 'null' : Array.isArray(operation) ? 'array' : typeof operation;
      throw new TypeError(`operation must be a string but received ${tname}`);
    }
    if (!operation.startsWith('collection.')) return;

    let decoded: unknown;
    try {
      decoded = JSON.parse(request.data);
    } catch (exc) {
      await this.deps.logger.warning(
        `collector partial not JSON work_id=${request.workId} unit=${request.unit}: ${getErrorMessage(exc)}`,
      );
      return;
    }

    const deviceIdRaw = coerceEnvelopeId(meta['device_id']);
    if (!hasEnvelopeId(deviceIdRaw)) return;
    const deviceId = String(deviceIdRaw);

    try {
      const { ok, kept } = await this.deps.results.writeCollectorToResultsCache({
        deviceId,
        collector: request.unit,
        data: decoded,
      });
      if (ok && kept === 0) {
        await this.deps.logger.warning(
          `All collector fields dropped for device ${deviceId} unit ${request.unit} — payloads exceeded size cap; hub will see empty data`,
        );
      }
    } catch (exc) {
      await this.deps.logger.warning(
        `write_collector_to_results_cache failed device_id=${deviceId} unit=${request.unit}: ${getErrorMessage(exc)}`,
      );
    }
  }

  async *FetchBundle(request: BundleRequestMsg, context: ServicerContextLike): AsyncIterable<unknown> {
    const subject = this.deps.authContext.currentSubject();
    if (!isSubjectDevice(subject)) {
      await context.abort(GrpcStatusCode.PERMISSION_DENIED, 'device-kind token required');
      return;
    }

    const cfg = this.deps.bundleConfig;
    let artifactPath: string | null;
    if (request.artifact === BundleArtifact.ARTIFACT_BUNDLE) {
      artifactPath = cfg.bundlePath;
    } else if (request.artifact === BundleArtifact.ARTIFACT_UNIT) {
      artifactPath = cfg.unitPath;
    } else if (request.artifact === BundleArtifact.ARTIFACT_CONFIG) {
      artifactPath = null;
    } else {
      await context.abort(GrpcStatusCode.INVALID_ARGUMENT, `unsupported artifact: ${request.artifact}`);
      return;
    }

    let pinnedBytes: Buffer;
    if (artifactPath === null) {
      let cached: string | null;
      try {
        cached = await this.deps.redisCache.secretGet(`agent-config-cache:${request.sha256}`);
      } catch (exc) {
        await this.deps.logger.warning(`FetchBundle config cache read failed: ${getErrorMessage(exc)}`);
        await context.abort(GrpcStatusCode.INTERNAL, 'failed to read config artifact');
        return;
      }
      if (cached === null) {
        await this.deps.logger.warning(
          `FetchBundle config cache miss sha=${request.sha256.slice(0, 12)}... — TTL elapsed or never set`,
        );
        await context.abort(GrpcStatusCode.NOT_FOUND, 'config artifact not found for sha256');
        return;
      }
      pinnedBytes = Buffer.from(cached, 'utf-8');
    } else {
      // Read-then-hash-then-stream the same buffer to close the TOCTOU window during a bridge redeploy file swap.
      try {
        pinnedBytes = await this.deps.readFile(artifactPath);
      } catch (exc) {
        if (isEnoent(exc)) {
          await context.abort(GrpcStatusCode.NOT_FOUND, `artifact file missing: ${artifactPath}`);
          return;
        }
        await this.deps.logger.warning(`FetchBundle read failed: ${getErrorMessage(exc)}`);
        await context.abort(GrpcStatusCode.INTERNAL, 'failed to read artifact');
        return;
      }
    }

    const actualSha = sha256Hex(pinnedBytes);
    if (request.sha256 !== actualSha) {
      await this.deps.logger.warning(
        `FetchBundle sha mismatch: requested ${request.sha256.slice(0, 12)}... current ${actualSha.slice(0, 12)}... artifact=${request.artifact}`,
      );
      await context.abort(GrpcStatusCode.NOT_FOUND, 'sha256 does not match current artifact');
      return;
    }

    for (let offset = 0; offset < pinnedBytes.length; offset += FETCH_BUNDLE_CHUNK_SIZE) {
      const data = pinnedBytes.subarray(offset, offset + FETCH_BUNDLE_CHUNK_SIZE);
      const chunk: BundleChunkMsg = { data: new Uint8Array(data) };
      yield this.deps.buildBundleChunk(chunk);
    }
  }
}

export { createSessionHandle };
export type { SessionHandle };

const KNOWN_SERVER_MESSAGE_ONEOFS: ReadonlySet<string> = new Set([
  'sessionAccepted',
  'workRequest',
  'topologyUpdate',
  'cancelWork',
]);

function isServerMessageShape(value: unknown): value is ServerMessage {
  if (typeof value !== 'object' || value === null) return false;
  if (Array.isArray(value)) return false;
  if (ArrayBuffer.isView(value)) return false;
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length === 0) return false;
  let sawOneof = false;
  for (const key of keys) {
    if (!KNOWN_SERVER_MESSAGE_ONEOFS.has(key)) return false;
    sawOneof = true;
  }
  return sawOneof;
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'Array';
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null;
    return proto?.constructor?.name ?? 'object';
  }
  return typeof value;
}

function isCancelledError(err: unknown): boolean {
  return (
    err instanceof Error && (err.name === 'AbortError' || err.name === 'CancelledError' || err.name === 'CancelError')
  );
}
