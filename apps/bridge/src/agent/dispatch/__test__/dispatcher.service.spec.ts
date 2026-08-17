import { context, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { BoundedAsyncQueue, CancelEvent, type SessionQueue } from '../../connection-registry/connection-registry.types';
import type { ProgressSnapshot } from '../../result-publisher/result-publisher.service';
import {
  Dispatcher,
  type AgentVersionGate,
  type CancelWorkEncoder,
  type ConnectionRegistry,
  type DispatchLogger,
  type DispatchMeta,
  type ResultPublisher,
  type SessionHandle,
} from '../dispatcher.service';
import { DispatchStalled, DispatchTimeout } from '../grpc.exceptions';
import { encodeWorkResponse, WorkResponseStatus } from '../protobuf-codec';

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

interface QueueEnvelope {
  workRequest?: {
    workId: string;
    operation: string;
    input: Uint8Array;
    jobId: string;
    deadline: { seconds: number; nanos: number };
    traceparent?: string;
    tracestate?: string;
  };
  cancelWork?: { workId: string; reason: string };
}

class FakeCancelEncoder implements CancelWorkEncoder {
  encode(workId: string, reason: string): Uint8Array {
    const wId = TEXT_ENCODER.encode(workId);
    const reasonBytes = TEXT_ENCODER.encode(reason);
    const out: number[] = [];
    out.push((1 << 3) | 2, wId.length, ...wId);
    out.push((2 << 3) | 2, reasonBytes.length, ...reasonBytes);
    return new Uint8Array(out);
  }
}

function buildSuccessResponse(workId: string, output: unknown): Buffer {
  return Buffer.from(
    encodeWorkResponse({
      workId,
      status: WorkResponseStatus.SUCCESS,
      output: TEXT_ENCODER.encode(JSON.stringify(output)),
      error: { code: '', message: '', detailsJson: '' },
    }),
  );
}

function buildFailureResponse(workId: string, code: string, msg: string): Buffer {
  return Buffer.from(
    encodeWorkResponse({
      workId,
      status: WorkResponseStatus.FAILURE,
      output: new Uint8Array(),
      error: { code, message: msg, detailsJson: '' },
    }),
  );
}

function buildInProgressResponse(workId: string): Buffer {
  return Buffer.from(
    encodeWorkResponse({
      workId,
      status: WorkResponseStatus.ALREADY_IN_PROGRESS,
      output: new Uint8Array(),
      error: { code: '', message: '', detailsJson: '' },
    }),
  );
}

interface RichHandle {
  deviceId: string;
  agentVersion: string;
  queue: SessionQueue<unknown>;
  cancelled: CancelEvent;
  lastEnqueueTimeoutAt: number | null;
}

class FakeRegistry implements ConnectionRegistry {
  private readonly handles = new Map<string, RichHandle>();

  register(deviceId: string, agentVersion: string = ''): RichHandle {
    const handle: RichHandle = {
      deviceId,
      agentVersion,
      queue: new BoundedAsyncQueue<unknown>(),
      cancelled: new CancelEvent(),
      lastEnqueueTimeoutAt: null,
    };
    this.handles.set(deviceId, handle);
    return handle;
  }

  replaceQueue(deviceId: string, queue: SessionQueue<unknown>): void {
    const handle = this.handles.get(deviceId);
    if (handle === undefined) throw new Error(`no handle for ${deviceId}`);
    handle.queue = queue;
  }

  get(deviceId: string): SessionHandle | null {
    const handle = this.handles.get(deviceId);
    return handle === undefined ? null : (handle as unknown as SessionHandle);
  }
}

class FakePublisher implements ResultPublisher {
  readonly meta = new Map<string, DispatchMeta>();
  readonly progress = new Map<string, ProgressSnapshot>();
  readonly results = new Map<string, Buffer>();
  private readonly waiters = new Map<string, Array<(value: Buffer) => void>>();
  readonly getProgress = vi.fn(async (workId: string): Promise<ProgressSnapshot | null> => {
    const snapshot = this.progress.get(workId);
    return snapshot === undefined ? null : { ...snapshot };
  });

  async tryGetTerminalResult(workId: string): Promise<Buffer | null> {
    return this.results.get(workId) ?? null;
  }

  async deleteTerminalResult(workId: string): Promise<void> {
    this.results.delete(workId);
  }

  async getDispatchMeta(workId: string): Promise<DispatchMeta | null> {
    return this.meta.get(workId) ?? null;
  }

  async publishDispatchMeta(args: {
    workId: string;
    deviceId: string;
    operation: string;
    ttl: number;
    inputHash?: string;
  }): Promise<void> {
    const m: DispatchMeta & { device_id?: string; operation?: string } = {};
    if (args.inputHash !== undefined) m.input_hash = args.inputHash;
    this.meta.set(args.workId, m);
  }

  async awaitResult(workId: string, timeoutMs: number): Promise<Buffer> {
    const existing = this.results.get(workId);
    if (existing !== undefined) return existing;
    return new Promise<Buffer>((resolve, reject) => {
      const list = this.waiters.get(workId) ?? [];
      list.push(resolve);
      this.waiters.set(workId, list);
      setTimeout(() => {
        const idx = list.indexOf(resolve);
        if (idx >= 0) {
          list.splice(idx, 1);
          const err = new Error(`awaitResult(${workId}) deadline exceeded`);
          err.name = 'ResultPublisherTimeoutError';
          reject(err);
        }
      }, timeoutMs);
    });
  }

  publishResult(workId: string, bytes: Buffer): void {
    this.results.set(workId, bytes);
    const list = this.waiters.get(workId);
    if (list !== undefined) {
      for (const resolve of list.splice(0)) resolve(bytes);
    }
  }

  seedResult(workId: string, bytes: Buffer): void {
    this.results.set(workId, bytes);
  }

  setProgress(workId: string, snapshot: ProgressSnapshot): void {
    this.progress.set(workId, snapshot);
  }
}

const silentLogger: DispatchLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};

