import { Injectable } from '@nestjs/common';

import type { OperationName, OperationOutput } from '@repo/bridge-agent-protocol';

import type { ProgressSnapshot } from '../result-publisher/result-publisher.service';
import {
  buildDispatchEnvelope,
  extractOutput,
  parseResponseOrRaise,
  validateOperationOutput,
  type DispatchWorkRequestFields,
} from './dispatch-envelope';
import { withDispatchSpan, type DispatchSpanHooks } from './dispatch-tracing';
import {
  AgentNotConnected,
  AgentNotResponsive,
  AgentVersionMismatch,
  DispatchFailed,
  DispatchStalled,
  DispatchTimeout,
} from './grpc.exceptions';

const DEFAULT_TIMEOUT_S = 300;
const QUEUE_PUT_TIMEOUT_S = 5;

export interface DispatcherQueue<T> {
  put(message: T, timeoutMs?: number): Promise<void>;
  putNowait(message: T): void;
  qsize(): number;
}

export interface CancelEventLike {
  isSet(): boolean;
  wait(signal?: AbortSignal): Promise<void>;
}

export interface SessionHandle {
  deviceId: string;
  agentVersion: string;
  queue: DispatcherQueue<unknown>;
  cancelled: CancelEventLike;
  lastEnqueueTimeoutAt: number | null;
}

export interface ConnectionRegistry {
  get(deviceId: string): SessionHandle | null;
}

export interface DispatchMeta {
  /** snake_case must match the Redis-persisted hash key. */
  input_hash?: string;
}

export interface ResultPublisher {
  tryGetTerminalResult(workId: string): Promise<Buffer | null>;
  deleteTerminalResult(workId: string): Promise<void>;
  getDispatchMeta(workId: string): Promise<DispatchMeta | null>;
  getProgress(workId: string): Promise<ProgressSnapshot | null>;
  publishDispatchMeta(args: {
    workId: string;
    deviceId: string;
    operation: string;
    ttl: number;
    inputHash?: string;
  }): Promise<void>;
  awaitResult(workId: string, timeoutMs: number): Promise<Buffer>;
}

export interface DispatchLogger {
  debug(msg: string, ctx?: { jobId?: string | null }): Promise<void> | void;
  info(msg: string, ctx?: { jobId?: string | null }): Promise<void> | void;
  warn(msg: string, ctx?: { jobId?: string | null }): Promise<void> | void;
}

export interface AgentVersionGate {
  expectedVersion(): string;
  triggerUpgrade(args: {
    deviceId: string;
    currentVersion: string;
    expectedVersion: string;
    jobId: string | null;
  }): void;
}

export interface CancelWorkEncoder {
  encode(workId: string, reason: string): Uint8Array;
}

// Wrapper key must be the camelCase oneof field name proto-loader (keepCase:false) serialises against ServerMessage; value is the structured oneof message, not pre-encoded bytes.
export interface DispatcherWorkRequestEnvelope {
  workRequest: DispatchWorkRequestFields;
}

export interface DispatcherCancelWorkEnvelope {
  cancelWork: { workId: string; reason: string };
}

export type DispatcherServerMessage = DispatcherWorkRequestEnvelope | DispatcherCancelWorkEnvelope;

export interface DispatchOptions {
  jobId?: string | null;
  timeoutS?: number | null;
  stallTimeoutS?: number | null;
  workId?: string | null;
  signal?: AbortSignal;
}

