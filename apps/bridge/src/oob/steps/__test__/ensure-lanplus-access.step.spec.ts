import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SagaContext } from '../../../saga-framework/saga.types.js';
import type { ChannelAccessOutcome } from '../../ipmi/rmcp-plus.js';
import { IPMIValidationError } from '../../ipmi/validation.js';
import { EnsureLanplusAccessStep } from '../ensure-lanplus-access.step.js';
import { clearZoneCrypto, installZoneCrypto, sealedCredPayload } from './seal-bmc.fixture.js';

beforeEach(() => installZoneCrypto());
afterEach(() => clearZoneCrypto());

function ctxWith(
  opts: { bmcIp?: string; user?: string; pass?: string; extra?: Record<string, unknown> } = {},
): SagaContext {
  return {
    planId: 'plan-1',
    stepName: 'ensure_lanplus_access',
    deviceId: 'dev-1',
    payload: { ...sealedCredPayload({ bmcIp: opts.bmcIp, user: opts.user, pass: opts.pass }), ...opts.extra },
    jobId: 'job-1',
    attempt: 1,
    metadata: {},
    stepResults: {},
  };
}

function okOutcome(): ChannelAccessOutcome {
  return {
    channel: 1,
    lanOk: true,
    lanplusOk: true,
    uid: 2,
    blocked: false,
    reasons: [],
    action: null,
    repaired: false,
    before: null,
    after: null,
    error: null,
  };
}

function makeStep(outcome: ChannelAccessOutcome = okOutcome()) {
  const create = vi.fn(() => ({
    ip: '10.0.0.9',
    username: 'admin',
    password: 'secret',
    port: 623,
    cipher: null,
    jobId: 'job-1',
  }));
  const repair = vi.fn(async () => outcome);
  const info = vi.fn(async () => undefined);
  const warning = vi.fn(async () => undefined);
  const step = new EnsureLanplusAccessStep({ create }, { repair }, { info, warning });
  return { step, create, repair, info, warning };
}

describe('EnsureLanplusAccessStep input validation', () => {
  it('rejects a malicious bmc_ip before building the ipmitool argv', async () => {
    const { step, create, repair } = makeStep();
    const ctx = ctxWith({ bmcIp: '10.0.0.9; rm -rf /' });

    await expect(step.execute(ctx)).rejects.toThrow(IPMIValidationError);
    expect(create).not.toHaveBeenCalled();
    expect(repair).not.toHaveBeenCalled();
  });

  it('rejects a bmc_ip carrying an ipmitool flag', async () => {
    const { step, create } = makeStep();
    const ctx = ctxWith({ bmcIp: '-oProxyCommand=evil' });

    await expect(step.execute(ctx)).rejects.toThrow(IPMIValidationError);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a username (from the sealed secret) with shell metacharacters', async () => {
    const { step, create } = makeStep();
    const ctx = ctxWith({ user: 'admin;reboot' });

    await expect(step.execute(ctx)).rejects.toThrow(IPMIValidationError);
    expect(create).not.toHaveBeenCalled();
  });

  it('throws when no sealed secrets.bmc is present (no plaintext fallback)', async () => {
    const { step, create } = makeStep();
    const ctx: SagaContext = {
      planId: 'plan-1',
      stepName: 'ensure_lanplus_access',
      deviceId: 'dev-1',
      payload: { bmc_ip: '10.0.0.9', username: 'admin', password: 'secret' },
      jobId: 'job-1',
      attempt: 1,
      metadata: {},
      stepResults: {},
    };

    await expect(step.execute(ctx)).rejects.toThrow(/Missing or invalid BMC credential payload/);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('EnsureLanplusAccessStep outcome handling', () => {
  const validCtx = ctxWith();

  it('skips when lanplus is already functional and not blocked', async () => {
    const { step } = makeStep({ ...okOutcome(), lanplusOk: true, blocked: false });

    await expect(step.execute(validCtx)).resolves.toEqual({ skipped: true, reason: 'lanplus already functional' });
  });

  it('reports repaired and logs when the outcome was repaired', async () => {
    const { step, info } = makeStep({
      ...okOutcome(),
      lanplusOk: true,
      blocked: true,
      repaired: true,
      channel: 3,
      uid: 7,
      reasons: ['privilege limit USER below ADMINISTRATOR'],
      action: 'channel setaccess 3 7 ipmi=on privilege=4',
    });

    await expect(step.execute(validCtx)).resolves.toEqual({
      repaired: true,
      channel: 3,
      uid: 7,
      reasons: ['privilege limit USER below ADMINISTRATOR'],
      action: 'channel setaccess 3 7 ipmi=on privilege=4',
    });
    expect(info).toHaveBeenCalledTimes(1);
  });

  it('throws when lanplus is blocked and repair failed', async () => {
    const { step } = makeStep({
      ...okOutcome(),
      lanplusOk: false,
      blocked: true,
      repaired: false,
      channel: 1,
      error: 'setaccess failed: permission denied',
    });

    await expect(step.execute(validCtx)).rejects.toThrow(/lanplus blocked by channel 1 access and repair failed/);
  });

  it('skips (deferring to validate_ipmi) when not repaired and not a blocked-failure', async () => {
    const { step, warning } = makeStep({
      ...okOutcome(),
      lanplusOk: false,
      blocked: false,
      repaired: null,
      error: 'lanplus failure is elsewhere',
    });

    await expect(step.execute(validCtx)).resolves.toEqual({ skipped: true, reason: 'lanplus failure is elsewhere' });
    expect(warning).toHaveBeenCalledTimes(1);
  });
});
