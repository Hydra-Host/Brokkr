import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SagaContext } from '../../../../saga-framework/saga.types';
import {
  clearActiveZoneCryptoSnapshot,
  setActiveZoneCryptoSnapshot,
} from '../../../../zone-crypto/zone-crypto.service';
import { ZONE_CRYPTO_SNAPSHOT, sealedBmcPayload } from '../../../steps/__test__/sealed-bmc.testutil';
import { decideTeeAction } from '../../decide-tee-action';
import { DisableOsBootStep } from '../disable-os-boot.step';
import { RedfishStandardizeStep } from '../redfish-standardize.step';
import { TeeConfigStep } from '../tee-config.step';

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

beforeEach(() => setActiveZoneCryptoSnapshot(ZONE_CRYPTO_SNAPSHOT));
afterEach(() => clearActiveZoneCryptoSnapshot());

const CREDS = sealedBmcPayload();

describe('DisableOsBootStep', () => {
  it('throws when disableOsBootOptions reports failure', async () => {
    const redfish = { disableOsBootOptions: vi.fn().mockResolvedValue(false) };
    const step = new DisableOsBootStep(redfish);
    await expect(step.execute(makeContext(CREDS))).rejects.toThrowError(/disableOsBootOptions failed/);
  });

  it('returns success on the happy path', async () => {
    const redfish = { disableOsBootOptions: vi.fn().mockResolvedValue(true) };
    const step = new DisableOsBootStep(redfish);
    await expect(step.execute(makeContext(CREDS))).resolves.toEqual({ success: true });
  });
});

describe('RedfishStandardizeStep', () => {
  it('propagates the thrown error from redfishStandardize so the saga fails', async () => {
    const redfish = { redfishStandardize: vi.fn().mockRejectedValue(new Error('BMC errored')) };
    const step = new RedfishStandardizeStep(redfish);
    await expect(step.execute(makeContext(CREDS))).rejects.toThrowError('BMC errored');
  });

  it('returns bios_params on the happy path', async () => {
    const redfish = { redfishStandardize: vi.fn().mockResolvedValue({ BootMode: 'Uefi' }) };
    const step = new RedfishStandardizeStep(redfish);
    await expect(step.execute(makeContext(CREDS))).resolves.toEqual({ bios_params: { BootMode: 'Uefi' } });
  });
});

