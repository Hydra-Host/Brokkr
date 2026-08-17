import { createPublicKey, generateKeyPairSync } from 'node:crypto';

import { UnrecoverableError } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { canonicalizeAad, seal as cryptoSeal } from '@repo/crypto';
import { AgentNotConnected, AgentNotResponsive } from '../../agent/dispatch/grpc.exceptions.js';
import { LOCK_WAIT_STEP_NAME } from '../../saga-framework/notifications.service.js';
import { LockLost } from '../../saga-framework/saga-runner.service.js';
import { JobStatus } from '../../saga-framework/state.types.js';
import { SealKeyUnknownError, SealOpenError } from '../../zone-crypto/auth-dh.types.js';
import { SealedEnvelopeService } from '../../zone-crypto/sealed-envelope.service.js';
import { ZoneCryptoService, type ZoneCryptoSnapshot } from '../../zone-crypto/zone-crypto.service.js';
import {
  DeviceLockWaitExceeded,
  EnvelopeDeferralBudgetExceeded,
  HANDOFF_ABANDON_DEADLINE_SECONDS,
  HandoffAbandoned,
  PlaintextAfterActivationError,
} from '../bullmq.types.js';
import { CollectionJobHandler } from '../collection.handler.js';
import {
  BullmqProcessorService,
  CrossBridgeHandoff,
  DeviceLockUnavailable,
  type BullmqProcessorConfig,
  type BullmqProcessorLogger,
  type InboundEnvelopeOpener,
  type JobHandler,
  type LifecycleNotifications,
  type LifecyclePlanFailure,
  type LockWaitCache,
  type ProcessableJob,
} from '../handlers.service.js';
import { InboundEnvelopeOpenerService } from '../inbound-envelope.service.js';
import { redactPayloadForLog } from '../redact.js';
import type { SagaPayloadSchemaRegistry } from '../saga-payload-validate.js';
import {
  SagaJobHandler,
  type SagaCooldownClearer,
  type SagaDefProvider,
  type SagaHandlerCache,
  type SagaHandlerConfig,
  type SagaHandlerLogger,
  type SagaPlanManagerLike,
  type SagaRunnerLike,
} from '../saga.handler.js';
import { CURRENT_ENVELOPE_VERSION, DIRECTION_HUB_TO_BRIDGE } from '../sealed-envelope.js';

const ZONE_ID = '00000000-0000-4000-8000-000000000001';

const SILENT = {
  debug: async () => {},
  info: async () => {},
  warning: async () => {},
  error: async () => {},
};
const LIFECYCLE_QUEUE = 'lifecycle';
const COLLECTION_QUEUE = 'collection';

type MoveToDelayedFn = ProcessableJob<unknown>['scripts']['moveToDelayed'];

interface FakeJobOpts<T> {
  name: string;
  data: T;
  queueName?: string;
  id?: string | null;
  moveToDelayed?: MoveToDelayedFn;
}

function makeJob<T>(opts: FakeJobOpts<T>): ProcessableJob<T> {
  const noop: MoveToDelayedFn = async () => {};
  return {
    id: opts.id ?? 'job-id',
    name: opts.name,
    data: opts.data,
    queue: { name: opts.queueName ?? LIFECYCLE_QUEUE, opts: {} },
    scripts: {
      moveToDelayed: opts.moveToDelayed ?? noop,
    },
  };
}

const PASSTHROUGH_OPENER: InboundEnvelopeOpener = {
  async open(job) {
    return { payload: job.data, createdAtMs: Date.now(), isBridgeLocal: false };
  },
};

interface ProcessorOverrides {
  opener?: InboundEnvelopeOpener;
  cache?: LockWaitCache;
  planManager?: LifecyclePlanFailure;
  notifications?: LifecycleNotifications;
  config?: Partial<BullmqProcessorConfig>;
  logger?: BullmqProcessorLogger;
}

function makeProcessor(
  handlers: Readonly<Record<string, JobHandler | undefined>>,
  overrides: ProcessorOverrides = {},
): BullmqProcessorService {
  return new BullmqProcessorService(
    handlers,
    overrides.opener ?? PASSTHROUGH_OPENER,
    overrides.logger ?? SILENT,
    {
      lockWaitWarningSeconds: 60,
      lockWaitHardCapSeconds: 0,
      lockLostRedelaySeconds: 90,
      ...overrides.config,
    },
    overrides.cache ?? {
      get: async () => null,
      set: async () => undefined,
      delete: async () => 0,
    },
    overrides.planManager ?? { failPlan: async () => undefined },
    overrides.notifications ?? { notifyStepTransition: async () => undefined },
  );
}

const EMPTY_SCHEMAS: SagaPayloadSchemaRegistry = {};
const LOCK_WAIT_CACHE_METHODS = {
  readLockInfo: async () => null,
  get: async () => null,
  set: async () => undefined,
  delete: async () => 0,
};

function makeSagaConfig(): SagaHandlerConfig {
  return {
    bullmqQueueName: LIFECYCLE_QUEUE,
    deviceLockTimeoutSeconds: 60,
    deviceLockRenewIntervalSeconds: 20,
    lockWaitWarningSeconds: 60,
    lockWaitHardCapSeconds: 0,
  };
}

interface SagaFakes {
  cache: SagaHandlerCache;
  planManager: SagaPlanManagerLike;
  runner: SagaRunnerLike;
  sagaProvider: SagaDefProvider;
  cooldown: SagaCooldownClearer;
  config: SagaHandlerConfig;
  logger: SagaHandlerLogger;
}

function makeSagaFakes(overrides: Partial<SagaFakes> = {}): SagaFakes {
  return {
    cache: overrides.cache ?? {
      ...LOCK_WAIT_CACHE_METHODS,
      acquireLock: async () => 'token-123',
      releaseLock: async () => true,
      renewLockIfOwner: async () => true,
    },
    planManager: overrides.planManager ?? {
      start: async () => {},
      getPlan: async () => ({ exists: true }),
      failPlan: async () => {},
      createPlanFromSaga: async () => ({}),
      backfillOriginalPayload: async () => {},
    },
    runner: overrides.runner ?? {
      execute: async () => ({ status: 'completed' }),
    },
    sagaProvider: overrides.sagaProvider ?? {
      getSagaDef: () => ({ name: 'fake' }) as never,
    },
    cooldown: overrides.cooldown ?? {
      clearCooldownAndEnqueue: async () => {},
    },
    config: overrides.config ?? makeSagaConfig(),
    logger: overrides.logger ?? SILENT,
  };
}

function makeSagaHandler(overrides: Partial<SagaFakes> = {}): SagaJobHandler {
  const fakes = makeSagaFakes(overrides);
  return new SagaJobHandler(
    fakes.cache,
    fakes.planManager,
    fakes.runner,
    fakes.sagaProvider,
    EMPTY_SCHEMAS,
    fakes.config,
    fakes.cooldown,
    fakes.logger,
  );
}