const captureLogger = (): DispatchLogger & {
  warns: string[];
  infos: string[];
  debugs: string[];
} => {
  const warns: string[] = [];
  const infos: string[] = [];
  const debugs: string[] = [];
  return {
    warns,
    infos,
    debugs,
    debug: vi.fn(async (msg: string) => {
      debugs.push(msg);
    }),
    info: vi.fn(async (msg: string) => {
      infos.push(msg);
    }),
    warn: vi.fn(async (msg: string) => {
      warns.push(msg);
    }),
  };
};

const passiveVersionGate: AgentVersionGate = {
  expectedVersion: () => '',
  triggerUpgrade: () => {},
};

interface Rig {
  dispatcher: Dispatcher;
  registry: FakeRegistry;
  publisher: FakePublisher;
  logger: ReturnType<typeof captureLogger>;
}

function buildRig(): Rig {
  const registry = new FakeRegistry();
  const publisher = new FakePublisher();
  const logger = captureLogger();
  const dispatcher = new Dispatcher(registry, publisher, logger, passiveVersionGate, new FakeCancelEncoder());
  return { dispatcher, registry, publisher, logger };
}

async function drainQueue(handle: RichHandle): Promise<QueueEnvelope[]> {
  const out: QueueEnvelope[] = [];
  while (handle.queue.qsize() > 0) {
    out.push((await handle.queue.get()) as QueueEnvelope);
  }
  return out;
}

