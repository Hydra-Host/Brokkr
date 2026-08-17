import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SagaContext } from '../../../saga-framework/saga.types.js';
import { clearActiveZoneCryptoSnapshot, setActiveZoneCryptoSnapshot } from '../../../zone-crypto/zone-crypto.service';
import { IPMIValidationError } from '../../ipmi/validation.js';
import { PcBmcResetColdStep } from '../pc-bmc-reset-cold.step.js';
import { ZONE_CRYPTO_SNAPSHOT, sealedBmcPayload } from './sealed-bmc.testutil';

beforeEach(() => setActiveZoneCryptoSnapshot(ZONE_CRYPTO_SNAPSHOT));
afterEach(() => clearActiveZoneCryptoSnapshot());

function ctxWith(payload: Record<string, unknown>): SagaContext {
  return {
    planId: 'plan-1',
    stepName: 'pc_bmc_reset_cold',
    deviceId: 'dev-1',
    payload,
    jobId: 'job-1',
    attempt: 1,
    metadata: {},
    stepResults: {},
  };
}

function makeStep() {
  const pingWithRetry = vi.fn(async () => true);
  const create = vi.fn(() => ({
    ip: '10.0.0.9',
    username: 'admin',
    password: 'secret',
    port: 623,
    cipher: null,
    jobId: 'job-1',
  }));
  const mcReset = vi.fn(async () => ({ ok: true, stdout: '', stderr: '', error: '' }));
  const step = new PcBmcResetColdStep(
    {
      create,
      withCipher: (device, cipher) => ({ ...device, cipher }),
    },
    { pingWithRetry },
    { getCipherForDevice: vi.fn(async () => null) },
    { mcReset },
    { info: vi.fn(async () => undefined), warning: vi.fn(async () => undefined), error: vi.fn(async () => undefined) },
    { sleep: vi.fn(async () => undefined) },
  );
  return { step, pingWithRetry, create, mcReset };
}

describe('PcBmcResetColdStep input validation', () => {
  it('rejects a malicious bmc_ip before pinging or building the ipmitool argv', async () => {
    const { step, pingWithRetry, create } = makeStep();
    const ctx = ctxWith(sealedBmcPayload({ user: 'admin', pass: 'secret' }, '10.0.0.9; rm -rf /'));

    await expect(step.execute(ctx)).rejects.toThrow(IPMIValidationError);
    expect(pingWithRetry).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a bmc_ip carrying an ipmitool flag', async () => {
    const { step, pingWithRetry } = makeStep();
    const ctx = ctxWith(sealedBmcPayload({ user: 'admin', pass: 'secret' }, '-oProxyCommand=evil'));

    await expect(step.execute(ctx)).rejects.toThrow(IPMIValidationError);
    expect(pingWithRetry).not.toHaveBeenCalled();
  });

  it('rejects a username with shell metacharacters', async () => {
    const { step, pingWithRetry } = makeStep();
    const ctx = ctxWith(sealedBmcPayload({ user: 'admin;reboot', pass: 'secret' }));

    await expect(step.execute(ctx)).rejects.toThrow(IPMIValidationError);
    expect(pingWithRetry).not.toHaveBeenCalled();
  });

  it('rejects a non-string bmc_ip at the sealed-payload boundary', async () => {
    const { step, pingWithRetry } = makeStep();
    const ctx = ctxWith({ ...sealedBmcPayload(), bmc_ip: 12345 });

    await expect(step.execute(ctx)).rejects.toThrow(/Missing or invalid BMC credential/);
    expect(pingWithRetry).not.toHaveBeenCalled();
  });
});