describe('BullmqProcessorService.process', () => {
  it('routes saga.run to the registered handler', async () => {
    const seenJobs: ProcessableJob<Record<string, unknown>>[] = [];
    const sagaHandler: JobHandler = async (job) => {
      seenJobs.push(job);
      return { plan_id: 'plan-1', status: 'completed' };
    };
    const service = makeProcessor({ 'saga.run': sagaHandler });

    const job = makeJob({
      name: 'saga.run',
      data: {
        plan_id: 'plan-1',
        saga_name: 'deprovision',
        payload: { device_id: 'dev-1' },
      },
    });
    const result = await service.process(job, 'token');

    expect(result).toEqual({ plan_id: 'plan-1', status: 'completed' });
    expect(seenJobs).toHaveLength(1);
    expect(seenJobs[0].data.plan_id).toBe('plan-1');
  });

  it('stamps bridge-local provenance onto the job before dispatch', async () => {
    let seen: boolean | undefined;
    const handler: JobHandler = async (job) => {
      seen = job.isBridgeLocal;
      return {};
    };
    const service = makeProcessor(
      { 'saga.run': handler },
      { opener: { open: async (job) => ({ payload: job.data, createdAtMs: Date.now(), isBridgeLocal: true }) } },
    );
    await service.process(makeJob({ name: 'saga.run', data: { plan_id: 'plan-1' } }), 'token');
    expect(seen).toBe(true);
  });

  it('raises for unknown job type', async () => {
    const service = makeProcessor({});
    const job = makeJob({ name: 'unknown.type', data: {} });

    await expect(service.process(job, 'token')).rejects.toThrow(/No handler registered/);
  });

  it('moves to delayed and throws CrossBridgeHandoff on AgentNotConnected', async () => {
    const moveToDelayed = vi.fn<MoveToDelayedFn>(async () => {});
    const error = vi.fn<BullmqProcessorLogger['error']>(async () => {});
    const failingHandler: JobHandler = async () => {
      throw new AgentNotConnected('99');
    };
    const service = makeProcessor({ 'collection.run': failingHandler }, { logger: { ...SILENT, error } });
    const job = makeJob({
      name: 'collection.run',
      data: { device_id: 99, plan_id: 'plan-x' },
      id: 'bull-job-abc',
      moveToDelayed,
    });

    await expect(service.process(job, 'tok-1')).rejects.toBeInstanceOf(CrossBridgeHandoff);
    expect(moveToDelayed).toHaveBeenCalledTimes(1);
    const [jobId, _ts, delayMs, token] = moveToDelayed.mock.calls[0];
    expect(jobId).toBe('bull-job-abc');
    expect(delayMs).toBe(5_000);
    expect(token).toBe('tok-1');
    expect(moveToDelayed.mock.calls[0][4]).toMatchObject({ skipAttempt: true });
    expect(moveToDelayed.mock.calls[0][4].fieldsToUpdate).toBeUndefined();
    expect(error).not.toHaveBeenCalled();
  });

  it('moves to delayed and throws CrossBridgeHandoff on AgentNotResponsive', async () => {
    const moveToDelayed = vi.fn<MoveToDelayedFn>(async () => {});
    const error = vi.fn<BullmqProcessorLogger['error']>(async () => {});
    const failingHandler: JobHandler = async () => {
      throw new AgentNotResponsive('99', 256);
    };
    const service = makeProcessor({ 'collection.run': failingHandler }, { logger: { ...SILENT, error } });
    const job = makeJob({
      name: 'collection.run',
      data: { device_id: 99 },
      id: 'bull-job-xyz',
      moveToDelayed,
    });

    await expect(service.process(job, 'tok-2')).rejects.toBeInstanceOf(CrossBridgeHandoff);
    expect(moveToDelayed).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  it('fails the job with an abandon verdict once the handoff deferral deadline is exceeded', async () => {
    const moveToDelayed = vi.fn<MoveToDelayedFn>(async () => {});
    const failPlan = vi.fn<LifecyclePlanFailure['failPlan']>(async () => {});
    const del = vi.fn<LockWaitCache['delete']>(async () => 1);
    const staleFirstDeferredAt = Date.now() / 1_000 - (HANDOFF_ABANDON_DEADLINE_SECONDS + 60);
    const cache: LockWaitCache = {
      get: async (key) =>
        key.startsWith('handoff-defer:')
          ? JSON.stringify({ first_deferred_at: staleFirstDeferredAt, attempts: 42 })
          : null,
      set: async () => undefined,
      delete: del,
    };
    const failingHandler: JobHandler = async () => {
      throw new AgentNotConnected('99');
    };
    const service = makeProcessor({ 'collection.run': failingHandler }, { cache, planManager: { failPlan } });
    const job = makeJob({
      name: 'collection.run',
      data: { device_id: 99, plan_id: 'enrich-plan-x' },
      id: 'bull-collect-1',
      queueName: COLLECTION_QUEUE,
      moveToDelayed,
    });

    await expect(service.process(job, 'tok')).rejects.toBeInstanceOf(HandoffAbandoned);
    await expect(service.process(job, 'tok')).rejects.toBeInstanceOf(UnrecoverableError);
    expect(moveToDelayed).not.toHaveBeenCalled();
    expect(failPlan).toHaveBeenCalledWith(
      'enrich-plan-x',
      'discovery agent never connected — device did not boot brokkr-live',
    );
    expect(del).toHaveBeenCalled();
  });

  it('keeps rescheduling a short-lived handoff before the deadline and persists deferral state', async () => {
    const moveToDelayed = vi.fn<MoveToDelayedFn>(async () => {});
    const failPlan = vi.fn<LifecyclePlanFailure['failPlan']>(async () => {});
    const set = vi.fn<LockWaitCache['set']>(async () => undefined);
    const cache: LockWaitCache = {
      get: async () => null,
      set,
      delete: async () => 0,
    };
    const failingHandler: JobHandler = async () => {
      throw new AgentNotConnected('99');
    };
    const service = makeProcessor({ 'collection.run': failingHandler }, { cache, planManager: { failPlan } });
    const job = makeJob({
      name: 'collection.run',
      data: { device_id: 99, plan_id: 'enrich-plan-y' },
      id: 'bull-collect-2',
      queueName: COLLECTION_QUEUE,
      moveToDelayed,
    });

    await expect(service.process(job, 'tok')).rejects.toBeInstanceOf(CrossBridgeHandoff);
    expect(moveToDelayed).toHaveBeenCalledTimes(1);
    expect(failPlan).not.toHaveBeenCalled();
    const deferSet = set.mock.calls.find(([key]) => String(key).startsWith('handoff-defer:'));
    expect(deferSet).toBeDefined();
    expect(JSON.parse(String(deferSet?.[1])).attempts).toBe(1);
  });

  it('clears handoff deferral state when the job finally succeeds', async () => {
    const del = vi.fn<LockWaitCache['delete']>(async () => 1);
    const cache: LockWaitCache = { get: async () => null, set: async () => undefined, delete: del };
    const okHandler: JobHandler = async () => ({ status: 'complete' });
    const service = makeProcessor({ 'collection.run': okHandler }, { cache });
    const job = makeJob({
      name: 'collection.run',
      data: { device_id: 99, plan_id: 'enrich-plan-z' },
      id: 'bull-collect-3',
      queueName: COLLECTION_QUEUE,
    });

    await service.process(job, 'tok');
    expect(del).toHaveBeenCalledWith('handoff-defer:bull-collect-3', 'enrich-plan-z');
  });

  it('records contention and moves DeviceLockUnavailable to delayed without consuming an attempt', async () => {
    const moveToDelayed = vi.fn<MoveToDelayedFn>(async () => {});
    const set = vi.fn<LockWaitCache['set']>(async () => undefined);
    const failingHandler: JobHandler = async () => {
      throw new DeviceLockUnavailable('lock:device:42', {
        plan_id: 'holder-plan',
        saga_name: 'provision',
      });
    };
    const service = makeProcessor(
      { 'saga.run': failingHandler },
      {
        cache: {
          get: async () => null,
          set,
          delete: async () => 0,
        },
      },
    );
    const job = makeJob({
      name: 'saga.run',
      data: { plan_id: 'plan-waiting', saga_name: 'deprovision', payload: { device_id: 'device-42' } },
      id: 'bull-waiting',
      moveToDelayed,
    });

    await expect(service.process(job, 'tok-3')).rejects.toBeInstanceOf(CrossBridgeHandoff);
    expect(moveToDelayed).toHaveBeenCalledTimes(1);
    expect(moveToDelayed.mock.calls[0][4]).toMatchObject({ skipAttempt: true });
    expect(set).toHaveBeenCalledTimes(1);
    expect(JSON.parse(set.mock.calls[0][1])).toMatchObject({
      attempts: 1,
      lock_key: 'lock:device:42',
      holder_plan_id: 'holder-plan',
      holder_saga_name: 'provision',
    });
  });

  it('reschedules saga lock contention exactly once', async () => {
    const moveToDelayed = vi.fn<MoveToDelayedFn>(async () => {});
    const cache = {
      ...LOCK_WAIT_CACHE_METHODS,
      acquireLock: async () => null,
      releaseLock: async () => true,
      renewLockIfOwner: async () => true,
    };
    const sagaHandler = makeSagaHandler({
      cache,
    });
    const service = makeProcessor({ 'saga.run': sagaHandler.handle }, { cache });
    const job = makeJob({
      name: 'saga.run',
      data: {
        plan_id: 'plan-contended',
        saga_name: 'power_off',
        payload: { device_id: 'dev-contended' },
      },
      moveToDelayed,
    });

    await expect(service.process(job, 'worker-token')).rejects.toBeInstanceOf(CrossBridgeHandoff);
    expect(moveToDelayed).toHaveBeenCalledTimes(1);
    expect(moveToDelayed.mock.calls[0][2]).toBe(5_000);
    expect(moveToDelayed.mock.calls[0][3]).toBe('worker-token');
    expect(moveToDelayed.mock.calls[0][4]).toMatchObject({ skipAttempt: true });
  });

  it('fails stale saga lock contention without redelivery', async () => {
    const moveToDelayed = vi.fn<MoveToDelayedFn>(async () => {});
    const failPlan = vi.fn<LifecyclePlanFailure['failPlan']>(async () => undefined);
    const sagaHandler = makeSagaHandler({
      cache: {
        ...LOCK_WAIT_CACHE_METHODS,
        acquireLock: async () => null,
        releaseLock: async () => true,
        renewLockIfOwner: async () => true,
      },
    });
    const payload = {
      plan_id: 'plan-stale-lock',
      saga_name: 'power_off',
      payload: { device_id: 'device-stale-lock' },
    };
    const service = makeProcessor(
      { 'saga.run': sagaHandler.handle },
      {
        opener: {
          open: async () => ({ payload, createdAtMs: Date.now() - 300_000, isBridgeLocal: false }),
        },
        planManager: { failPlan },
      },
    );
    const job = makeJob({ name: 'saga.run', data: {}, id: 'stale-lock-job', moveToDelayed });

    await expect(service.process(job, 'worker-token')).rejects.toBeInstanceOf(EnvelopeDeferralBudgetExceeded);
    expect(moveToDelayed).not.toHaveBeenCalled();
    expect(failPlan).toHaveBeenCalledWith(
      'plan-stale-lock',
      'Envelope freshness budget exhausted before lock contention: device:device-stale-lock',
    );
  });

  it('moves LockLost to delayed for the default recovery delay and throws CrossBridgeHandoff', async () => {
    const moveToDelayed = vi.fn<MoveToDelayedFn>(async () => {});
    const failingHandler: JobHandler = async () => {
      throw new LockLost('device lock expired');
    };
    const service = new BullmqProcessorService({ 'saga.run': failingHandler }, PASSTHROUGH_OPENER);
    const job = makeJob({
      name: 'saga.run',
      data: {},
      id: 'lock-lost-job',
      moveToDelayed,
    });

    await expect(service.process(job, 'lock-lost-token')).rejects.toBeInstanceOf(CrossBridgeHandoff);
    expect(moveToDelayed).toHaveBeenCalledTimes(1);
    const [jobId, _timestamp, delayMs, token] = moveToDelayed.mock.calls[0];
    expect(jobId).toBe('lock-lost-job');
    expect(delayMs).toBe(90_000);
    expect(token).toBe('lock-lost-token');
  });

  it('propagates a custom lock-loss delay without environment mutation', async () => {
    const customDelayMs = 123_456;
    const moveToDelayed = vi.fn<MoveToDelayedFn>(async () => {});
    const failingHandler: JobHandler = async () => {
      throw new LockLost('renewal ownership changed');
    };
    const service = new BullmqProcessorService(
      { 'saga.run': failingHandler },
      PASSTHROUGH_OPENER,
      undefined,
      customDelayMs,
    );
    const job = makeJob({ name: 'saga.run', data: {}, moveToDelayed });
    const before = Date.now();

    await expect(service.process(job, 'custom-token')).rejects.toBeInstanceOf(CrossBridgeHandoff);

    const [_jobId, timestamp, delayMs, , opts] = moveToDelayed.mock.calls[0];
    expect(delayMs).toBe(customDelayMs);
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(Date.now());
    expect(opts.skipAttempt).toBe(true);
    expect(opts.fieldsToUpdate).toBeUndefined();
  });

  it('logs an unexpected handler error once with job and plan context and does not reschedule', async () => {
    const moveToDelayed = vi.fn<MoveToDelayedFn>(async () => {});
    const error = vi.fn<BullmqProcessorLogger['error']>(async () => {});
    const failure = new Error('boom');
    const failingHandler: JobHandler = async () => {
      throw failure;
    };
    const service = makeProcessor({ 'saga.run': failingHandler }, { logger: { ...SILENT, error } });
    const job = makeJob({
      name: 'saga.run',
      data: { plan_id: 'plan-boom' },
      id: 'bull-boom',
      moveToDelayed,
    });

    await expect(service.process(job, 'tok')).rejects.toBe(failure);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith('Job handler failed: name=saga.run id=bull-boom: boom', {
      jobId: 'plan-boom',
    });
    expect(moveToDelayed).not.toHaveBeenCalled();
  });

  it('logs LockLost once at the processor and redelays with configured recovery semantics', async () => {
    const moveToDelayed = vi.fn<MoveToDelayedFn>(async () => {});
    const warning = vi.fn<BullmqProcessorLogger['warning']>(async () => {});
    const error = vi.fn<BullmqProcessorLogger['error']>(async () => {});
    const failingHandler: JobHandler = async () => {
      throw new LockLost('device lock expired');
    };
    const service = makeProcessor(
      { 'saga.run': failingHandler },
      {
        config: { lockLostRedelaySeconds: 123 },
        logger: { ...SILENT, warning, error },
      },
    );
    const job = makeJob({
      name: 'saga.run',
      data: { plan_id: 'plan-lock', saga_name: 'provision' },
      id: 'bull-lock',
      moveToDelayed,
    });
    const before = Date.now();

    await expect(service.process(job, 'lock-token')).rejects.toBeInstanceOf(CrossBridgeHandoff);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    expect(moveToDelayed).toHaveBeenCalledTimes(1);
    const [jobId, timestamp, delayMs, token, options] = moveToDelayed.mock.calls[0];
    expect(jobId).toBe('bull-lock');
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(Date.now());
    expect(delayMs).toBe(123_000);
    expect(token).toBe('lock-token');
    expect(options.skipAttempt).toBe(true);
    expect(options.fieldsToUpdate).toBeUndefined();
  });

  it('fails the plan when a lock-loss redelay exceeds the envelope freshness budget', async () => {
    const moveToDelayed = vi.fn<MoveToDelayedFn>(async () => {});
    const failPlan = vi.fn<LifecyclePlanFailure['failPlan']>(async () => undefined);
    const notifyStepTransition = vi.fn<LifecycleNotifications['notifyStepTransition']>(async () => undefined);
    const payload = {
      plan_id: 'plan-stale',
      saga_name: 'provision',
      payload: { device_id: 'device-1' },
    };
    const service = makeProcessor(
      {
        'saga.run': async () => {
          throw new LockLost('device lock expired');
        },
      },
      {
        opener: {
          open: async () => ({ payload, createdAtMs: Date.now() - 250_000, isBridgeLocal: false }),
        },
        planManager: { failPlan },
        notifications: { notifyStepTransition },
      },
    );
    const job = makeJob({ name: 'saga.run', data: {}, id: 'bull-stale', moveToDelayed });

    await expect(service.process(job, 'lock-token')).rejects.toBeInstanceOf(EnvelopeDeferralBudgetExceeded);
    expect(moveToDelayed).not.toHaveBeenCalled();
    expect(failPlan).toHaveBeenCalledWith(
      'plan-stale',
      'Envelope freshness budget exhausted before lock recovery: device lock expired',
    );
    expect(notifyStepTransition).toHaveBeenCalledExactlyOnceWith({
      planId: 'plan-stale',
      stepName: '__plan__',
      status: JobStatus.FAILED,
      deviceId: 'device-1',
      error: 'Envelope freshness budget exhausted before lock recovery: device lock expired',
      metadata: { saga_name: 'provision' },
    });
  });

  it('fails the lifecycle plan and raises DeviceLockWaitExceeded beyond the hard cap', async () => {
    const now = Date.now() / 1_000;
    const moveToDelayed = vi.fn<MoveToDelayedFn>(async () => {});
    const failPlan = vi.fn<LifecyclePlanFailure['failPlan']>(async () => undefined);
    const notifyStepTransition = vi.fn<LifecycleNotifications['notifyStepTransition']>(async () => undefined);
    const failingHandler: JobHandler = async () => {
      throw new DeviceLockUnavailable('device:locked');
    };
    const service = makeProcessor(
      { 'saga.run': failingHandler },
      {
        cache: {
          get: async () =>
            JSON.stringify({
              first_deferred_at: now - 11,
              first_blocked_at: now - 11,
              attempts: 3,
              reason: 'lock_contention',
              lock_key: 'device:locked',
              last_notified_at: 0,
            }),
          set: async () => undefined,
          delete: async () => 0,
        },
        planManager: { failPlan },
        notifications: { notifyStepTransition },
        config: { lockWaitHardCapSeconds: 10 },
      },
    );
    const job = makeJob({
      name: 'saga.run',
      data: { plan_id: 'plan-capped', saga_name: 'provision', payload: { device_id: 'device-1' } },
      id: 'bull-capped',
      moveToDelayed,
    });

    await expect(service.process(job, 'token')).rejects.toBeInstanceOf(DeviceLockWaitExceeded);
    expect(failPlan).toHaveBeenCalledWith('plan-capped', 'Lock wait exceeded hard cap (10s) on device:locked');
    expect(notifyStepTransition).toHaveBeenCalledTimes(2);
    expect(notifyStepTransition.mock.calls[0][0]).toMatchObject({
      planId: 'plan-capped',
      stepName: LOCK_WAIT_STEP_NAME,
      status: JobStatus.FAILED,
      deviceId: 'device-1',
    });
    expect(notifyStepTransition.mock.calls[1][0]).toMatchObject({
      planId: 'plan-capped',
      stepName: '__plan__',
      status: JobStatus.FAILED,
    });
    expect(moveToDelayed).not.toHaveBeenCalled();
  });

  it('cleans stored lock-wait state after successful handling', async () => {
    const deleteState = vi.fn<LockWaitCache['delete']>(async () => 1);
    const service = makeProcessor(
      { 'saga.run': async () => ({ status: 'complete' }) },
      {
        cache: {
          get: async () =>
            JSON.stringify({
              first_blocked_at: Date.now() / 1_000,
              attempts: 1,
              lock_key: 'device:1',
              last_notified_at: 0,
            }),
          set: async () => undefined,
          delete: deleteState,
        },
      },
    );
    const job = makeJob({ name: 'saga.run', data: { plan_id: 'plan-clean' }, id: 'bull-clean' });

    await service.process(job, 'token');
    expect(deleteState).toHaveBeenCalledWith('lockwait:bull-clean', 'plan-clean');
  });
});

describe('SagaJobHandler', () => {
  it('returns plan_id + status, releases the lock, and clears cooldown when the runner succeeds', async () => {
    const releaseLock = vi.fn(async () => true);
    const clearCooldownAndEnqueue = vi.fn(async () => {});
    const handler = makeSagaHandler({
      cache: {
        acquireLock: async () => 'token-123',
        releaseLock,
        renewLockIfOwner: async () => true,
      },
      cooldown: { clearCooldownAndEnqueue },
    });
    const job = makeJob({
      name: 'saga.run',
      data: {
        plan_id: 'plan-1',
        saga_name: 'deprovision',
        payload: { device_id: 'dev-1' },
      },
    }) as ProcessableJob<Record<string, unknown>>;

    const result = await handler.handle(job, 'token');
    expect(result).toEqual({ plan_id: 'plan-1', status: 'completed' });
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(clearCooldownAndEnqueue).toHaveBeenCalledTimes(1);
    expect(clearCooldownAndEnqueue).toHaveBeenCalledWith('dev-1', 'plan-1');
  });

  it('throws for unknown saga workflow', async () => {
    const handler = makeSagaHandler({
      sagaProvider: { getSagaDef: () => null },
    });
    const job = makeJob({
      name: 'saga.run',
      data: {
        plan_id: 'plan-x',
        saga_name: 'nonexistent',
        payload: { device_id: 99 },
      },
    }) as ProcessableJob<Record<string, unknown>>;

    await expect(handler.handle(job, 'token')).rejects.toThrow(/Unknown saga workflow/);
  });

  it('reports lock contention to the processor', async () => {
    const moveToDelayed = vi.fn<MoveToDelayedFn>(async () => {});
    const handler = makeSagaHandler({
      cache: {
        ...LOCK_WAIT_CACHE_METHODS,
        acquireLock: async () => null,
        releaseLock: async () => true,
        renewLockIfOwner: async () => true,
      },
    });
    const job = makeJob({
      name: 'saga.run',
      data: {
        plan_id: 'plan-locked',
        saga_name: 'power_off',
        payload: { device_id: 'dev-locked' },
      },
      moveToDelayed,
    }) as ProcessableJob<Record<string, unknown>>;

    await expect(handler.handle(job, 'worker-token')).rejects.toBeInstanceOf(DeviceLockUnavailable);
    expect(moveToDelayed).not.toHaveBeenCalled();
  });

  it('returns status=unknown when the runner resolves to null', async () => {
    const handler = makeSagaHandler({
      runner: { execute: async () => null },
    });
    const job = makeJob({
      name: 'saga.run',
      data: {
        plan_id: 'plan-2',
        saga_name: 'deprovision',
        payload: { device_id: 'dev-1' },
      },
    }) as ProcessableJob<Record<string, unknown>>;

    const result = await handler.handle(job, 'token');
    expect(result).toEqual({ plan_id: 'plan-2', status: 'unknown' });
  });

  it('releases the lock without clearing cooldown when the runner fails', async () => {
    const sagaError = new Error('saga failed');
    const releaseLock = vi.fn(async () => true);
    const clearCooldownAndEnqueue = vi.fn(async () => {});
    const handler = makeSagaHandler({
      cache: {
        acquireLock: async () => 'token-123',
        releaseLock,
        renewLockIfOwner: async () => true,
      },
      runner: {
        execute: async () => {
          throw sagaError;
        },
      },
      cooldown: { clearCooldownAndEnqueue },
    });

    await expect(
      handler.handle(
        makeJob({
          name: 'saga.run',
          data: {
            plan_id: 'plan-failed',
            saga_name: 'deprovision',
            payload: { device_id: 'dev-1' },
          },
        }),
      ),
    ).rejects.toBe(sagaError);
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(clearCooldownAndEnqueue).not.toHaveBeenCalled();
  });

  it('warning-logs release errors without replacing a successful saga result', async () => {
    const releaseError = new Error('redis release failed');
    const warnings: string[] = [];
    const clearCooldownAndEnqueue = vi.fn(async () => {});
    const handler = new SagaJobHandler(
      {
        acquireLock: async () => 'token-123',
        releaseLock: async () => {
          throw releaseError;
        },
        renewLockIfOwner: async () => true,
      },
      makeSagaFakes().planManager,
      makeSagaFakes().runner,
      makeSagaFakes().sagaProvider,
      EMPTY_SCHEMAS,
      makeSagaConfig(),
      { clearCooldownAndEnqueue },
      {
        ...SILENT,
        warning: async (message: string) => {
          warnings.push(message);
        },
      },
    );

    await expect(
      handler.handle(
        makeJob({
          name: 'saga.run',
          data: {
            plan_id: 'plan-release-error',
            saga_name: 'deprovision',
            payload: { device_id: 'dev-1' },
          },
        }),
      ),
    ).resolves.toEqual({ plan_id: 'plan-release-error', status: 'completed' });
    expect(warnings).toContain('Failed to release lock device:dev-1: redis release failed');
    expect(clearCooldownAndEnqueue).toHaveBeenCalledTimes(1);
  });

  it('warning-logs release errors without replacing the saga error', async () => {
    const sagaError = new Error('original saga failure');
    const warnings: string[] = [];
    const releaseLock = vi.fn(async () => {
      throw new Error('redis release failed');
    });
    const handler = new SagaJobHandler(
      {
        acquireLock: async () => 'token-123',
        releaseLock,
        renewLockIfOwner: async () => true,
      },
      makeSagaFakes().planManager,
      {
        execute: async () => {
          throw sagaError;
        },
      },
      makeSagaFakes().sagaProvider,
      EMPTY_SCHEMAS,
      makeSagaConfig(),
      { clearCooldownAndEnqueue: async () => {} },
      {
        ...SILENT,
        warning: async (message: string) => {
          warnings.push(message);
        },
      },
    );

    await expect(
      handler.handle(
        makeJob({
          name: 'saga.run',
          data: {
            plan_id: 'plan-double-error',
            saga_name: 'deprovision',
            payload: { device_id: 'dev-1' },
          },
        }),
      ),
    ).rejects.toBe(sagaError);
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(warnings).toContain('Failed to release lock device:dev-1: redis release failed');
  });

  it('leaves runner failure logging to the processor boundary', async () => {
    const error = vi.fn<SagaHandlerLogger['error']>(async () => {});
    const failure = new Error('runner failed');
    const handler = makeSagaHandler({
      runner: {
        execute: async () => {
          throw failure;
        },
      },
      logger: { ...SILENT, error },
    });
    const job = makeJob({
      name: 'saga.run',
      data: {
        plan_id: 'plan-runner-failure',
        saga_name: 'deprovision',
        payload: { device_id: 'dev-1' },
      },
    }) as ProcessableJob<Record<string, unknown>>;

    await expect(handler.handle(job)).rejects.toBe(failure);
    expect(error).not.toHaveBeenCalled();
  });

  it('creates a plan when none exists', async () => {
    const createPlanFromSaga = vi.fn<SagaPlanManagerLike['createPlanFromSaga']>(async () => ({}));
    const handler = makeSagaHandler({
      planManager: {
        start: async () => {},
        getPlan: async () => null,
        failPlan: async () => {},
        createPlanFromSaga,
        backfillOriginalPayload: async () => {},
      },
    });
    const job = makeJob({
      name: 'saga.run',
      data: {
        plan_id: 'plan-3',
        saga_name: 'deprovision',
        payload: { device_id: 'dev-1' },
      },
    }) as ProcessableJob<Record<string, unknown>>;

    await handler.handle(job, 'token');
    expect(createPlanFromSaga).toHaveBeenCalledTimes(1);
    const args = createPlanFromSaga.mock.calls[0][0];
    expect(args.planId).toBe('plan-3');
    expect(args.deviceId).toBe('dev-1');
  });

  it('creates a plan when getPlan returns undefined', async () => {
    const createPlanFromSaga = vi.fn<SagaPlanManagerLike['createPlanFromSaga']>(async () => ({}));
    const handler = makeSagaHandler({
      planManager: {
        start: async () => {},
        getPlan: async () => undefined,
        failPlan: async () => {},
        createPlanFromSaga,
        backfillOriginalPayload: async () => {},
      },
    });
    const job = makeJob({
      name: 'saga.run',
      data: {
        plan_id: 'plan-undef',
        saga_name: 'deprovision',
        payload: { device_id: 'dev-1' },
      },
    }) as ProcessableJob<Record<string, unknown>>;

    await handler.handle(job, 'token');
    expect(createPlanFromSaga).toHaveBeenCalledTimes(1);
    expect(createPlanFromSaga.mock.calls[0][0].planId).toBe('plan-undef');
  });
});

describe('SagaJobHandler lock contention', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function contendedJob(moveToDelayed: MoveToDelayedFn): ProcessableJob<Record<string, unknown>> {
    return makeJob({
      id: 'bull-job-lock',
      name: 'saga.run',
      data: {
        plan_id: 'plan-lock',
        saga_name: 'power_off',
        payload: { device_id: 'dev-lock' },
      },
      moveToDelayed,
    }) as ProcessableJob<Record<string, unknown>>;
  }

  it('records the holder, state, TTL, and lock owner identity on first contention', async () => {
    const acquireLock = vi.fn<SagaHandlerCache['acquireLock']>(async () => null);
    const set = vi.fn<LockWaitCache['set']>(async () => undefined);
    const moveToDelayed = vi.fn<MoveToDelayedFn>(async () => {});
    const cache = {
      ...LOCK_WAIT_CACHE_METHODS,
      acquireLock,
      releaseLock: async () => true,
      renewLockIfOwner: async () => true,
      readLockInfo: async () => ({
        token: 'holder-token',
        plan_id: 'holder-plan',
        saga_name: 'provision',
        acquired_at: '1785283100',
      }),
      set,
    };
    const handler = makeSagaHandler({ cache });
    const processor = makeProcessor({ 'saga.run': handler.handle }, { cache });

    await expect(processor.process(contendedJob(moveToDelayed), 'worker-token')).rejects.toBeInstanceOf(
      CrossBridgeHandoff,
    );

    expect(acquireLock).toHaveBeenCalledWith('device:dev-lock', 60, 'plan-lock', {
      plan_id: 'plan-lock',
      saga_name: 'power_off',
      acquired_at: '1785283200',
    });
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0][0]).toBe('lockwait:bull-job-lock');
    expect(set.mock.calls[0][2]).toBe(3_600);
    expect(JSON.parse(set.mock.calls[0][1])).toMatchObject({
      attempts: 1,
      lock_key: 'device:dev-lock',
      holder_plan_id: 'holder-plan',
      holder_saga_name: 'provision',
      holder_since: '1785283100',
    });
    expect(moveToDelayed).toHaveBeenCalledTimes(1);
    expect(moveToDelayed.mock.calls[0][3]).toBe('worker-token');
  });

  it('notifies only after the warning interval and throttles later attempts', async () => {
    let stored: string | null = null;
    const notifyStepTransition = vi.fn<LifecycleNotifications['notifyStepTransition']>(async () => {});
    const cache: SagaHandlerCache & LockWaitCache = {
      ...LOCK_WAIT_CACHE_METHODS,
      acquireLock: async () => null,
      releaseLock: async () => true,
      renewLockIfOwner: async () => true,
      get: async () => stored,
      set: async (_key, value) => {
        stored = value;
      },
    };
    const handler = makeSagaHandler({ cache });
    const processor = makeProcessor({ 'saga.run': handler.handle }, { cache, notifications: { notifyStepTransition } });

    await expect(
      processor.process(
        contendedJob(async () => {}),
        'token-1',
      ),
    ).rejects.toBeInstanceOf(CrossBridgeHandoff);
    expect(notifyStepTransition).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    await expect(
      processor.process(
        contendedJob(async () => {}),
        'token-2',
      ),
    ).rejects.toBeInstanceOf(CrossBridgeHandoff);
    expect(notifyStepTransition).toHaveBeenCalledTimes(1);
    expect(notifyStepTransition.mock.calls[0][0]).toMatchObject({
      planId: 'plan-lock',
      status: JobStatus.BLOCKED,
    });

    await expect(
      processor.process(
        contendedJob(async () => {}),
        'token-3',
      ),
    ).rejects.toBeInstanceOf(CrossBridgeHandoff);
    expect(notifyStepTransition).toHaveBeenCalledTimes(1);
  });

  it('reschedules when a lock-wait notification fails', async () => {
    const now = Date.now() / 1_000;
    let stored = JSON.stringify({
      first_blocked_at: now - 60,
      attempts: 1,
      lock_key: 'device:dev-lock',
      last_notified_at: 0,
    });
    const moveToDelayed = vi.fn<MoveToDelayedFn>(async () => {});
    const cache = {
      ...LOCK_WAIT_CACHE_METHODS,
      acquireLock: async () => null,
      releaseLock: async () => true,
      renewLockIfOwner: async () => true,
      get: async () => stored,
      set: async (_key: string, value: string) => {
        stored = value;
      },
    };
    const handler = makeSagaHandler({ cache });
    const processor = makeProcessor(
      { 'saga.run': handler.handle },
      {
        cache,
        notifications: {
          notifyStepTransition: async () => {
            throw new Error('results queue unavailable');
          },
        },
      },
    );

    await expect(processor.process(contendedJob(moveToDelayed), 'worker-token')).rejects.toBeInstanceOf(
      CrossBridgeHandoff,
    );
    expect(moveToDelayed).toHaveBeenCalledTimes(1);
    expect(JSON.parse(stored).last_notified_at).toBe(now);
  });

  it('fails the plan before throwing an unrecoverable hard-cap error', async () => {
    const order: string[] = [];
    const failPlan = vi.fn(async () => {
      order.push('failPlan');
    });
    const deleteState = vi.fn(async () => 1);
    const now = Date.now() / 1_000;
    const cache = {
      ...LOCK_WAIT_CACHE_METHODS,
      acquireLock: async () => null,
      releaseLock: async () => true,
      renewLockIfOwner: async () => true,
      get: async () =>
        JSON.stringify({
          first_blocked_at: now - 61,
          attempts: 3,
          lock_key: 'device:dev-lock',
          last_notified_at: 0,
        }),
      delete: deleteState,
    };
    const planManager = {
      ...makeSagaFakes().planManager,
      failPlan,
    };
    const handler = makeSagaHandler({ cache, planManager });
    const processor = makeProcessor(
      { 'saga.run': handler.handle },
      {
        cache,
        planManager,
        config: {
          lockWaitHardCapSeconds: 60,
        },
      },
    );

    const rejection = processor.process(
      contendedJob(async () => {}),
      'worker-token',
    );
    await expect(rejection).rejects.toBeInstanceOf(DeviceLockWaitExceeded);
    await expect(rejection).rejects.toBeInstanceOf(UnrecoverableError);
    expect(order).toEqual(['failPlan']);
    expect(failPlan).toHaveBeenCalledWith('plan-lock', 'Lock wait exceeded hard cap (60s) on device:dev-lock');
    expect(deleteState).not.toHaveBeenCalled();
  });

  it('deletes stored state after lock acquisition and normal completion', async () => {
    const deleteState = vi.fn(async () => 1);
    const execute = vi.fn<SagaRunnerLike['execute']>(async () => ({ status: 'completed' }));
    const handler = makeSagaHandler({
      cache: {
        ...LOCK_WAIT_CACHE_METHODS,
        acquireLock: async () => 'lock-token',
        releaseLock: async () => true,
        renewLockIfOwner: async () => true,
        get: async () =>
          JSON.stringify({
            first_blocked_at: Date.now() / 1_000 - 10,
            attempts: 1,
            lock_key: 'device:dev-lock',
            last_notified_at: 0,
          }),
        delete: deleteState,
      },
      runner: { execute },
    });

    await expect(
      handler.handle(
        contendedJob(async () => {}),
        'worker-token',
      ),
    ).resolves.toEqual({
      plan_id: 'plan-lock',
      status: 'completed',
    });
    expect(deleteState).toHaveBeenCalledTimes(1);
    expect(deleteState.mock.invocationCallOrder[0]).toBeLessThan(execute.mock.invocationCallOrder[0]);
  });

  it('deletes stored state after normal lockless completion', async () => {
    const deleteState = vi.fn(async () => 1);
    const handler = makeSagaHandler({
      cache: {
        ...LOCK_WAIT_CACHE_METHODS,
        acquireLock: async () => 'lock-token',
        releaseLock: async () => true,
        renewLockIfOwner: async () => true,
        get: async () =>
          JSON.stringify({
            first_blocked_at: Date.now() / 1_000 - 10,
            attempts: 1,
            lock_key: 'device:dev-lock',
            last_notified_at: 0,
          }),
        delete: deleteState,
      },
    });
    const job = makeJob({
      id: 'bull-job-lock',
      name: 'saga.run',
      data: {
        plan_id: 'plan-lock',
        saga_name: 'inventory_collection',
        payload: { device_id: 'dev-lock' },
      },
    }) as ProcessableJob<Record<string, unknown>>;

    await expect(handler.handle(job, 'worker-token')).resolves.toEqual({
      plan_id: 'plan-lock',
      status: 'completed',
    });
    expect(deleteState).toHaveBeenCalledWith('lockwait:bull-job-lock', 'plan-lock');
  });

  it('deletes stale state when an agent handoff occurs', async () => {
    const deleteState = vi.fn(async () => 1);
    const handler = makeSagaHandler({
      cache: {
        ...LOCK_WAIT_CACHE_METHODS,
        acquireLock: async () => 'lock-token',
        releaseLock: async () => true,
        renewLockIfOwner: async () => true,
        get: async () =>
          JSON.stringify({
            first_blocked_at: Date.now() / 1_000 - 10,
            attempts: 1,
            lock_key: 'device:dev-lock',
            last_notified_at: 0,
          }),
        delete: deleteState,
      },
      runner: {
        execute: async () => {
          throw new AgentNotConnected('dev-lock');
        },
      },
    });

    await expect(
      handler.handle(
        contendedJob(async () => {}),
        'worker-token',
      ),
    ).rejects.toBeInstanceOf(AgentNotConnected);
    expect(deleteState).toHaveBeenCalledTimes(1);
  });
});

