import { describe, expect, it, vi } from 'vitest';

import type { SagaContext } from '../../../saga-framework/saga.types.js';
import { ArmCustomIpxeBootStep } from '../arm-custom-ipxe-boot.step.js';

function makeCtx(overrides: Partial<SagaContext> = {}): SagaContext {
  return {
    planId: 'plan-1',
    stepName: 'arm_custom_ipxe_boot',
    deviceId: 'dev-1',
    payload: {
      platform: { slug: 'ipxe-custom-tee' },
      lifecycle_data: { ipxe_url: 'https://boot.example/custom.ipxe' },
    },
    jobId: 'job-1',
    attempt: 1,
    metadata: {},
    stepResults: {},
    ...overrides,
  };
}

function makeStep() {
  const set = vi.fn().mockResolvedValue('OK');
  return { step: new ArmCustomIpxeBootStep({ set }), set };
}

describe('ArmCustomIpxeBootStep', () => {
  it.each(['ipxe-custom', 'ubuntu-noble'])('skips the %s platform', async (slug) => {
    const { step, set } = makeStep();

    await expect(
      step.execute(makeCtx({ payload: { platform: { slug }, lifecycle_data: { ipxe_url: 'https://boot/ipxe' } } })),
    ).resolves.toEqual({ skipped: true, reason: 'platform is not ipxe-custom-tee' });
    expect(set).not.toHaveBeenCalled();
  });

  it.each([undefined, null, ''])('skips a missing iPXE URL (%s)', async (ipxeUrl) => {
    const { step, set } = makeStep();

    await expect(
      step.execute(
        makeCtx({
          payload: {
            platform: { slug: 'ipxe-custom-tee' },
            lifecycle_data: { ipxe_url: ipxeUrl },
          },
        }),
      ),
    ).resolves.toEqual({ skipped: true, reason: 'ipxe_url is missing' });
    expect(set).not.toHaveBeenCalled();
  });

  it('writes the custom iPXE URL with the provision-window TTL and saga job ID', async () => {
    const { step, set } = makeStep();

    await expect(step.execute(makeCtx())).resolves.toEqual({ armed: true });
    expect(set).toHaveBeenCalledWith(
      'device:dev-1:config:ipxe_url',
      'https://boot.example/custom.ipxe',
      21_600,
      'job-1',
    );
  });

  it('propagates a Redis failure for saga recovery', async () => {
    const { step, set } = makeStep();
    const error = new Error('Redis unavailable');
    set.mockRejectedValue(error);

    await expect(step.execute(makeCtx())).rejects.toBe(error);
  });
});