@Injectable()
export class Dispatcher {
  private readonly defaultTimeoutS = DEFAULT_TIMEOUT_S;

  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly publisher: ResultPublisher,
    private readonly logger: DispatchLogger,
    private readonly versionGate: AgentVersionGate,
    private readonly cancelEncoder: CancelWorkEncoder,
  ) {}

  async dispatch(deviceId: string, operation: string, input: unknown, options: DispatchOptions = {}): Promise<unknown> {
    const jobId = options.jobId ?? null;
    const run = (): Promise<unknown> =>
      withDispatchSpan({ deviceId, operation, jobId }, (spanHooks) =>
        this.runDispatch(deviceId, operation, input, options, jobId, spanHooks),
      );
    try {
      return await run();
    } catch (error) {
      if (
        !(error instanceof DispatchFailed) ||
        error.code !== 'CANCELLED' ||
        options.signal?.aborted === true ||
        options.workId == null
      ) {
        throw error;
      }
      await this.publisher.deleteTerminalResult(options.workId);
      return run();
    }
  }

  private async runDispatch(
    deviceId: string,
    operation: string,
    input: unknown,
    options: DispatchOptions,
    jobId: string | null,
    spanHooks: DispatchSpanHooks,
  ): Promise<unknown> {
    let handle = this.registry.get(deviceId);
    if (handle === null) throw new AgentNotConnected(deviceId);

    if (operation !== 'agent.upgrade') {
      handle = this.ensureVersionMatches(deviceId, handle, jobId);
    }

    const effectiveTimeout = options.timeoutS ?? this.defaultTimeoutS;
    const { workIdStr, inputHash, workRequest } = buildDispatchEnvelope({
      workId: options.workId ?? null,
      deviceId,
      operation,
      input,
      effectiveTimeout,
      jobId,
    });
    spanHooks.setWorkId(workIdStr);
    const traceContext = spanHooks.traceContext();
    if (traceContext.traceparent !== undefined) workRequest.traceparent = traceContext.traceparent;
    if (traceContext.tracestate !== undefined) workRequest.tracestate = traceContext.tracestate;

    await this.logger.debug(`dispatching work device_id=${deviceId} operation=${operation} work_id=${workIdStr}`, {
      jobId,
    });

    const cachedBlob = await this.publisher.tryGetTerminalResult(workIdStr);
    if (cachedBlob !== null) {
      await this.logger.info(
        `dispatch found cached terminal result work_id=${workIdStr} operation=${operation} device_id=${deviceId}; skipping enqueue`,
        { jobId },
      );
      const outcome = parseResponseOrRaise(cachedBlob, workIdStr, { allowInProgress: false });
      if (outcome.kind !== 'response') {
        throw new Error('parseResponseOrRaise returned non-response for allowInProgress=false cached blob');
      }
      return extractOutput(outcome.response);
    }

    await this.warnIfWorkIdCollision(workIdStr, inputHash, operation, jobId);

    const dispatchMetaTtl = Math.max(Math.trunc(effectiveTimeout) + 60, 7200);
    await this.publishDispatchMetaOrRaise({
      workIdStr,
      deviceId,
      operation,
      inputHash,
      ttl: dispatchMetaTtl,
    });

    const workRequestEnvelope: DispatcherWorkRequestEnvelope = { workRequest };
    try {
      await handle.queue.put(workRequestEnvelope, QUEUE_PUT_TIMEOUT_S * 1000);
    } catch (error) {
      if (isTimeoutLike(error)) {
        handle.lastEnqueueTimeoutAt = nowSeconds();
        await this.logger.warn(
          `session queue wedged device_id=${deviceId} operation=${operation} work_id=${workIdStr} depth=${handle.queue.qsize()}; surfacing AgentNotResponsive`,
          { jobId },
        );
        throw new AgentNotResponsive(deviceId, handle.queue.qsize());
      }
      throw error;
    }

    const dispatchStartedMs = monotonicMs();
    const remainingBudgetMs = (): number => Math.max(0, effectiveTimeout * 1000 - (monotonicMs() - dispatchStartedMs));
    const stallDetector = this.startStallDetector(workIdStr, options.stallTimeoutS, dispatchStartedMs);

    try {
      const firstBlob = await this.awaitWithCancelHooks({
        workIdStr,
        handle,
        deviceId,
        timeoutMs: remainingBudgetMs(),
        jobId,
        timeoutMessage: `operation '${operation}' on device '${deviceId}' timed out after ${effectiveTimeout}s`,
        signal: options.signal,
        stallPromise: stallDetector?.promise,
      });

      let outcome = parseResponseOrRaise(firstBlob, workIdStr, { allowInProgress: true });
      if (outcome.kind === 'inProgress') {
        await this.logger.warn(
          `dispatch saw STATUS_ALREADY_IN_PROGRESS device_id=${deviceId} operation=${operation} work_id=${workIdStr}; continuing to wait for the original result`,
          { jobId },
        );
        const remainingMs = remainingBudgetMs();
        if (remainingMs <= 0) {
          throw new DispatchTimeout(
            `operation '${operation}' on device '${deviceId}' timed out after ${effectiveTimeout}s (STATUS_ALREADY_IN_PROGRESS returned after budget exhausted)`,
          );
        }
        const secondBlob = await this.awaitWithCancelHooks({
          workIdStr,
          handle,
          deviceId,
          timeoutMs: remainingMs,
          jobId,
          timeoutMessage: `operation '${operation}' on device '${deviceId}' timed out waiting for already-in-progress result`,
          signal: options.signal,
          stallPromise: stallDetector?.promise,
        });
        outcome = parseResponseOrRaise(secondBlob, workIdStr, { allowInProgress: false });
        if (outcome.kind !== 'response') {
          throw new Error('parseResponseOrRaise returned non-response after allowInProgress=false');
        }
      }

      return extractOutput(outcome.response);
    } finally {
      stallDetector?.dispose();
    }
  }

  async dispatchTyped<N extends OperationName>(
    deviceId: string,
    operation: N,
    input: unknown,
    options: DispatchOptions = {},
  ): Promise<OperationOutput<N>> {
    const raw = await this.dispatch(deviceId, operation, input, options);
    return validateOperationOutput(operation, raw);
  }

  private async warnIfWorkIdCollision(
    workIdStr: string,
    inputHash: string,
    operation: string,
    jobId: string | null,
  ): Promise<void> {
    let existing: DispatchMeta | null;
    try {
      existing = await this.publisher.getDispatchMeta(workIdStr);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.logger.warn(`get_dispatch_meta failed (non-fatal) work_id=${workIdStr}: ${reason}`, { jobId });
      return;
    }
    if (existing === null) return;
    // Non-dict meta must abort dispatch (property-access-error surface _verify_work_id_owned_by_caller relies on).
    if (typeof existing !== 'object' || Array.isArray(existing)) {
      throw new TypeError(
        `Expected a plain object but received ${Array.isArray(existing) ? 'array' : typeof existing}`,
      );
    }
    const priorHash = existing.input_hash;
    if (priorHash && priorHash !== inputHash) {
      await this.logger.warn(
        `work_id collision with different inputs work_id=${workIdStr} operation=${operation} prior_hash=${priorHash.slice(0, 12)}... new_hash=${inputHash.slice(0, 12)}... — agent will return the prior result; review caller's work_id uniqueness`,
        { jobId },
      );
    }
  }

  private async publishDispatchMetaOrRaise(args: {
    workIdStr: string;
    deviceId: string;
    operation: string;
    inputHash: string;
    ttl: number;
  }): Promise<void> {
    try {
      await this.publisher.publishDispatchMeta({
        workId: args.workIdStr,
        deviceId: args.deviceId,
        operation: args.operation,
        ttl: args.ttl,
        inputHash: args.inputHash,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new DispatchFailed(
        'META_PUBLISH_FAILED',
        `failed to publish dispatch metadata for work_id=${args.workIdStr} on device '${args.deviceId}': ${reason}; not enqueueing work the agent would be unable to report against`,
        null,
      );
    }
  }

  private async awaitWithCancelHooks(args: {
    workIdStr: string;
    handle: SessionHandle;
    deviceId: string;
    timeoutMs: number;
    jobId: string | null;
    timeoutMessage: string;
    signal: AbortSignal | undefined;
    stallPromise: Promise<never> | undefined;
  }): Promise<Buffer> {
    if (args.signal?.aborted) {
      this.emitCancelWork(args.handle, args.deviceId, args.workIdStr, 'saga_cancelled', args.jobId);
      throw abortReason(args.signal);
    }
    try {
      return await this.awaitResultOrSessionLoss(args);
    } catch (error) {
      if (isAbortError(error, args.signal)) {
        this.emitCancelWork(args.handle, args.deviceId, args.workIdStr, 'saga_cancelled', args.jobId);
        throw error;
      }
      if (error instanceof DispatchStalled) {
        this.emitCancelWork(args.handle, args.deviceId, args.workIdStr, 'bridge_stall', args.jobId);
        throw error;
      }
      if (error instanceof DispatchTimeout || isTimeoutLike(error)) {
        this.emitCancelWork(args.handle, args.deviceId, args.workIdStr, 'bridge_timeout', args.jobId);
        throw new DispatchTimeout(args.timeoutMessage);
      }
      throw error;
    }
  }

  private async awaitResultOrSessionLoss(args: {
    workIdStr: string;
    handle: SessionHandle;
    deviceId: string;
    timeoutMs: number;
    jobId: string | null;
    signal: AbortSignal | undefined;
    stallPromise: Promise<never> | undefined;
  }): Promise<Buffer> {
    const resultTracked = trackSettled(this.publisher.awaitResult(args.workIdStr, args.timeoutMs));
    // Detach the cancel waiter once this race settles, or a long-lived session leaks one resolver per dispatch.
    const cancelWaitController = new AbortController();
    const cancelledTracked = trackSettled(args.handle.cancelled.wait(cancelWaitController.signal));
    const abortTracked = args.signal !== undefined ? trackAbort(args.signal) : null;

    const racers: Promise<void>[] = [resultTracked.promise, cancelledTracked.promise];
    if (abortTracked !== null) racers.push(abortTracked.promise);
    if (args.stallPromise !== undefined) racers.push(args.stallPromise);

    try {
      await Promise.race(racers);
      await Promise.resolve();

      const resultState = resultTracked.state();
      if (resultState.kind === 'fulfilled') return resultState.value;
      if (resultState.kind === 'rejected') throw resultState.error;

      if (args.signal !== undefined && abortTracked !== null && abortTracked.state().kind === 'fulfilled') {
        throw abortReason(args.signal);
      }

      await this.logger.warn(
        `agent session for device ${args.deviceId} torn down while awaiting work_id=${args.workIdStr}; abandoning dispatch so the job reschedules to a bridge with a live session`,
        { jobId: args.jobId },
      );
      throw new AgentNotConnected(args.deviceId);
    } finally {
      cancelWaitController.abort();
      abortTracked?.dispose();
    }
  }

  private startStallDetector(
    workId: string,
    stallTimeoutS: number | null | undefined,
    dispatchStartedMs: number,
  ): StallDetector | null {
    if (
      stallTimeoutS === null ||
      stallTimeoutS === undefined ||
      stallTimeoutS <= 0 ||
      !Number.isFinite(stallTimeoutS)
    ) {
      return null;
    }

    let active = true;
    let polling = false;
    let settled = false;
    let lastProgress: ProgressSnapshot | null = null;
    let lastProgressAtMs = dispatchStartedMs;
    let rejectStall: (reason: unknown) => void = () => {};
    const promise = new Promise<never>((_resolve, reject) => {
      rejectStall = reject;
    });

    const poll = async (): Promise<void> => {
      if (!active || polling || settled) return;
      polling = true;
      try {
        const progress = await this.publisher.getProgress(workId).catch(() => null);
        if (!active || settled) return;

        const now = monotonicMs();
        if (progress !== null && !progressSnapshotsEqual(lastProgress, progress)) {
          lastProgress = { ...progress };
          lastProgressAtMs = now;
          return;
        }

        const stallSeconds = (now - lastProgressAtMs) / 1000;
        if (stallSeconds >= stallTimeoutS) {
          settled = true;
          rejectStall(new DispatchStalled(workId, lastProgress, stallSeconds));
        }
      } finally {
        polling = false;
      }
    };

    const interval = setInterval(
      () => {
        void poll();
      },
      Math.min(60_000, stallTimeoutS * 1000),
    );

    return {
      promise,
      dispose: () => {
        active = false;
        clearInterval(interval);
      },
    };
  }

  private emitCancelWork(
    handle: SessionHandle,
    deviceId: string,
    workId: string,
    reason: string,
    jobId: string | null,
  ): void {
    if (handle.cancelled.isSet()) return;
    const envelope: DispatcherCancelWorkEnvelope = { cancelWork: { workId, reason } };
    try {
      handle.queue.putNowait(envelope);
      void this.logger.debug(`emitted cancel_work device_id=${deviceId} work_id=${workId} reason=${reason}`, { jobId });
    } catch (error) {
      const reasonText = error instanceof Error ? error.message : String(error);
      void this.logger.warn(
        `could not emit cancel_work device_id=${deviceId} work_id=${workId} reason=${reason}: ${reasonText}; agent will see the cancel on next reconnect or complete the operation as already-running`,
        { jobId },
      );
    }
  }

  private ensureVersionMatches(deviceId: string, handle: SessionHandle, jobId: string | null): SessionHandle {
    const expected = this.versionGate.expectedVersion();
    if (!expected || handle.agentVersion === expected) return handle;
    this.versionGate.triggerUpgrade({
      deviceId,
      currentVersion: handle.agentVersion,
      expectedVersion: expected,
      jobId,
    });
    throw new AgentVersionMismatch(deviceId, handle.agentVersion, expected);
  }
}

function nowSeconds(): number {
  // Must share epoch with ConnectionRegistry.pickPreferredHandle's clock or the recent-timeout window comparison is meaningless.
  return performance.now() / 1000;
}

function monotonicMs(): number {
  return performance.now();
}

function isTimeoutLike(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'TimeoutError' ||
      error.name === 'QueuePutTimeoutError' ||
      error.name === 'ResultPublisherTimeoutError' ||
      /timed out|timeout|deadline exceeded/i.test(error.message))
  );
}