describe('TeeConfigStep', () => {
  const logger = {
    info: vi.fn().mockResolvedValue(undefined),
    warning: vi.fn().mockResolvedValue(undefined),
  };
  const verified = { checked: true, ok: true, missing: [] };
  const failed = { checked: true, ok: false, missing: [{ key: 'EnableTdx' }] };
  const unmodeled = { checked: false, ok: true, missing: [], reason: 'unmodeled' };
  const unreachable = { checked: false, ok: false, missing: [], reason: 'bmc-unreachable' };
  const setOk = { success: true, hostResetAt: null };
  const setFailed = { success: false, hostResetAt: null };
  const setFenced = { success: true, hostResetAt: 1_726_000_000 };

  it('throws when enableTee reports failure', async () => {
    const redfish = { enableTee: vi.fn().mockResolvedValue(setFailed), disableTee: vi.fn(), verifyTee: vi.fn() };
    const step = new TeeConfigStep(redfish, logger);
    const ctx = makeContext({ ...CREDS, tee_requested: true, tee_enabled: false });
    await expect(step.execute(ctx)).rejects.toThrowError(/enableTee failed/);
    expect(redfish.verifyTee).not.toHaveBeenCalled();
  });

  it('throws when disableTee reports failure (boolean is no longer discarded)', async () => {
    const redfish = { enableTee: vi.fn(), disableTee: vi.fn().mockResolvedValue(setFailed), verifyTee: vi.fn() };
    const step = new TeeConfigStep(redfish, logger);
    const ctx = makeContext({ ...CREDS, tee_requested: false, tee_enabled: true });
    await expect(step.execute(ctx)).rejects.toThrowError(/disableTee failed/);
  });

  it('returns enabled on the happy path', async () => {
    const redfish = {
      enableTee: vi.fn().mockResolvedValue(setOk),
      disableTee: vi.fn(),
      verifyTee: vi.fn().mockResolvedValue(verified),
    };
    const step = new TeeConfigStep(redfish, logger);
    const ctx = makeContext({ ...CREDS, tee_requested: true, tee_enabled: false });
    await expect(step.execute(ctx)).resolves.toEqual({ action: 'enabled', success: true });
  });

  it('verifies a standard platform enable', async () => {
    const redfish = {
      enableTee: vi.fn().mockResolvedValue(setOk),
      disableTee: vi.fn(),
      verifyTee: vi.fn().mockResolvedValue(verified),
    };
    const step = new TeeConfigStep(redfish, logger);
    const ctx = makeContext({
      ...CREDS,
      platform: { slug: 'ubuntu-24.04' },
      tee_requested: true,
      tee_enabled: false,
    });

    await expect(step.execute(ctx)).resolves.toEqual({ action: 'enabled', success: true });
    expect(redfish.enableTee).toHaveBeenCalledOnce();
    expect(redfish.verifyTee).toHaveBeenCalledOnce();
  });

  it('verifies a standard platform skip when tee is requested', async () => {
    const redfish = {
      enableTee: vi.fn(),
      disableTee: vi.fn(),
      verifyTee: vi.fn().mockResolvedValue(verified),
    };
    const step = new TeeConfigStep(redfish, logger);
    const ctx = makeContext({
      ...CREDS,
      platform: { slug: 'ubuntu-24.04' },
      tee_requested: true,
      tee_enabled: true,
    });

    await expect(step.execute(ctx)).resolves.toEqual({
      skipped: true,
      reason: 'current=true, requested=true',
      success: true,
    });
    expect(redfish.enableTee).not.toHaveBeenCalled();
    expect(redfish.verifyTee).toHaveBeenCalledOnce();
  });

  it('verifies a successful ipxe-custom-tee enable', async () => {
    const redfish = {
      enableTee: vi.fn().mockResolvedValue(setOk),
      disableTee: vi.fn(),
      verifyTee: vi.fn().mockResolvedValue(verified),
    };
    const step = new TeeConfigStep(redfish, logger);
    const ctx = makeContext({
      ...CREDS,
      platform: { slug: 'ipxe-custom-tee' },
      tee_requested: true,
      tee_enabled: false,
    });

    await expect(step.execute(ctx)).resolves.toEqual({ action: 'enabled', success: true });
    expect(redfish.enableTee).toHaveBeenCalledOnce();
    expect(redfish.verifyTee).toHaveBeenCalledOnce();
  });

  it('verifies before it retries an initial ipxe-custom-tee enable failure', async () => {
    const calls: string[] = [];
    const redfish = {
      enableTee: vi
        .fn()
        .mockImplementationOnce(async () => {
          calls.push('enable');
          return setFailed;
        })
        .mockImplementationOnce(async () => {
          calls.push('enable');
          return setOk;
        }),
      disableTee: vi.fn(),
      verifyTee: vi
        .fn()
        .mockImplementationOnce(async () => {
          calls.push('verify');
          return failed;
        })
        .mockImplementationOnce(async () => {
          calls.push('verify');
          return verified;
        }),
    };
    const step = new TeeConfigStep(redfish, logger);
    const ctx = makeContext({
      ...CREDS,
      platform: { slug: 'ipxe-custom-tee' },
      tee_requested: true,
      tee_enabled: false,
    });

    await expect(step.execute(ctx)).resolves.toEqual({ action: 'enabled', success: true });
    expect(calls).toEqual(['enable', 'verify', 'enable', 'verify']);
  });

  it('tolerates a failed re-enable and lets the next verification decide', async () => {
    const redfish = {
      enableTee: vi.fn().mockResolvedValueOnce(setOk).mockResolvedValueOnce(setFailed),
      disableTee: vi.fn(),
      verifyTee: vi.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce(verified),
    };
    const step = new TeeConfigStep(redfish, logger);
    const ctx = makeContext({
      ...CREDS,
      platform: { slug: 'ipxe-custom-tee' },
      tee_requested: true,
      tee_enabled: false,
    });

    await expect(step.execute(ctx)).resolves.toEqual({ action: 'enabled', success: true });
    expect(redfish.enableTee).toHaveBeenCalledTimes(2);
    expect(redfish.verifyTee).toHaveBeenCalledTimes(2);
  });

  it('retries an unreachable bmc without re-enabling', async () => {
    const redfish = {
      enableTee: vi.fn().mockResolvedValue(setOk),
      disableTee: vi.fn(),
      verifyTee: vi.fn().mockResolvedValueOnce(unreachable).mockResolvedValueOnce(verified),
    };
    const step = new TeeConfigStep(redfish, logger);
    const ctx = makeContext({
      ...CREDS,
      platform: { slug: 'ubuntu-24.04' },
      tee_requested: true,
      tee_enabled: false,
    });

    await expect(step.execute(ctx)).resolves.toEqual({ action: 'enabled', success: true });
    expect(redfish.enableTee).toHaveBeenCalledOnce();
    expect(redfish.verifyTee).toHaveBeenCalledTimes(2);
  });

  it('re-enables only after a failed readback, not after an unreachable one', async () => {
    const calls: string[] = [];
    const redfish = {
      enableTee: vi.fn().mockImplementation(async () => {
        calls.push('enable');
        return setOk;
      }),
      disableTee: vi.fn(),
      verifyTee: vi
        .fn()
        .mockImplementationOnce(async () => {
          calls.push('verify');
          return unreachable;
        })
        .mockImplementationOnce(async () => {
          calls.push('verify');
          return failed;
        })
        .mockImplementationOnce(async () => {
          calls.push('verify');
          return verified;
        }),
    };
    const step = new TeeConfigStep(redfish, logger);
    const ctx = makeContext({
      ...CREDS,
      platform: { slug: 'ubuntu-24.04' },
      tee_requested: true,
      tee_enabled: false,
    });

    await expect(step.execute(ctx)).resolves.toEqual({ action: 'enabled', success: true });
    expect(calls).toEqual(['enable', 'verify', 'verify', 'enable', 'verify']);
  });

  it('throws after three unreachable verification attempts without re-enabling', async () => {
    const redfish = {
      enableTee: vi.fn().mockResolvedValue(setOk),
      disableTee: vi.fn(),
      verifyTee: vi.fn().mockResolvedValue(unreachable),
    };
    const step = new TeeConfigStep(redfish, logger);
    const ctx = makeContext({
      ...CREDS,
      platform: { slug: 'ubuntu-24.04' },
      tee_requested: true,
      tee_enabled: false,
    });

    await expect(step.execute(ctx)).rejects.toThrowError(/after three attempts/);
    expect(redfish.verifyTee).toHaveBeenCalledTimes(3);
    expect(redfish.enableTee).toHaveBeenCalledOnce();
  });

  it('retries a reason-less unchecked readback without re-enabling', async () => {
    const redfish = {
      enableTee: vi.fn().mockResolvedValue(setOk),
      disableTee: vi.fn(),
      verifyTee: vi.fn().mockResolvedValue({ checked: false, ok: false, missing: [] }),
    };
    const step = new TeeConfigStep(redfish, logger);
    const ctx = makeContext({
      ...CREDS,
      platform: { slug: 'ubuntu-24.04' },
      tee_requested: true,
      tee_enabled: false,
    });

    await expect(step.execute(ctx)).rejects.toThrowError(/after three attempts/);
    expect(redfish.verifyTee).toHaveBeenCalledTimes(3);
    expect(redfish.enableTee).toHaveBeenCalledOnce();
  });

  it('returns disabled on the happy path', async () => {
    const redfish = { enableTee: vi.fn(), disableTee: vi.fn().mockResolvedValue(setOk), verifyTee: vi.fn() };
    const step = new TeeConfigStep(redfish, logger);
    const ctx = makeContext({ ...CREDS, tee_requested: false, tee_enabled: true });
    await expect(step.execute(ctx)).resolves.toEqual({ action: 'disabled' });
    expect(redfish.verifyTee).not.toHaveBeenCalled();
  });

  it('does not verify an ipxe-custom-tee disable', async () => {
    const redfish = {
      enableTee: vi.fn(),
      disableTee: vi.fn().mockResolvedValue(setOk),
      verifyTee: vi.fn(),
    };
    const step = new TeeConfigStep(redfish, logger);
    const ctx = makeContext({
      ...CREDS,
      platform: { slug: 'ipxe-custom-tee' },
      tee_requested: false,
      tee_enabled: true,
    });

    await expect(step.execute(ctx)).resolves.toEqual({ action: 'disabled' });
    expect(redfish.verifyTee).not.toHaveBeenCalled();
  });

  it.each([
    ['a standard platform', { slug: 'ubuntu-24.04' }],
    ['ipxe-custom', { slug: 'ipxe-custom' }],
    ['ipxe-custom-tee', { slug: 'ipxe-custom-tee' }],
  ])('does not verify %s when TEE is not requested', async (_name, platform) => {
    const redfish = { enableTee: vi.fn(), disableTee: vi.fn(), verifyTee: vi.fn() };
    const step = new TeeConfigStep(redfish, logger);
    const ctx = makeContext({ ...CREDS, platform, tee_requested: false, tee_enabled: false });
    await expect(step.execute(ctx)).resolves.toMatchObject({ skipped: true });
    expect(redfish.enableTee).not.toHaveBeenCalled();
    expect(redfish.disableTee).not.toHaveBeenCalled();
    expect(redfish.verifyTee).not.toHaveBeenCalled();
  });

  it('verifies an ipxe-custom-tee skip', async () => {
    const redfish = {
      enableTee: vi.fn(),
      disableTee: vi.fn(),
      verifyTee: vi.fn().mockResolvedValue(verified),
    };
    const step = new TeeConfigStep(redfish, logger);
    const ctx = makeContext({
      ...CREDS,
      platform: { slug: 'ipxe-custom-tee' },
      tee_requested: true,
      tee_enabled: true,
    });

    await expect(step.execute(ctx)).resolves.toEqual({
      skipped: true,
      reason: 'current=true, requested=true',
      success: true,
    });
    expect(redfish.enableTee).not.toHaveBeenCalled();
    expect(redfish.verifyTee).toHaveBeenCalledOnce();
  });

  it('proceeds without a verified result when the hardware is unmodeled', async () => {
    const redfish = {
      enableTee: vi.fn(),
      disableTee: vi.fn(),
      verifyTee: vi.fn().mockResolvedValue(unmodeled),
    };
    const step = new TeeConfigStep(redfish, logger);
    const ctx = makeContext({
      ...CREDS,
      platform: { slug: 'ubuntu-24.04' },
      tee_requested: true,
      tee_enabled: true,
    });

    await expect(step.execute(ctx)).resolves.toEqual({
      skipped: true,
      reason: 'current=true, requested=true',
    });
    expect(redfish.enableTee).not.toHaveBeenCalled();
    expect(redfish.verifyTee).toHaveBeenCalledOnce();
  });

  it('returns enabled without retrying when the hardware is unmodeled', async () => {
    const redfish = {
      enableTee: vi.fn().mockResolvedValue(setOk),
      disableTee: vi.fn(),
      verifyTee: vi.fn().mockResolvedValue(unmodeled),
    };
    const step = new TeeConfigStep(redfish, logger);
    const ctx = makeContext({
      ...CREDS,
      platform: { slug: 'ubuntu-24.04' },
      tee_requested: true,
      tee_enabled: false,
    });

    await expect(step.execute(ctx)).resolves.toEqual({ action: 'enabled', success: true });
    expect(redfish.enableTee).toHaveBeenCalledOnce();
    expect(redfish.verifyTee).toHaveBeenCalledOnce();
  });

  it('throws when enablement fails and the hardware is unmodeled', async () => {
    const redfish = {
      enableTee: vi.fn().mockResolvedValue(setFailed),
      disableTee: vi.fn(),
      verifyTee: vi.fn().mockResolvedValue({ ...unmodeled, ok: false }),
    };
    const step = new TeeConfigStep(redfish, logger);
    const ctx = makeContext({
      ...CREDS,
      platform: { slug: 'ipxe-custom-tee' },
      tee_requested: true,
      tee_enabled: false,
    });

    await expect(step.execute(ctx)).rejects.toThrowError(/enableTee failed/);
    expect(redfish.verifyTee).toHaveBeenCalledOnce();
  });

  it('throws after three failed ipxe-custom-tee verification passes', async () => {
    const redfish = {
      enableTee: vi.fn().mockResolvedValue(setOk),
      disableTee: vi.fn(),
      verifyTee: vi.fn().mockResolvedValue(failed),
    };
    const step = new TeeConfigStep(redfish, logger);
    const ctx = makeContext({
      ...CREDS,
      platform: { slug: 'ipxe-custom-tee' },
      tee_requested: true,
      tee_enabled: false,
    });

    await expect(step.execute(ctx)).rejects.toThrowError(/after three attempts/);
    expect(redfish.verifyTee).toHaveBeenCalledTimes(3);
    expect(redfish.enableTee).toHaveBeenCalledTimes(3);
  });

  it('falls back to platform.variant=tee when tee_requested is absent (backward-compat)', async () => {
    const redfish = {
      enableTee: vi.fn().mockResolvedValue(setOk),
      disableTee: vi.fn(),
      verifyTee: vi.fn().mockResolvedValue(verified),
    };
    const step = new TeeConfigStep(redfish, logger);
    const ctx = makeContext({ ...CREDS, platform: { variant: 'tee' }, tee_enabled: false });
    await expect(step.execute(ctx)).resolves.toEqual({ action: 'enabled', success: true });
  });

  it('skips when tee_requested is absent and platform.variant is not tee', async () => {
    const redfish = { enableTee: vi.fn(), disableTee: vi.fn(), verifyTee: vi.fn() };
    const step = new TeeConfigStep(redfish, logger);
    const ctx = makeContext({ ...CREDS, platform: { variant: 'vanilla' }, tee_enabled: false });
    await expect(step.execute(ctx)).resolves.toMatchObject({ skipped: true });
    expect(redfish.enableTee).not.toHaveBeenCalled();
    expect(redfish.verifyTee).not.toHaveBeenCalled();
  });

  it('explicit tee_requested=false wins over platform.variant=tee', async () => {
    const redfish = { enableTee: vi.fn(), disableTee: vi.fn(), verifyTee: vi.fn() };
    const step = new TeeConfigStep(redfish, logger);
    const ctx = makeContext({ ...CREDS, tee_requested: false, platform: { variant: 'tee' }, tee_enabled: false });
    await expect(step.execute(ctx)).resolves.toMatchObject({ skipped: true });
    expect(redfish.enableTee).not.toHaveBeenCalled();
  });

  it('throws when an action is required but the sealed credential is missing', async () => {
    const redfish = { enableTee: vi.fn().mockResolvedValue(setOk), disableTee: vi.fn(), verifyTee: vi.fn() };
    const step = new TeeConfigStep(redfish, logger);
    const ctx = makeContext({
      tee_requested: true,
      tee_enabled: false,
    });
    await expect(step.execute(ctx)).rejects.toThrowError(/Missing or invalid BMC credential/);
    expect(redfish.enableTee).not.toHaveBeenCalled();
  });

  it('throws when a requested skip needs verification but credentials are missing', async () => {
    const redfish = { enableTee: vi.fn(), disableTee: vi.fn(), verifyTee: vi.fn() };
    const step = new TeeConfigStep(redfish, logger);
    const ctx = makeContext({
      platform: { slug: 'ubuntu-24.04' },
      tee_requested: true,
      tee_enabled: true,
    });

    await expect(step.execute(ctx)).rejects.toThrowError(/Missing or invalid BMC credential/);
    expect(redfish.verifyTee).not.toHaveBeenCalled();
  });

  it('reports host_reset_at after a fenced enable', async () => {
    const redfish = {
      enableTee: vi.fn().mockResolvedValue(setFenced),
      disableTee: vi.fn(),
      verifyTee: vi.fn().mockResolvedValue(verified),
    };
    const step = new TeeConfigStep(redfish, logger);
    const ctx = makeContext({ ...CREDS, tee_requested: true, tee_enabled: false });
    await expect(step.execute(ctx)).resolves.toEqual({
      action: 'enabled',
      success: true,
      host_reset_at: 1_726_000_000,
    });
  });

  it('reports host_reset_at after a fenced disable', async () => {
    const redfish = { enableTee: vi.fn(), disableTee: vi.fn().mockResolvedValue(setFenced), verifyTee: vi.fn() };
    const step = new TeeConfigStep(redfish, logger);
    const ctx = makeContext({ ...CREDS, tee_requested: false, tee_enabled: true });
    await expect(step.execute(ctx)).resolves.toEqual({ action: 'disabled', host_reset_at: 1_726_000_000 });
  });

  it('omits host_reset_at when the enable did not fence', async () => {
    const redfish = {
      enableTee: vi.fn().mockResolvedValue(setOk),
      disableTee: vi.fn(),
      verifyTee: vi.fn().mockResolvedValue(verified),
    };
    const step = new TeeConfigStep(redfish, logger);
    const ctx = makeContext({ ...CREDS, tee_requested: true, tee_enabled: false });
    const result = await step.execute(ctx);
    expect(result).not.toHaveProperty('host_reset_at');
  });

  it('omits host_reset_at on a skip', async () => {
    const redfish = { enableTee: vi.fn(), disableTee: vi.fn(), verifyTee: vi.fn().mockResolvedValue(verified) };
    const step = new TeeConfigStep(redfish, logger);
    const ctx = makeContext({ ...CREDS, platform: { slug: 'ubuntu-24.04' }, tee_requested: true, tee_enabled: true });
    const result = await step.execute(ctx);
    expect(result).toEqual({ skipped: true, reason: 'current=true, requested=true', success: true });
    expect(result).not.toHaveProperty('host_reset_at');
  });

  it('carries the reset from a re-enable during verification', async () => {
    const redfish = {
      enableTee: vi.fn().mockResolvedValue(setFenced),
      disableTee: vi.fn(),
      verifyTee: vi.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce(verified),
    };
    const step = new TeeConfigStep(redfish, logger);
    const ctx = makeContext({ ...CREDS, platform: { slug: 'ubuntu-24.04' }, tee_requested: true, tee_enabled: true });
    await expect(step.execute(ctx)).resolves.toEqual({
      skipped: true,
      reason: 'current=true, requested=true',
      success: true,
      host_reset_at: 1_726_000_000,
    });
  });
});

describe('decideTeeAction', () => {
  it.each([
    [true, false, 'enable'],
    [true, true, 'skip'],
    [false, false, 'skip'],
    [false, true, 'disable'],
  ] as const)('teeRequested=%s teeEnabled=%s → %s', (teeRequested, teeEnabled, expected) => {
    expect(decideTeeAction({ teeRequested, teeEnabled })).toBe(expected);
  });
});