describe('Dispatcher', () => {
  it('happy path returns the parsed output JSON', async () => {
    const { dispatcher, registry, publisher } = buildRig();
    const handle = registry.register('dev-happy');

    const dispatchPromise = dispatcher.dispatch(
      'dev-happy',
      'collection.architecture',
      {},
      {
        timeoutS: 2.0,
      },
    );

    const msg = (await handle.queue.get()) as QueueEnvelope;
    expect(msg.workRequest).toBeDefined();
    const wr = msg.workRequest!;
    publisher.publishResult(wr.workId, buildSuccessResponse(wr.workId, { machine: 'x86_64' }));

    const result = await dispatchPromise;
    expect(result).toEqual({ machine: 'x86_64' });
  });

  it('raises AgentNotConnected when no session is registered', async () => {
    const { dispatcher } = buildRig();
    await expect(
      dispatcher.dispatch('dev-missing', 'agent.upgrade', { x: 1 }, { timeoutS: 0.5 }),
    ).rejects.toMatchObject({ name: 'AgentNotConnected', device_id: 'dev-missing' });
  });

  it('raises DispatchTimeout when no response arrives in budget', async () => {
    const { dispatcher, registry } = buildRig();
    registry.register('dev-quiet');
    await expect(
      dispatcher.dispatch('dev-quiet', 'storage.wipeDisk', { disk: 'sda' }, { timeoutS: 0.2 }),
    ).rejects.toBeInstanceOf(DispatchTimeout);
  });

  it('raises AgentNotResponsive when session queue is wedged', async () => {
    const { dispatcher, registry } = buildRig();
    registry.register('dev-wedged');
    const stuffed = new BoundedAsyncQueue<unknown>(1);
    stuffed.putNowait({ sentinel: true });
    registry.replaceQueue('dev-wedged', stuffed);

    await expect(
      dispatcher.dispatch('dev-wedged', 'collection.architecture', {}, { timeoutS: 30.0 }),
    ).rejects.toMatchObject({ name: 'AgentNotResponsive', device_id: 'dev-wedged', queue_depth: 1 });
  }, 10_000);

  it('raises DispatchFailed on STATUS_FAILURE response', async () => {
    const { dispatcher, registry, publisher } = buildRig();
    const handle = registry.register('dev-fail');

    const dispatchPromise = dispatcher.dispatch(
      'dev-fail',
      'deploy.deployOS',
      {},
      {
        timeoutS: 2.0,
      },
    );

    const msg = (await handle.queue.get()) as QueueEnvelope;
    const wr = msg.workRequest!;
    publisher.publishResult(wr.workId, buildFailureResponse(wr.workId, 'MISSING_BINARY', 'mkfs not found'));

    await expect(dispatchPromise).rejects.toMatchObject({
      name: 'DispatchFailed',
      code: 'MISSING_BINARY',
    });
    await expect(dispatchPromise).rejects.toThrowError(/mkfs not found/);
  });

  it('raises DISPATCH_INVARIANT when ALREADY_IN_PROGRESS leaks into terminal key', async () => {
    const { dispatcher, registry, publisher } = buildRig();
    const handle = registry.register('dev-aip-leak');

    const dispatchPromise = dispatcher.dispatch(
      'dev-aip-leak',
      'deploy.deployOS',
      {},
      {
        timeoutS: 2.0,
      },
    );

    const msg = (await handle.queue.get()) as QueueEnvelope;
    const wr = msg.workRequest!;
    publisher.publishResult(wr.workId, buildInProgressResponse(wr.workId));

    await expect(dispatchPromise).rejects.toMatchObject({
      name: 'DispatchFailed',
      code: 'DISPATCH_INVARIANT',
    });
    await expect(dispatchPromise).rejects.toThrowError(/STATUS_ALREADY_IN_PROGRESS/);
  });

  it('encodes input as JSON bytes on the wire', async () => {
    const { dispatcher, registry, publisher } = buildRig();
    const handle = registry.register('dev-encoding');

    const dispatchPromise = dispatcher.dispatch(
      'dev-encoding',
      'collection.collectAll',
      { collectors: ['a', 'b'] },
      { timeoutS: 5.0 },
    );

    const msg = (await handle.queue.get()) as QueueEnvelope;
    const wr = msg.workRequest!;
    publisher.publishResult(wr.workId, buildSuccessResponse(wr.workId, {}));

    await dispatchPromise;

    expect(wr.operation).toBe('collection.collectAll');
    expect(JSON.parse(TEXT_DECODER.decode(wr.input))).toEqual({ collectors: ['a', 'b'] });
    expect(wr.deadline.seconds).toBe(5);
    expect(wr.workId.length).toBeGreaterThanOrEqual(32);
  });

  it('honours an explicit work_id end-to-end', async () => {
    const { dispatcher, registry, publisher } = buildRig();
    const handle = registry.register('dev-wid');

    const dispatchPromise = dispatcher.dispatch(
      'dev-wid',
      'agent.upgrade',
      {},
      {
        timeoutS: 2.0,
        workId: 'fixed-uuid-1234',
      },
    );

    const msg = (await handle.queue.get()) as QueueEnvelope;
    const wr = msg.workRequest!;
    expect(wr.workId).toBe('fixed-uuid-1234');
    publisher.publishResult(wr.workId, buildSuccessResponse(wr.workId, {}));
    await dispatchPromise;

    expect(await publisher.tryGetTerminalResult('fixed-uuid-1234')).not.toBeNull();
  });

  it('mints a UUIDv4 work_id (not derived from job_id) when no explicit work_id', async () => {
    const { dispatcher, registry, publisher } = buildRig();
    const handle = registry.register('dev-uuid-wid');

    const dispatchPromise = dispatcher.dispatch(
      'dev-uuid-wid',
      'storage.prepareStorage',
      { k: 'v' },
      { timeoutS: 2.0, jobId: 'plan-99-step-3' },
    );

    const msg = (await handle.queue.get()) as QueueEnvelope;
    const wr = msg.workRequest!;
    publisher.publishResult(wr.workId, buildSuccessResponse(wr.workId, {}));
    await dispatchPromise;

    expect(wr.workId).not.toContain(':');
    expect(wr.workId).not.toContain('plan-99-step-3');
    expect(wr.workId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(wr.jobId).toBe('plan-99-step-3');
  });

  it('falls back to a UUIDv4 work_id when neither work_id nor job_id given', async () => {
    const { dispatcher, registry, publisher } = buildRig();
    const handle = registry.register('dev-uuid-fallback');

    const dispatchPromise = dispatcher.dispatch('dev-uuid-fallback', 'collection.architecture', {}, { timeoutS: 2.0 });

    const msg = (await handle.queue.get()) as QueueEnvelope;
    const wr = msg.workRequest!;
    publisher.publishResult(wr.workId, buildSuccessResponse(wr.workId, {}));
    await dispatchPromise;

    expect(wr.workId).toHaveLength(36);
    expect((wr.workId.match(/-/g) ?? []).length).toBe(4);
  });

  it('warns when a work_id collision with different inputs is detected', async () => {
    const { dispatcher, registry, publisher, logger } = buildRig();
    const handle = registry.register('dev-collide');

    publisher.meta.set('collide-key', { input_hash: 'deadbeef'.repeat(8) });

    const dispatchPromise = dispatcher.dispatch(
      'dev-collide',
      'storage.prepareStorage',
      { x: 1 },
      { timeoutS: 2.0, workId: 'collide-key' },
    );

    const msg = (await handle.queue.get()) as QueueEnvelope;
    const wr = msg.workRequest!;
    publisher.publishResult(wr.workId, buildSuccessResponse(wr.workId, {}));
    await dispatchPromise;

    expect(logger.warns.some((m) => m.includes('work_id collision'))).toBe(true);
  });

  it('returns cached SUCCESS terminal result without enqueueing', async () => {
    const { dispatcher, registry, publisher } = buildRig();
    const handle = registry.register('dev-cached');

    const cachedOutput = { machine: 'cached-x86_64' };
    publisher.seedResult('w-cached-1', buildSuccessResponse('w-cached-1', cachedOutput));
    publisher.meta.set('w-cached-1', {});

    const result = await dispatcher.dispatch(
      'dev-cached',
      'collection.architecture',
      {},
      { timeoutS: 2.0, workId: 'w-cached-1' },
    );

    expect(result).toEqual(cachedOutput);
    expect(handle.queue.qsize()).toBe(0);
  });

  it('cached terminal FAILURE result surfaces as DispatchFailed', async () => {
    const { dispatcher, registry, publisher } = buildRig();
    registry.register('dev-cached-fail');

    publisher.seedResult(
      'w-cached-fail-1',
      buildFailureResponse('w-cached-fail-1', 'AGENT_VALIDATION_ERROR', 'bad input'),
    );

    await expect(
      dispatcher.dispatch(
        'dev-cached-fail',
        'storage.wipeDisks',
        { k: 'v' },
        { timeoutS: 2.0, workId: 'w-cached-fail-1' },
      ),
    ).rejects.toMatchObject({
      name: 'DispatchFailed',
      code: 'AGENT_VALIDATION_ERROR',
    });
  });

  it('re-dispatches a cached CANCELLED result with the same work ID', async () => {
    const { dispatcher, registry, publisher } = buildRig();
    const handle = registry.register('dev-cached-cancelled');
    publisher.seedResult(
      'w-cached-cancelled-1',
      buildFailureResponse('w-cached-cancelled-1', 'CANCELLED', 'operation cancelled'),
    );

    const dispatchPromise = dispatcher.dispatch(
      'dev-cached-cancelled',
      'storage.prepareStorage',
      { k: 'v' },
      { timeoutS: 2.0, workId: 'w-cached-cancelled-1' },
    );
    const message = (await handle.queue.get()) as QueueEnvelope;
    publisher.publishResult(
      message.workRequest!.workId,
      buildSuccessResponse(message.workRequest!.workId, { prepared: true }),
    );

    await expect(dispatchPromise).resolves.toEqual({ prepared: true });
  });

  it('raises META_PUBLISH_FAILED when publishDispatchMeta throws and never enqueues', async () => {
    const { dispatcher, registry, publisher } = buildRig();
    const handle = registry.register('dev-meta-fail');

    publisher.publishDispatchMeta = vi.fn(async () => {
      throw new Error('simulated redis failure');
    });

    await expect(
      dispatcher.dispatch('dev-meta-fail', 'collection.architecture', {}, { timeoutS: 2.0 }),
    ).rejects.toMatchObject({
      name: 'DispatchFailed',
      code: 'META_PUBLISH_FAILED',
    });
    await expect(
      dispatcher.dispatch('dev-meta-fail', 'collection.architecture', {}, { timeoutS: 2.0 }),
    ).rejects.toThrowError(/simulated redis failure/);

    expect(handle.queue.qsize()).toBe(0);
  });

  it('emits cancel_work onto the session queue when the bridge times out', async () => {
    const { dispatcher, registry } = buildRig();
    const handle = registry.register('dev-timeout');

    await expect(
      dispatcher.dispatch('dev-timeout', 'storage.wipeDisks', { k: 'v' }, { timeoutS: 0.1, workId: 'w-timeout-1' }),
    ).rejects.toBeInstanceOf(DispatchTimeout);

    const messages = await drainQueue(handle);
    expect(messages.length).toBeGreaterThanOrEqual(2);
    const last = messages[messages.length - 1];
    expect(last.cancelWork).toBeDefined();
    const decoded = last.cancelWork!;
    expect(decoded.workId).toBe('w-timeout-1');
    expect(decoded.reason).toBe('bridge_timeout');
  });

  it('emits cancel_work when the saga AbortSignal fires mid-await', async () => {
    const { dispatcher, registry } = buildRig();
    const handle = registry.register('dev-cancel');

    const controller = new AbortController();
    const dispatchPromise = dispatcher.dispatch(
      'dev-cancel',
      'storage.prepareStorage',
      { k: 'v' },
      { timeoutS: 60.0, workId: 'w-cancel-1', signal: controller.signal },
    );

    await handle.queue.get();
    controller.abort();

    const cancel = (await handle.queue.get()) as QueueEnvelope;
    expect(cancel.cancelWork?.workId).toBe('w-cancel-1');
    expect(cancel.cancelWork?.reason).toBe('saga_cancelled');
    await expect(dispatchPromise).rejects.toBeDefined();
  });

  it('fast-fails AgentNotConnected when the session is torn down mid-await', async () => {
    const { dispatcher, registry } = buildRig();
    const handle = registry.register('dev-session-loss');

    const dispatchPromise = dispatcher.dispatch(
      'dev-session-loss',
      'storage.wipeDisks',
      { k: 'v' },
      { timeoutS: 60.0, workId: 'w-session-loss-1' },
    );

    await new Promise((r) => setTimeout(r, 50));
    handle.cancelled.set();

    await expect(dispatchPromise).rejects.toMatchObject({
      name: 'AgentNotConnected',
      device_id: 'dev-session-loss',
    });
  });

  it('translates non-JSON-serialisable input to DispatchFailed(INVALID_INPUT)', async () => {
    const { dispatcher, registry } = buildRig();
    registry.register('dev-bad-input');

    const badInput = { n: BigInt(42) };

    await expect(
      dispatcher.dispatch('dev-bad-input', 'system.getArchitecture', badInput, { timeoutS: 1.0 }),
    ).rejects.toMatchObject({
      name: 'DispatchFailed',
      code: 'INVALID_INPUT',
    });
    await expect(
      dispatcher.dispatch('dev-bad-input', 'system.getArchitecture', badInput, { timeoutS: 1.0 }),
    ).rejects.toThrowError(/JSON-serializable/);
  });

  it('does not accumulate cancel waiters across many dispatches on one session', async () => {
    const { dispatcher, registry, publisher } = buildRig();
    const handle = registry.register('dev-no-leak');
    const cancelInternals = handle.cancelled as unknown as { waiters: unknown[] };

    for (let i = 0; i < 50; i += 1) {
      const dispatchPromise = dispatcher.dispatch('dev-no-leak', 'collection.architecture', { i }, { timeoutS: 2.0 });
      const msg = (await handle.queue.get()) as QueueEnvelope;
      const wr = msg.workRequest!;
      publisher.publishResult(wr.workId, buildSuccessResponse(wr.workId, { i }));
      await dispatchPromise;
    }

    expect(cancelInternals.waiters.length).toBe(0);

    const stillResolves = handle.cancelled.wait();
    handle.cancelled.set();
    await expect(stillResolves).resolves.toBeUndefined();
  });
});

describe('Dispatcher stall detection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('raises DispatchStalled before the absolute timeout and emits the exact stall cancellation', async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const { dispatcher, registry } = buildRig();
    const handle = registry.register('dev-stalled');

    const dispatchPromise = dispatcher.dispatch(
      'dev-stalled',
      'storage.wipeDisks',
      {},
      { timeoutS: 30, stallTimeoutS: 2, workId: 'work-stalled-1' },
    );
    await handle.queue.get();
    const errorPromise = dispatchPromise.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(2_000);
    const error = await errorPromise;

    expect(error).toBeInstanceOf(DispatchStalled);
    expect(error).toMatchObject({
      name: 'DispatchStalled',
      message: 'dispatch stalled for work work-stalled-1 after 2s without progress',
      work_id: 'work-stalled-1',
      last_progress: null,
      stall_seconds: 2,
    });
    await expect(drainQueue(handle)).resolves.toEqual([
      { cancelWork: { workId: 'work-stalled-1', reason: 'bridge_stall' } },
    ]);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: 'progress field',
      initial: { progress: '0.1', message: 'started', _ts: '1' },
      changed: { progress: '0.2', message: 'started', _ts: '1' },
    },
    {
      label: '_ts field',
      initial: { progress: '0.1', message: 'started', _ts: '1' },
      changed: { progress: '0.1', message: 'started', _ts: '2' },
    },
  ])('resets the stall clock when the $label changes', async ({ initial, changed }) => {
    const { dispatcher, registry, publisher } = buildRig();
    const handle = registry.register('dev-progressing');
    publisher.setProgress('work-progress-1', initial);

    const dispatchPromise = dispatcher.dispatch(
      'dev-progressing',
      'storage.wipeDisks',
      {},
      { timeoutS: 20, stallTimeoutS: 2, workId: 'work-progress-1' },
    );
    await handle.queue.get();

    await vi.advanceTimersByTimeAsync(2_000);
    publisher.setProgress('work-progress-1', changed);
    await vi.advanceTimersByTimeAsync(2_000);
    publisher.publishResult('work-progress-1', buildSuccessResponse('work-progress-1', { wiped: true }));

    await expect(dispatchPromise).resolves.toEqual({ wiped: true });
    expect(publisher.getProgress).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, null, 0, -1, Number.NaN])(
    'disables polling without a positive finite stall timeout %s',
    async (stallTimeoutS) => {
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      const { dispatcher, registry, publisher } = buildRig();
      const handle = registry.register('dev-no-stall-poll');

      const dispatchPromise = dispatcher.dispatch(
        'dev-no-stall-poll',
        'collection.architecture',
        {},
        { timeoutS: 10, stallTimeoutS, workId: 'work-no-stall-poll' },
      );
      await handle.queue.get();
      await vi.advanceTimersByTimeAsync(5_000);
      publisher.publishResult('work-no-stall-poll', buildSuccessResponse('work-no-stall-poll', { machine: 'x86_64' }));

      await expect(dispatchPromise).resolves.toEqual({ machine: 'x86_64' });
      expect(publisher.getProgress).not.toHaveBeenCalled();
      expect(setIntervalSpy).not.toHaveBeenCalled();
    },
  );

  it('caps the polling interval and clears it after normal completion', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const { dispatcher, registry, publisher } = buildRig();
    const handle = registry.register('dev-completes');

    const dispatchPromise = dispatcher.dispatch(
      'dev-completes',
      'collection.architecture',
      {},
      { timeoutS: 180, stallTimeoutS: 120, workId: 'work-completes' },
    );
    await handle.queue.get();
    publisher.publishResult('work-completes', buildSuccessResponse('work-completes', { machine: 'aarch64' }));

    await expect(dispatchPromise).resolves.toEqual({ machine: 'aarch64' });
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it('clears the polling interval after the absolute timeout', async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const { dispatcher, registry } = buildRig();
    const handle = registry.register('dev-absolute-timeout');

    const dispatchPromise = dispatcher.dispatch(
      'dev-absolute-timeout',
      'storage.wipeDisks',
      {},
      { timeoutS: 1, stallTimeoutS: 10, workId: 'work-absolute-timeout' },
    );
    await handle.queue.get();
    const errorPromise = dispatchPromise.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(errorPromise).resolves.toBeInstanceOf(DispatchTimeout);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });
});