const KEY_PREFIX = 'bridge:';
const redisKeyForLock = (bareLockKey: string): string => `${KEY_PREFIX}lock:${bareLockKey}`;

describe('SagaJobHandler — lock renewal lifecycle', () => {
  const RENEW_INTERVAL_MS = 20_000;
  type LockLostSignal = NonNullable<Parameters<SagaRunnerLike['execute']>[1]['lockLost']>;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeControllableRunner(): {
    runner: SagaRunnerLike;
    getLockLost: () => LockLostSignal | null;
    resolveRun: (status: string) => void;
    rejectRun: (err: unknown) => void;
  } {
    let captured: LockLostSignal | null = null;
    let resolveRun!: (value: { status: string } | null) => void;
    let rejectRun!: (err: unknown) => void;
    const runner: SagaRunnerLike = {
      execute: (_saga, args) => {
        captured = args.lockLost ?? null;
        return new Promise((resolve, reject) => {
          resolveRun = resolve;
          rejectRun = reject;
        });
      },
    };
    return {
      runner,
      getLockLost: () => captured,
      resolveRun: (status: string) => resolveRun({ status }),
      rejectRun: (err: unknown) => rejectRun(err),
    };
  }

  function makeSagaJob(): ProcessableJob<Record<string, unknown>> {
    return makeJob({
      name: 'saga.run',
      data: {
        plan_id: 'plan-renew',
        saga_name: 'power_off',
        payload: { device_id: 'dev-renew' },
      },
    }) as ProcessableJob<Record<string, unknown>>;
  }

  it('signals lockLost, resolves waiters, and retains the lock until its TTL expires when renewal returns false', async () => {
    const warnings: string[] = [];
    const logger = {
      ...SILENT,
      warning: async (message: string) => {
        warnings.push(message);
      },
    };
    let acquiredRedisKey: string | null = null;
    const renewedRedisKeys: string[] = [];
    const releaseLock = vi.fn(async (lockKey: string) => {
      expect(redisKeyForLock(lockKey)).toBe(acquiredRedisKey);
      return true;
    });
    const clearCooldownAndEnqueue = vi.fn(async () => {});
    let renewCalls = 0;
    const cache: SagaHandlerCache = {
      ...LOCK_WAIT_CACHE_METHODS,
      acquireLock: async (lockKey: string) => {
        acquiredRedisKey = redisKeyForLock(lockKey);
        return 'token-123';
      },
      releaseLock,
      renewLockIfOwner: async (key: string) => {
        renewedRedisKeys.push(redisKeyForLock(key));
        renewCalls += 1;
        return renewCalls < 3;
      },
    };
    const { runner, getLockLost, rejectRun } = makeControllableRunner();
    const handler = new SagaJobHandler(
      cache,
      makeSagaFakes().planManager,
      runner,
      makeSagaFakes().sagaProvider,
      EMPTY_SCHEMAS,
      makeSagaConfig(),
      { clearCooldownAndEnqueue },
      logger,
    );

    const settled = handler.handle(makeSagaJob(), 'token');
    await vi.advanceTimersByTimeAsync(0);
    const lockLost = getLockLost();
    if (lockLost === null) throw new Error('runner did not receive lockLost');
    let waitResolved = false;
    const waitForLockLost = lockLost.wait().then(() => {
      waitResolved = true;
    });
    await Promise.resolve();
    expect(waitResolved).toBe(false);

    await vi.advanceTimersByTimeAsync(RENEW_INTERVAL_MS * 3);
    await waitForLockLost;

    expect(lockLost.isSet()).toBe(true);
    expect(lockLost.dispose).toBeTypeOf('function');
    lockLost.dispose?.();
    expect(renewCalls).toBe(3);
    expect(warnings.some((w) => w.includes('Lock renewal failed for') && w.includes('signaling saga to abort'))).toBe(
      true,
    );

    expect(acquiredRedisKey).not.toBeNull();
    expect(renewedRedisKeys).toHaveLength(3);
    for (const renewed of renewedRedisKeys) {
      expect(renewed).toBe(acquiredRedisKey);
    }

    rejectRun(new LockLost('Device lock lost during saga'));
    await expect(settled).rejects.toBeInstanceOf(LockLost);

    expect(releaseLock).not.toHaveBeenCalled();
    expect(clearCooldownAndEnqueue).not.toHaveBeenCalled();
  });

  it('tolerates one renewal exception and signals lockLost after the second consecutive exception', async () => {
    const warnings: string[] = [];
    const logger = {
      ...SILENT,
      warning: async (message: string) => {
        warnings.push(message);
      },
    };
    let renewCalls = 0;
    const cache: SagaHandlerCache = {
      ...LOCK_WAIT_CACHE_METHODS,
      acquireLock: async () => 'token-123',
      releaseLock: async () => true,
      renewLockIfOwner: async () => {
        renewCalls += 1;
        throw new Error('RedisOperationError: connection reset');
      },
    };
    const { runner, getLockLost, rejectRun } = makeControllableRunner();
    const handler = new SagaJobHandler(
      cache,
      makeSagaFakes().planManager,
      runner,
      makeSagaFakes().sagaProvider,
      EMPTY_SCHEMAS,
      makeSagaConfig(),
      { clearCooldownAndEnqueue: async () => {} },
      logger,
    );

    const settled = handler.handle(makeSagaJob(), 'token');
    await vi.advanceTimersByTimeAsync(RENEW_INTERVAL_MS);

    expect(renewCalls).toBe(1);
    expect(getLockLost()?.isSet()).toBe(false);
    expect(warnings.some((w) => w.includes('Lock renewal errored for') && w.includes('retrying'))).toBe(true);

    await vi.advanceTimersByTimeAsync(RENEW_INTERVAL_MS);
    expect(renewCalls).toBe(2);
    expect(getLockLost()?.isSet()).toBe(true);
    expect(warnings.some((w) => w.includes('Lock renewal errored twice for') && w.includes('signaling'))).toBe(true);

    await vi.advanceTimersByTimeAsync(RENEW_INTERVAL_MS * 5);
    expect(renewCalls).toBe(2);

    rejectRun(new LockLost('Device lock lost during saga'));
    await expect(settled).rejects.toBeInstanceOf(LockLost);
  });

  it('signals lockLost before lease expiry when a renewal call does not settle', async () => {
    const releaseLock = vi.fn(async () => true);
    const cache: SagaHandlerCache = {
      acquireLock: async () => 'token-123',
      releaseLock,
      renewLockIfOwner: async () => new Promise<boolean>(() => undefined),
    };
    const { runner, getLockLost, rejectRun } = makeControllableRunner();
    const handler = new SagaJobHandler(
      cache,
      makeSagaFakes().planManager,
      runner,
      makeSagaFakes().sagaProvider,
      EMPTY_SCHEMAS,
      makeSagaConfig(),
      { clearCooldownAndEnqueue: async () => {} },
      SILENT,
    );

    const settled = handler.handle(makeSagaJob());
    await vi.advanceTimersByTimeAsync(49_999);
    expect(getLockLost()?.isSet()).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(getLockLost()?.isSet()).toBe(true);

    rejectRun(new LockLost('Device lock lost during saga'));
    await expect(settled).rejects.toBeInstanceOf(LockLost);
    expect(releaseLock).not.toHaveBeenCalled();
  });

  it('resets the consecutive renewal exception counter after a successful renewal', async () => {
    let renewCalls = 0;
    const cache: SagaHandlerCache = {
      acquireLock: async () => 'token-123',
      releaseLock: async () => true,
      renewLockIfOwner: async () => {
        renewCalls += 1;
        if (renewCalls === 2) return true;
        throw new Error(`renewal error ${renewCalls}`);
      },
    };
    const { runner, getLockLost, rejectRun } = makeControllableRunner();
    const handler = new SagaJobHandler(
      cache,
      makeSagaFakes().planManager,
      runner,
      makeSagaFakes().sagaProvider,
      EMPTY_SCHEMAS,
      makeSagaConfig(),
      { clearCooldownAndEnqueue: async () => {} },
      SILENT,
    );

    const settled = handler.handle(makeSagaJob());
    await vi.advanceTimersByTimeAsync(RENEW_INTERVAL_MS);
    expect(renewCalls).toBe(1);
    expect(getLockLost()?.isSet()).toBe(false);

    await vi.advanceTimersByTimeAsync(RENEW_INTERVAL_MS);
    expect(renewCalls).toBe(2);
    expect(getLockLost()?.isSet()).toBe(false);

    await vi.advanceTimersByTimeAsync(RENEW_INTERVAL_MS);
    expect(renewCalls).toBe(3);
    expect(getLockLost()?.isSet()).toBe(false);

    await vi.advanceTimersByTimeAsync(RENEW_INTERVAL_MS);
    expect(renewCalls).toBe(4);
    expect(getLockLost()?.isSet()).toBe(true);

    rejectRun(new LockLost('Device lock lost during saga'));
    await expect(settled).rejects.toBeInstanceOf(LockLost);
  });
});

