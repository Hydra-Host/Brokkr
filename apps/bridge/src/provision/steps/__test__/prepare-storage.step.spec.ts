import { describe, expect, it, vi } from 'vitest';

import { NonRetryableSagaError } from '../../../saga-framework/saga-runner.service.js';
import type { SagaContext } from '../../../saga-framework/saga.types.js';
import { PrepareStorageStep } from '../prepare-storage.step.js';

function makeCtx(overrides: Partial<SagaContext> = {}): SagaContext {
  return {
    planId: 'plan-1',
    stepName: 'prepare_storage',
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
  const prepareStorage = vi.fn().mockResolvedValue({ prepared: true });
  const factory = { create: vi.fn().mockResolvedValue({ prepareStorage }) };
  const step = new PrepareStorageStep(factory);
  return { step, factory, prepareStorage };
}

describe('PrepareStorageStep', () => {
  it('throws a NonRetryableSagaError when device_id is missing', async () => {
    const { step } = makeStep();
    await expect(step.execute(makeCtx({ deviceId: null }))).rejects.toBeInstanceOf(NonRetryableSagaError);
    await expect(step.execute(makeCtx({ deviceId: null }))).rejects.toThrow('device_id is required');
  });

  it('propagates the skipped signal from resolve_deploy_target without calling orchestration', async () => {
    const { step, factory } = makeStep();
    const ctx = makeCtx({
      stepResults: { resolve_deploy_target: { skipped: true, reason: 'ipxe_url provided' } },
    });

    const result = await step.execute(ctx);

    expect(result).toEqual({ skipped: true, reason: 'ipxe_url provided' });
    expect(factory.create).not.toHaveBeenCalled();
  });

  it('prepares storage with the resolved layouts and target path', async () => {
    const { step, prepareStorage } = makeStep();
    const ctx = makeCtx({
      stepResults: {
        resolve_deploy_target: {
          os_payload: { target_path: '/custom' },
          disk_layouts: [{ device: '/dev/sda' }],
        },
      },
    });

    const result = await step.execute(ctx);

    expect(result).toEqual({ prepared: true });
    expect(prepareStorage).toHaveBeenCalledWith({
      deviceId: 'dev-1',
      diskLayouts: [{ device: '/dev/sda' }],
      targetPath: '/custom',
    });
  });

  it('defaults the target path to /target when not provided', async () => {
    const { step, prepareStorage } = makeStep();
    await step.execute(makeCtx());
    expect(prepareStorage).toHaveBeenCalledWith({
      deviceId: 'dev-1',
      diskLayouts: [],
      targetPath: '/target',
    });
  });
});
