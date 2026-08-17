import { describe, expect, it, vi } from 'vitest';

import type { SagaContext } from '../../../saga-framework/saga.types.js';
import { EfiCleanupStep } from '../efi-cleanup.step.js';

function makeCtx(overrides: Partial<SagaContext> = {}): SagaContext {
  return {
    planId: 'plan-1',
    stepName: 'efi_cleanup',
    deviceId: 'dev-1',
    payload: {},
    jobId: 'job-1',
    attempt: 1,
    metadata: {},
    stepResults: {},
    ...overrides,
  };
}

function makeStep(cleanup: ReturnType<typeof vi.fn>) {
  const factory = { create: vi.fn().mockResolvedValue({ cleanupOsBootEntries: cleanup }) };
  const logger = {
    info: vi.fn().mockResolvedValue(undefined),
    warning: vi.fn().mockResolvedValue(undefined),
  };
  const step = new EfiCleanupStep(factory, logger);
  return { step, factory, logger };
}

describe('EfiCleanupStep', () => {
  it('returns the cleanup result on success', async () => {
    const cleanup = vi.fn().mockResolvedValue({ removed: ['Boot0001'], count: 1 });
    const { step } = makeStep(cleanup);

    const result = await step.execute(makeCtx());

    expect(result).toEqual({ removed: ['Boot0001'], count: 1 });
  });

  it('swallows ALL errors (non-fatal) and returns the error-shaped result instead of throwing', async () => {
    const cleanup = vi.fn().mockRejectedValue(new Error('efibootmgr not found'));
    const { step, logger } = makeStep(cleanup);

    const result = await step.execute(makeCtx());

    expect(result).toEqual({ removed: [], count: 0, error: 'efibootmgr not found' });
    expect(logger.warning).toHaveBeenCalledTimes(1);
    expect(logger.warning.mock.calls[0][0]).toContain('non-fatal');
  });

  it('also swallows non-Error throwables, stringifying them into the error field', async () => {
    const cleanup = vi.fn().mockRejectedValue('weird string failure');
    const { step } = makeStep(cleanup);

    const result = await step.execute(makeCtx());

    expect(result).toEqual({ removed: [], count: 0, error: 'weird string failure' });
  });
});
