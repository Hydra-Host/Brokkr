import { describe, expect, it, vi } from 'vitest';

import type { SagaContext } from '../../../saga-framework/saga.types.js';
import { DisarmCustomIpxeBootStep } from '../disarm-custom-ipxe-boot.step.js';

function makeCtx(overrides: Partial<SagaContext> = {}): SagaContext {
  return {
    planId: 'plan-1',
    stepName: 'disarm_custom_ipxe_boot',
    deviceId: 'dev-1',
    payload: {},
    jobId: 'job-1',
    attempt: 1,
    metadata: {},
    stepResults: {},
    ...overrides,
  };
}

function makeStep() {
  const del = vi.fn().mockResolvedValue(1);
  return { step: new DisarmCustomIpxeBootStep({ delete: del }), del };
}

describe('DisarmCustomIpxeBootStep', () => {
  it('deletes the custom iPXE boot marker with the saga job ID', async () => {
    const { step, del } = makeStep();

    await expect(step.execute(makeCtx())).resolves.toEqual({ disarmed: true });
    expect(del).toHaveBeenCalledWith('device:dev-1:config:ipxe_url', 'job-1');
  });

  it('reports success when the marker was already absent', async () => {
    const { step, del } = makeStep();
    del.mockResolvedValue(0);

    await expect(step.execute(makeCtx())).resolves.toEqual({ disarmed: true });
  });

  it('disarms even when Brokkr Live is already ready and Phase 1 will be skipped', async () => {
    const { step, del } = makeStep();

    await expect(step.execute(makeCtx({ stepResults: { brokkr_live_check: { ready: true } } }))).resolves.toEqual({
      disarmed: true,
    });
    expect(del).toHaveBeenCalledWith('device:dev-1:config:ipxe_url', 'job-1');
  });

  it.each([undefined, ''])('reports the failure reason when the device id is %p', async (deviceId) => {
    const { step, del } = makeStep();

    await expect(step.execute(makeCtx({ deviceId }))).resolves.toEqual({
      disarmed: false,
      reason: 'device_id is missing',
    });
    expect(del).not.toHaveBeenCalled();
  });

  it('surfaces a Redis failure in the step result instead of throwing', async () => {
    const { step, del } = makeStep();
    del.mockRejectedValue(new Error('Redis unavailable'));

    await expect(step.execute(makeCtx())).resolves.toEqual({
      disarmed: false,
      reason: 'Redis unavailable',
    });
  });
});