describe('CollectionJobHandler', () => {
  it('returns deferred + clears cooldown when the saga lock is held', async () => {
    const cooldownKey = vi.fn((id: string) => `device:${id}:auto_collection_cooldown`);
    const cacheDelete = vi.fn(async (_key: string, _jobId?: string | null) => 1);
    const handler = new CollectionJobHandler(
      {
        dispatchTyped: async () => {
          throw new Error('must not be called');
        },
      },
      { isConnected: () => true },
      {
        clearCollectionData: async () => true,
        getCollectionFieldCount: () => null,
        enqueueDiscoveryComplete: async () => true,
      },
      {
        exists: async () => true,
        delete: cacheDelete,
      },
      { cooldownKey },
      SILENT,
    );
    const job = makeJob({
      name: 'collection.run',
      data: { device_id: 'abc-123', plan_id: 'plan-coll' },
    }) as ProcessableJob<Record<string, unknown>>;

    const result = (await handler.handle(job, 'token')) as Record<string, unknown>;
    expect(result.status).toBe('deferred');
    expect(result.reason).toBe('saga_lock_held');
    expect(cacheDelete).toHaveBeenCalledTimes(1);
    expect(cacheDelete.mock.calls[0][0]).toBe('device:abc-123:auto_collection_cooldown');
  });

  it('throws AgentNotConnected when the registry has no session', async () => {
    const handler = new CollectionJobHandler(
      {
        dispatchTyped: async () => {
          throw new Error('must not be called');
        },
      },
      { isConnected: () => false },
      {
        clearCollectionData: async () => true,
        getCollectionFieldCount: () => null,
        enqueueDiscoveryComplete: async () => true,
      },
      {
        exists: async () => false,
        delete: async () => 0,
      },
      { cooldownKey: (id) => `device:${id}:cooldown` },
      SILENT,
    );
    const job = makeJob({
      name: 'collection.run',
      data: { device_id: 77, plan_id: 'plan-coll' },
    }) as ProcessableJob<Record<string, unknown>>;

    await expect(handler.handle(job, 'token')).rejects.toBeInstanceOf(AgentNotConnected);
  });

  it('returns complete with metadata on a non-empty summary', async () => {
    const enqueue = vi.fn(async () => true);
    const handler = new CollectionJobHandler(
      {
        dispatchTyped: async () => ({ successes: 5, failures: 1, total_duration_ms: 123, collectors_run: [] }),
      },
      { isConnected: () => true },
      {
        clearCollectionData: async () => true,
        getCollectionFieldCount: () => 42,
        enqueueDiscoveryComplete: enqueue,
      },
      {
        exists: async () => false,
        delete: async () => 0,
      },
      { cooldownKey: (id) => `device:${id}:cooldown` },
      SILENT,
    );
    const job = makeJob({
      name: 'collection.run',
      data: { device_id: 'dev-7', plan_id: 'plan-c' },
    }) as ProcessableJob<Record<string, unknown>>;

    const result = (await handler.handle(job, 'token')) as Record<string, unknown>;
    expect(result.status).toBe('complete');
    expect(result.metadata).toMatchObject({
      collectors_total: 6,
      collectors_successful: 5,
      collectors_failed: 1,
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});

describe('redactPayloadForLog', () => {
  it('redacts user_data', () => {
    const payload = {
      lifecycle_data: { user_data: { runcmd: ['echo s3cret'] }, hostname: 'n42' },
    };
    const out = redactPayloadForLog(payload) as Record<string, Record<string, unknown>>;
    expect(out.lifecycle_data.user_data).toBe('<redacted>');
    expect(out.lifecycle_data.hostname).toBe('n42');
  });

  it('pubkeys show count only', () => {
    const payload = { lifecycle_data: { pubkeys: ['ssh-rsa AAA', 'ssh-ed25519 BBB'] } };
    const out = redactPayloadForLog(payload) as Record<string, Record<string, unknown>>;
    expect(out.lifecycle_data.pubkeys).toBe('<redacted: 2 items>');
  });

  it('redacts password_hash', () => {
    const payload = { lifecycle_data: { password_hash: '$6$rounds=...' } };
    const out = redactPayloadForLog(payload) as Record<string, Record<string, unknown>>;
    expect(out.lifecycle_data.password_hash).toBe('<redacted>');
  });

  it('redacts server_token', () => {
    const payload = {
      lifecycle_data: {
        server_token: { deployment_os_token: 'test-os-token-test', endpoint: 'https://hub/api/v1/bmc/phone-home' },
      },
    };
    const out = redactPayloadForLog(payload) as Record<string, Record<string, unknown>>;
    expect(out.lifecycle_data.server_token).toBe('<redacted>');
  });

  it('preserves non-sensitive fields', () => {
    const payload = {
      platform: { os_distro: 'ubuntu' },
      lifecycle_data: {
        hostname: 'n42',
        os_layers: [{ layer: 'cuda-13.1', sha256: 'abc' }],
        disk_layouts: [{ mountpoint: '/' }],
      },
    };
    const out = redactPayloadForLog(payload) as Record<string, Record<string, unknown>>;
    expect((out.platform as Record<string, unknown>).os_distro).toBe('ubuntu');
    expect((out.lifecycle_data.os_layers as Array<Record<string, unknown>>)[0].sha256).toBe('abc');
    expect((out.lifecycle_data.disk_layouts as Array<Record<string, unknown>>)[0].mountpoint).toBe('/');
  });

  it('does not mutate the input', () => {
    const payload = { lifecycle_data: { user_data: 'secret', hostname: 'n42' } };
    redactPayloadForLog(payload);
    expect(payload.lifecycle_data.user_data).toBe('secret');
  });

  it('passes non-dict input through verbatim', () => {
    expect(redactPayloadForLog('not-a-dict')).toBe('not-a-dict');
    expect(redactPayloadForLog(null)).toBeNull();
  });

  it('passes payload through unchanged when lifecycle_data is missing', () => {
    const payload = { platform: { os_distro: 'ubuntu' } };
    expect(redactPayloadForLog(payload)).toEqual(payload);
  });
});

const KEY_SIZE = 32;
interface Keypair {
  priv: Buffer;
  pub: Buffer;
}

function genKeypair(): Keypair {
  const kp = generateKeyPairSync('x25519');
  const pkcs8 = kp.privateKey.export({ format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(kp.privateKey).export({ format: 'der', type: 'spki' });
  return {
    priv: Buffer.from(pkcs8.subarray(pkcs8.length - KEY_SIZE)),
    pub: Buffer.from(spki.subarray(spki.length - KEY_SIZE)),
  };
}

function buildHubToBridgeEnvelope(
  hub: Keypair,
  zone: Keypair,
  plaintext: Buffer,
  aadOverrides: Partial<{
    zoneId: string;
    queueName: string;
    jobId: string;
    createdAt: number;
  }> = {},
): Record<string, unknown> {
  const aad: Record<string, unknown> = {
    aad_v: 1,
    zone_id: aadOverrides.zoneId ?? ZONE_ID,
    queue_name: aadOverrides.queueName ?? LIFECYCLE_QUEUE,
    direction: DIRECTION_HUB_TO_BRIDGE,
    job_id: aadOverrides.jobId ?? 'plan-1',
    created_at: aadOverrides.createdAt ?? Date.now(),
  };
  const aadBytes = canonicalizeAad(aad);
  const sealed = cryptoSeal(hub.priv, zone.pub, plaintext, aadBytes);
  return {
    envelope_v: CURRENT_ENVELOPE_VERSION,
    aad,
    eph_pub: sealed.ephPub.toString('base64'),
    ciphertext: sealed.ciphertext.toString('base64'),
    tag: sealed.tag.toString('base64'),
  };
}

interface InboundFx {
  hub: Keypair;
  zone: Keypair;
  zoneCrypto: ZoneCryptoService;
  opener: InboundEnvelopeOpenerService;
}

function setupActivated(): InboundFx {
  const hub = genKeypair();
  const zone = genKeypair();
  const snapshot: ZoneCryptoSnapshot = {
    zonePriv: zone.priv,
    zonePub: zone.pub,
    hubPub: hub.pub,
    enrolledAt: 1_730_000_000_000,
  };
  const zoneCrypto = new ZoneCryptoService();
  zoneCrypto.set(snapshot);
  const sealedService = new SealedEnvelopeService(zoneCrypto);
  const opener = new InboundEnvelopeOpenerService(
    sealedService,
    zoneCrypto,
    {
      getZoneId: () => ZONE_ID,
    },
    SILENT,
    COLLECTION_QUEUE,
  );
  return { hub, zone, zoneCrypto, opener };
}

function setupInactive(): InboundFx {
  const hub = genKeypair();
  const zone = genKeypair();
  const zoneCrypto = new ZoneCryptoService();
  zoneCrypto.clear();
  const sealedService = new SealedEnvelopeService(zoneCrypto);
  const opener = new InboundEnvelopeOpenerService(
    sealedService,
    zoneCrypto,
    {
      getZoneId: () => ZONE_ID,
    },
    SILENT,
    COLLECTION_QUEUE,
  );
  return { hub, zone, zoneCrypto, opener };
}

describe('InboundEnvelopeOpenerService (handlers inbound envelope path)', () => {
  let fx: InboundFx;
  beforeEach(() => {
    fx = setupActivated();
  });

  it('decrypts sealed envelopes transparently for handlers', async () => {
    const createdAtMs = Date.now();
    const inner = {
      plan_id: 'plan-sealed',
      saga_name: 'deprovision',
      payload: { device_id: 'dev-1' },
    };
    const plaintext = Buffer.from(JSON.stringify(inner), 'utf-8');
    const envelope = buildHubToBridgeEnvelope(fx.hub, fx.zone, plaintext, { createdAt: createdAtMs });
    const job = makeJob({ name: 'saga.run', data: envelope });

    const opened = await fx.opener.open(job);
    expect(opened).toEqual({ payload: inner, createdAtMs, isBridgeLocal: false });
  });

  it('passes plaintext through pre-activation', async () => {
    const inactive = setupInactive();
    const job = makeJob({
      name: 'saga.run',
      data: { plan_id: 'plan-pt', saga_name: 'deprovision', payload: {} },
    });
    const opened = await inactive.opener.open(job);
    expect(opened.payload).toEqual({ plan_id: 'plan-pt', saga_name: 'deprovision', payload: {} });
    expect(opened.createdAtMs).toBeTypeOf('number');
    expect(opened.isBridgeLocal).toBe(false);
  });

  it('rejects plaintext post-activation with PlaintextAfterActivationError', async () => {
    const job = makeJob({
      name: 'saga.run',
      data: { plan_id: 'plan-pt', saga_name: 'deprovision', payload: {} },
    });
    await expect(fx.opener.open(job)).rejects.toBeInstanceOf(PlaintextAfterActivationError);
  });

  it('does NOT reject plaintext on the intra-bridge collection queue post-activation (exemption)', async () => {
    const job = makeJob({
      name: 'collection.run',
      data: { plan_id: 'plan-collect', device_id: 'dev-1', zone_prefix: ZONE_ID },
      queueName: COLLECTION_QUEUE,
    });
    const opened = await fx.opener.open(job);
    expect(opened.payload).toEqual(job.data);
    expect(opened.createdAtMs).toBeTypeOf('number');
    expect(opened.isBridgeLocal).toBe(false);
  });

  it('raises SealKeyUnknownError for sealed envelopes pre-activation', async () => {
    const inactive = setupInactive();
    const envelope = buildHubToBridgeEnvelope(fx.hub, fx.zone, Buffer.from('{}', 'utf-8'));
    const job = makeJob({ name: 'saga.run', data: envelope });
    await expect(inactive.opener.open(job)).rejects.toBeInstanceOf(SealKeyUnknownError);
  });

  it('raises SealOpenError when sealed envelope queue does not match', async () => {
    const envelope = buildHubToBridgeEnvelope(fx.hub, fx.zone, Buffer.from('{}', 'utf-8'), {
      queueName: 'collection',
    });
    const job = makeJob({ name: 'saga.run', data: envelope, queueName: LIFECYCLE_QUEUE });
    await expect(fx.opener.open(job)).rejects.toBeInstanceOf(SealOpenError);
  });

  it('raises SealOpenError when zone_id mismatches', async () => {
    const envelope = buildHubToBridgeEnvelope(fx.hub, fx.zone, Buffer.from('{}', 'utf-8'), {
      zoneId: '00000000-0000-4000-8000-000000000099',
    });
    const job = makeJob({ name: 'saga.run', data: envelope });
    await expect(fx.opener.open(job)).rejects.toBeInstanceOf(SealOpenError);
  });

  it('surfaces JSON parse failure when decrypted payload is not JSON', async () => {
    const envelope = buildHubToBridgeEnvelope(fx.hub, fx.zone, Buffer.from('not-json-bytes'));
    const job = makeJob({ name: 'saga.run', data: envelope });
    await expect(fx.opener.open(job)).rejects.toThrow();
  });
});