describe('Dispatcher.dispatchTyped', () => {
  it('returns the response parsed through the operation output schema', async () => {
    const { dispatcher, registry, publisher } = buildRig();
    const handle = registry.register('dev-typed');

    const dispatchPromise = dispatcher.dispatchTyped('dev-typed', 'system.getArchitecture', {});

    const msg = (await handle.queue.get()) as QueueEnvelope;
    const wr = msg.workRequest!;
    publisher.publishResult(wr.workId, buildSuccessResponse(wr.workId, { arch: 'x86_64', raw: 'x86_64' }));

    const result = await dispatchPromise;
    expect(result).toEqual({ arch: 'x86_64', raw: 'x86_64' });
    expect(result.arch).toBe('x86_64');
  });

  it('strips agent-added unknown keys, keeping the schema-defined shape', async () => {
    const { dispatcher, registry, publisher } = buildRig();
    const handle = registry.register('dev-typed-extra');

    const dispatchPromise = dispatcher.dispatchTyped('dev-typed-extra', 'system.getArchitecture', {});

    const msg = (await handle.queue.get()) as QueueEnvelope;
    const wr = msg.workRequest!;
    publisher.publishResult(
      wr.workId,
      buildSuccessResponse(wr.workId, { arch: 'aarch64', raw: 'aarch64', surprise: 'ignored' }),
    );

    await expect(dispatchPromise).resolves.toEqual({ arch: 'aarch64', raw: 'aarch64' });
  });

  it('raises a single DispatchFailed(OUTPUT_VALIDATION) when the response violates the schema', async () => {
    const { dispatcher, registry, publisher } = buildRig();
    const handle = registry.register('dev-typed-bad');

    const dispatchPromise = dispatcher.dispatchTyped('dev-typed-bad', 'system.getArchitecture', {});

    const msg = (await handle.queue.get()) as QueueEnvelope;
    const wr = msg.workRequest!;
    publisher.publishResult(wr.workId, buildSuccessResponse(wr.workId, { arch: 'sparc' }));

    await expect(dispatchPromise).rejects.toMatchObject({
      name: 'DispatchFailed',
      code: 'OUTPUT_VALIDATION',
    });
    await expect(dispatchPromise).rejects.toThrowError(/did not match its protocol output schema/);
  });
});