type Settled<T> = { kind: 'pending' } | { kind: 'fulfilled'; value: T } | { kind: 'rejected'; error: unknown };

interface SettledTracker<T> {
  promise: Promise<void>;
  state(): Settled<T>;
}

function trackSettled<T>(source: Promise<T>): SettledTracker<T> {
  let state: Settled<T> = { kind: 'pending' };
  const promise = source.then(
    (value) => {
      state = { kind: 'fulfilled', value };
    },
    (error: unknown) => {
      state = { kind: 'rejected', error };
    },
  );
  return { promise, state: () => state };
}

interface AbortTracker {
  promise: Promise<void>;
  state(): Settled<void>;
  dispose(): void;
}

interface StallDetector {
  promise: Promise<never>;
  dispose(): void;
}

function progressSnapshotsEqual(left: ProgressSnapshot | null, right: ProgressSnapshot): boolean {
  if (left === null) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.hasOwn(right, key) && left[key] === right[key]);
}

function trackAbort(signal: AbortSignal): AbortTracker {
  let state: Settled<void> = { kind: 'pending' };
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  const onAbort = (): void => {
    state = { kind: 'fulfilled', value: undefined };
    resolve();
  };
  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    promise,
    state: () => state,
    dispose: () => signal.removeEventListener('abort', onAbort),
  };
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  return new DOMException('The operation was aborted.', 'AbortError');
}

function isAbortError(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted && error === signal.reason) return true;
  if (error instanceof Error && error.name === 'AbortError') return true;
  return false;
}
