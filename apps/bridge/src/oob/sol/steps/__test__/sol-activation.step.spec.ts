import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SagaContext } from '../../../../saga-framework/saga.types.js';
import {
  clearActiveZoneCryptoSnapshot,
  setActiveZoneCryptoSnapshot,
} from '../../../../zone-crypto/zone-crypto.service';
import { ZONE_CRYPTO_SNAPSHOT, sealedBmcPayload } from '../../../steps/__test__/sealed-bmc.testutil';
import { SolActivationStep } from '../sol-activation.step.js';

beforeEach(() => setActiveZoneCryptoSnapshot(ZONE_CRYPTO_SNAPSHOT));
afterEach(() => clearActiveZoneCryptoSnapshot());

function ctxWith(payload: Record<string, unknown>): SagaContext {
  return {
    planId: 'plan-1',
    stepName: 'sol_activation',
    deviceId: 'dev-1',
    payload,
    jobId: 'job-1',
    attempt: 1,
    metadata: {},
    stepResults: {},
  };
}

function makeStep(
  opts: {
    simEnabled?: boolean;
    monitorSession?: () => Promise<unknown>;
    create?: () => Promise<{ monitorSession: () => Promise<unknown> }>;
  } = {},
) {
  const monitorSession = opts.monitorSession ?? (() => new Promise<unknown>(() => undefined));
  const create = opts.create ?? vi.fn(async () => ({ monitorSession: vi.fn(monitorSession) }));
  const factory = { create };
  const logger = {
    info: vi.fn(async () => undefined),
    warning: vi.fn(async () => undefined),
  };
  const simMode = { isLocalSimulationEnabled: vi.fn(() => opts.simEnabled ?? false) };
  const step = new SolActivationStep(factory, logger, simMode);
  return { step, factory, create, logger, simMode };
}

describe('SolActivationStep.execute', () => {
  it('skips and returns local_simulation_enabled when sim mode is on', async () => {
    const { step, create, logger } = makeStep({ simEnabled: true });

    const result = await step.execute(ctxWith({ bmc_ip: '10.0.0.9' }));

    expect(result).toEqual({ sol_activated: false, reason: 'local_simulation_enabled' });
    expect(create).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('[sim] SOL activation skipped', { jobId: 'job-1' });
  });

  it('returns a non-fatal envelope when the sealed credential is absent', async () => {
    const { step, create } = makeStep();

    const missing = await step.execute(ctxWith({}));
    const empty = await step.execute(ctxWith({ bmc_ip: '' }));

    expect(missing).toEqual({
      sol_activated: false,
      reason: expect.stringContaining('Missing or invalid BMC credential'),
    });
    expect(empty).toEqual({
      sol_activated: false,
      reason: expect.stringContaining('Missing or invalid BMC credential'),
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('returns sol_activated:true and registers a background task on successful dispatch', async () => {
    const monitorSession = vi.fn(() => new Promise<unknown>(() => undefined));
    const create = vi.fn(async () => ({ monitorSession }));
    const { step } = makeStep({ create });

    const result = await step.execute(ctxWith(sealedBmcPayload()));

    expect(result).toEqual({ sol_activated: true });
    expect(create).toHaveBeenCalledWith('job-1');
    expect(monitorSession).toHaveBeenCalledWith({
      planId: 'plan-1',
      ipAddress: '10.0.0.5',
      username: 'admin',
      password: 'secret',
      timeout: 300,
    });
    expect((step as unknown as { backgroundTasks: Set<unknown> }).backgroundTasks.size).toBe(1);
  });

  it('logs the background task terminal outcome when the monitor session fails', async () => {
    let rejectTask: (e: unknown) => void = () => undefined;
    const monitorSession = vi.fn(
      () =>
        new Promise<unknown>((_resolve, reject) => {
          rejectTask = reject;
        }),
    );
    const create = vi.fn(async () => ({ monitorSession }));
    const { step, logger } = makeStep({ create });

    const result = await step.execute(ctxWith(sealedBmcPayload()));
    expect(result).toEqual({ sol_activated: true });

    rejectTask(new Error('cipher failure'));
    await new Promise((resolve) => setImmediate(resolve));

    expect(logger.warning).toHaveBeenCalledWith('SOL monitoring session failed: cipher failure', {
      jobId: 'job-1',
    });
    expect((step as unknown as { backgroundTasks: Set<unknown> }).backgroundTasks.size).toBe(0);
  });

  it('returns a non-fatal envelope when the factory throws', async () => {
    const create = vi.fn(async () => {
      throw new Error('factory boom');
    });
    const { step, logger } = makeStep({ create });

    const result = await step.execute(ctxWith(sealedBmcPayload()));

    expect(result).toEqual({ sol_activated: false, reason: 'factory boom' });
    expect(logger.warning).toHaveBeenCalledWith('SOL activation error (non-fatal): factory boom', {
      jobId: 'job-1',
    });
  });
});