describe('Dispatcher tracing', () => {
  const exporter = new InMemorySpanExporter();

  beforeAll(() => {
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    trace.setGlobalTracerProvider(provider);
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  });

  afterAll(() => {
    trace.disable();
    context.disable();
    propagation.disable();
  });

  beforeEach(() => {
    exporter.reset();
  });

  it('wraps dispatch in a CLIENT span and injects its traceparent onto the WorkRequest', async () => {
    const { dispatcher, registry, publisher } = buildRig();
    const handle = registry.register('dev-traced');

    const dispatchPromise = dispatcher.dispatch('dev-traced', 'test.echo', { v: 1 }, { jobId: 'job-t1' });

    const msg = (await handle.queue.get()) as QueueEnvelope;
    const wr = msg.workRequest!;
    publisher.publishResult(wr.workId, buildSuccessResponse(wr.workId, { ok: true }));
    await dispatchPromise;

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.name).toBe('agent.dispatch test.echo');
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.attributes['brokkr.device_id']).toBe('dev-traced');
    expect(span.attributes['brokkr.operation']).toBe('test.echo');
    expect(span.attributes['brokkr.job_id']).toBe('job-t1');
    expect(span.attributes['brokkr.work_id']).toBe(wr.workId);
    expect(span.status.code).not.toBe(SpanStatusCode.ERROR);

    const sc = span.spanContext();
    expect(wr.traceparent).toBe(`00-${sc.traceId}-${sc.spanId}-01`);
  });

  it('records ERROR status when the agent reports failure', async () => {
    const { dispatcher, registry, publisher } = buildRig();
    const handle = registry.register('dev-traced-fail');

    const dispatchPromise = dispatcher.dispatch('dev-traced-fail', 'test.echo', {});

    const msg = (await handle.queue.get()) as QueueEnvelope;
    const wr = msg.workRequest!;
    publisher.publishResult(wr.workId, buildFailureResponse(wr.workId, 'OPERATION_FAILED', 'boom'));
    await expect(dispatchPromise).rejects.toMatchObject({ name: 'DispatchFailed' });

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('leaves trace fields unset when no telemetry is registered (noop tracer)', async () => {
    trace.disable();
    propagation.disable();
    try {
      const { dispatcher, registry, publisher } = buildRig();
      const handle = registry.register('dev-untraced');

      const dispatchPromise = dispatcher.dispatch('dev-untraced', 'test.echo', {});

      const msg = (await handle.queue.get()) as QueueEnvelope;
      const wr = msg.workRequest!;
      expect(wr.traceparent).toBeUndefined();
      expect(wr.tracestate).toBeUndefined();
      publisher.publishResult(wr.workId, buildSuccessResponse(wr.workId, { ok: true }));
      await dispatchPromise;
    } finally {
      const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
      trace.setGlobalTracerProvider(provider);
      propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    }
  });
});

void silentLogger;
