import { describe, expect, it, vi } from 'vitest';

import { BridgeLocalPlanMissing } from '../bullmq.types.js';
import type { ProcessableJob } from '../handlers.service.js';
import { SagaJobHandler, type SagaPlanManagerLike, type SagaRunnerLike } from '../saga.handler.js';

function makeJob(
  payload: Record<string, unknown>,
  opts: { isBridgeLocal?: boolean } = {},
): ProcessableJob<Record<string, unknown>> {
  return {
    id: 'job-1',
    name: 'saga.run',
    data: {
      plan_id: 'plan-1',
      saga_name: 'power_status',
      payload,
    },
    ...(opts.isBridgeLocal === undefined ? {} : { isBridgeLocal: opts.isBridgeLocal }),
    queue: { name: 'lifecycle' },
    scripts: { moveToDelayed: async () => {} },
  };
}

function makeHandler(planManager: SagaPlanManagerLike, runner?: SagaRunnerLike): SagaJobHandler {
  return new SagaJobHandler(
    {
      acquireLock: async () => null,
      releaseLock: async () => true,
      renewLockIfOwner: async () => true,
    },
    planManager,
    runner ?? { execute: async () => ({ status: 'completed' }) },
    {
      getSagaDef: () => ({
        name: 'power_status',
        steps: [],
      }),
    },
    {},
    {
      bullmqQueueName: 'lifecycle',
      deviceLockTimeoutSeconds: 60,
      deviceLockRenewIntervalSeconds: 20,
    },
    { clearCooldownAndEnqueue: async () => {} },
    {
      debug: async () => {},
      info: async () => {},
      warning: async () => {},
      error: async () => {},
    },
  );
}

function manager(existing: unknown) {
  const createPlanFromSaga = vi.fn<SagaPlanManagerLike['createPlanFromSaga']>(async () => ({}));
  const backfillOriginalPayload = vi.fn<SagaPlanManagerLike['backfillOriginalPayload']>(async () => {});
  const planManager: SagaPlanManagerLike = {
    start: async () => {},
    getPlan: async () => existing,
    failPlan: async () => {},
    createPlanFromSaga,
    backfillOriginalPayload,
  };
  return { planManager, createPlanFromSaga, backfillOriginalPayload };
}

describe('saga payload persistence', () => {
  it('stores the original payload in new plan metadata', async () => {
    const fakes = manager(null);
    const payload = { device_id: 'device-1', nested: { value: 1 } };
    await makeHandler(fakes.planManager).handle(makeJob(payload));
    expect(fakes.createPlanFromSaga.mock.calls[0][0].metadata?.original_payload).toEqual(payload);
    expect(fakes.createPlanFromSaga.mock.calls[0][0].metadata?.bullmq_job_id).toBe('job-1');
  });

  it('backfills the original payload for an existing plan', async () => {
    const fakes = manager({ plan_id: 'plan-1' });
    const payload = { device_id: 'device-1' };
    await makeHandler(fakes.planManager).handle(makeJob(payload));
    expect(fakes.backfillOriginalPayload).toHaveBeenCalledWith('plan-1', payload);
  });

  it('stores a deep clone of the payload', async () => {
    const fakes = manager(null);
    const payload = { device_id: 'device-1', nested: { value: 1 } };
    await makeHandler(fakes.planManager).handle(makeJob(payload));
    payload.nested.value = 2;
    expect(fakes.createPlanFromSaga.mock.calls[0][0].metadata?.original_payload).toEqual({
      device_id: 'device-1',
      nested: { value: 1 },
    });
  });
});

describe('bridge-local pickup with a missing plan', () => {
  it('fails closed without creating a fresh plan or running the saga', async () => {
    const fakes = manager(null);
    const execute = vi.fn<SagaRunnerLike['execute']>(async () => ({ status: 'completed' }));
    const handler = makeHandler(fakes.planManager, { execute });
    await expect(handler.handle(makeJob({ device_id: 'device-1' }, { isBridgeLocal: true }))).rejects.toBeInstanceOf(
      BridgeLocalPlanMissing,
    );
    expect(fakes.createPlanFromSaga).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('creates a plan for a hub-originated pickup with no existing plan', async () => {
    const fakes = manager(null);
    await makeHandler(fakes.planManager).handle(makeJob({ device_id: 'device-1' }, { isBridgeLocal: false }));
    expect(fakes.createPlanFromSaga).toHaveBeenCalledTimes(1);
  });

  it('resumes a bridge-local pickup with an existing plan without resetting it', async () => {
    const fakes = manager({ plan_id: 'plan-1' });
    const execute = vi.fn<SagaRunnerLike['execute']>(async () => ({ status: 'completed' }));
    await makeHandler(fakes.planManager, { execute }).handle(
      makeJob({ device_id: 'device-1' }, { isBridgeLocal: true }),
    );
    expect(fakes.createPlanFromSaga).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
