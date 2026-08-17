
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SagaContext } from '../../../../saga-framework/saga.types';
import {
  clearActiveZoneCryptoSnapshot,
  setActiveZoneCryptoSnapshot,
} from '../../../../zone-crypto/zone-crypto.service';
import { ZONE_CRYPTO_SNAPSHOT, sealedBmcPayload } from '../../../steps/__test__/sealed-bmc.testutil';
import { EnsureSolEnabledStep } from '../ensure-sol-enabled.step';

beforeEach(() => setActiveZoneCryptoSnapshot(ZONE_CRYPTO_SNAPSHOT));
afterEach(() => clearActiveZoneCryptoSnapshot());

function makeContext(payload: Record<string, unknown>): SagaContext {
  return {
    planId: 'plan-1',
    stepName: 'step-1',
    deviceId: 'device-1',
    payload,
    jobId: 'job-abc',
    attempt: 0,
    metadata: {},
    stepResults: {},
  };
}

function makeLogger() {
  return {
    info: vi.fn().mockResolvedValue(undefined),
    warning: vi.fn().mockResolvedValue(undefined),
  };
}

const ENABLED_RESULT = {
  channel: 1,
  user_id: 2,
  privilege: 'ADMINISTRATOR',
  channel_sol_was_enabled: true,
  user_payload_was_enabled: true,
  actions: ['enabled-sol'],
};

const CREDS = sealedBmcPayload();

function makeStep(opts: { simEnabled: boolean; ensureSolEnabled?: ReturnType<typeof vi.fn> }) {
  const ensureSolEnabled = opts.ensureSolEnabled ?? vi.fn().mockResolvedValue(ENABLED_RESULT);
  const service = { ensureSolEnabled };
  const factory = { create: vi.fn().mockResolvedValue(service) };
  const logger = makeLogger();
  const simMode = { isLocalSimulationEnabled: vi.fn().mockReturnValue(opts.simEnabled) };
  const step = new EnsureSolEnabledStep(factory, logger, simMode);
  return { step, factory, ensureSolEnabled, logger, simMode };
}

describe('EnsureSolEnabledStep', () => {
  it('skips with the sim envelope when local simulation is enabled', async () => {
    const { step, factory, logger } = makeStep({ simEnabled: true });
    const result = await step.execute(makeContext(CREDS));
    expect(result).toEqual({ sol_ready: false, reason: 'local_simulation_enabled' });
    expect(factory.create).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('[sim] SOL prerequisites skipped', { jobId: 'job-abc' });
  });

  it('returns the success envelope, spreading the service result onto sol_ready', async () => {
    const { step, factory, ensureSolEnabled } = makeStep({ simEnabled: false });
    const result = await step.execute(makeContext({ ...CREDS, device_id: 'device-1' }));
    expect(result).toEqual({ sol_ready: true, ...ENABLED_RESULT });
    expect(factory.create).toHaveBeenCalledWith('job-abc');
    expect(ensureSolEnabled).toHaveBeenCalledWith({
      deviceId: 'device-1',
      bmcIp: '10.0.0.5',
      username: 'admin',
      password: 'secret',
      port: 623,
    });
  });

  it('passes deviceId null when the payload omits device_id (no shared LAN-channel cache key)', async () => {
    const { step, ensureSolEnabled } = makeStep({ simEnabled: false });
    await step.execute(makeContext(CREDS));
    expect(ensureSolEnabled).toHaveBeenCalledWith(expect.objectContaining({ deviceId: null }));
  });

  it('resolves the BMC address from bmc_ip', async () => {
    const { step, ensureSolEnabled } = makeStep({ simEnabled: false });
    await step.execute(makeContext(CREDS));
    expect(ensureSolEnabled).toHaveBeenCalledWith(expect.objectContaining({ bmcIp: '10.0.0.5' }));
  });

  it('passes the supplied port through instead of the default', async () => {
    const { step, ensureSolEnabled } = makeStep({ simEnabled: false });
    await step.execute(makeContext({ ...CREDS, port: 6230 }));
    expect(ensureSolEnabled).toHaveBeenCalledWith(expect.objectContaining({ port: 6230 }));
  });

  it('returns the non-fatal envelope when the sealed credential payload is absent', async () => {
    const { step, ensureSolEnabled, logger } = makeStep({ simEnabled: false });
    const result = await step.execute(makeContext({ bmc_ip: '10.0.0.5' }));
    expect(result).toMatchObject({ sol_ready: false, reason: expect.stringContaining('BMC credential payload') });
    expect(ensureSolEnabled).not.toHaveBeenCalled();
    expect(logger.warning).toHaveBeenCalled();
  });

  it('returns the non-fatal error envelope when the service throws', async () => {
    const ensureSolEnabled = vi.fn().mockRejectedValue(new Error('BMC unreachable'));
    const { step, logger } = makeStep({ simEnabled: false, ensureSolEnabled });
    const result = await step.execute(makeContext(CREDS));
    expect(result).toEqual({ sol_ready: false, reason: 'BMC unreachable' });
    expect(logger.warning).toHaveBeenCalledWith('SOL prerequisite check failed (non-fatal): BMC unreachable', {
      jobId: 'job-abc',
    });
  });

  it('returns the non-fatal envelope when the sealed secret is absent (bmc_ip alone is not enough)', async () => {
    const { step, ensureSolEnabled } = makeStep({ simEnabled: false });
    const result = await step.execute(makeContext({ bmc_ip: '10.0.0.5' }));
    expect(result).toEqual({ sol_ready: false, reason: expect.stringContaining('Missing or invalid BMC credential') });
    expect(ensureSolEnabled).not.toHaveBeenCalled();
  });
});
