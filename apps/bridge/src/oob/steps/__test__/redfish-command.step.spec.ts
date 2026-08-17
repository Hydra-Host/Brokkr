import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RedfishDevice } from '../../../redfish/index.js';
import type { SagaContext } from '../../../saga-framework/saga.types.js';
import type { RedfishCommandKwargs, RedfishService } from '../../redfish.service.js';
import { RedfishCommandStep } from '../redfish-command.step.js';
import { clearZoneCrypto, installZoneCrypto, sealedCredPayload } from './seal-bmc.fixture.js';

beforeEach(() => installZoneCrypto());
afterEach(() => clearZoneCrypto());

function ctxWith(payload: Record<string, unknown>, deviceId: unknown = 'ctx-device'): SagaContext {
  return {
    planId: 'plan-1',
    stepName: 'redfish_command',
    deviceId,
    payload: { ...sealedCredPayload(), ...payload },
    jobId: 'job-1',
    attempt: 1,
    metadata: {},
    stepResults: {},
  };
}

interface ServiceFake {
  hasCommand: (command: string) => boolean;
  execute: (command: string, device: RedfishDevice, kwargs: RedfishCommandKwargs) => Promise<unknown>;
}

function makeStep(serviceOverrides: Partial<ServiceFake> = {}) {
  const service: ServiceFake = {
    hasCommand: vi.fn((command: string) => ['reliable_boot', 'bios_attributes', 'set_tee'].includes(command)),
    execute: vi.fn(async () => ({ ok: true })),
    ...serviceOverrides,
  };
  const create = vi.fn(async () => service as unknown as RedfishService);
  const logger = { info: vi.fn(async () => undefined), error: vi.fn(async () => undefined) };
  const step = new RedfishCommandStep({ create }, logger);
  return { step, service, create, logger };
}

describe('RedfishCommandStep.execute command validation', () => {
  it('throws when no command is specified', async () => {
    const { step, create } = makeStep();
    await expect(step.execute(ctxWith({}))).rejects.toThrow('No Redfish command specified in payload');
    expect(create).not.toHaveBeenCalled();
  });

  it.each([null, undefined, '', 0, false])('rejects falsy command %p', async (commandRaw) => {
    const { step } = makeStep();
    await expect(step.execute(ctxWith({ command: commandRaw }))).rejects.toThrow(
      'No Redfish command specified in payload',
    );
  });

  it('throws on an unknown command via hasCommand', async () => {
    const { step, service } = makeStep();
    await expect(step.execute(ctxWith({ command: 'bogus' }))).rejects.toThrow('Unknown Redfish command: bogus');
    expect(service.execute).not.toHaveBeenCalled();
  });
});

describe('RedfishCommandStep.execute credential resolution', () => {
  it('builds RedfishDevice with creds decrypted from the sealed secrets.bmc envelope', async () => {
    const { step, service } = makeStep();
    await step.execute(ctxWith({ command: 'reliable_boot' }));
    const device = (service.execute as ReturnType<typeof vi.fn>).mock.calls[0][1] as RedfishDevice;
    expect(device.bmcIp).toBe('10.0.0.9');
    expect(device.username).toBe('admin');
    expect(device.password).toBe('secret');
  });

  it('throws when secrets.bmc is absent (no plaintext fallback)', async () => {
    const { step, create } = makeStep();
    const ctx: SagaContext = {
      planId: 'plan-1',
      stepName: 'redfish_command',
      deviceId: 'ctx-device',
      payload: { command: 'reliable_boot', bmc_ip: '10.0.0.9', username: 'admin', password: 'secret' },
      jobId: 'job-1',
      attempt: 1,
      metadata: {},
      stepResults: {},
    };

    await expect(step.execute(ctx)).rejects.toThrow(/Missing or invalid BMC credential payload/);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('RedfishCommandStep.execute device_id fallback', () => {
  it('uses payload.device_id when present', async () => {
    const { step, service } = makeStep();
    await step.execute(ctxWith({ command: 'reliable_boot', device_id: 'payload-device' }));
    const device = (service.execute as ReturnType<typeof vi.fn>).mock.calls[0][1] as RedfishDevice;
    expect(device.deviceId).toBe('payload-device');
  });

  it.each([null, undefined, '', 0, false])(
    'falls back to ctx.deviceId when payload.device_id is %p',
    async (rawDeviceId) => {
      const { step, service } = makeStep();
      await step.execute(ctxWith({ command: 'reliable_boot', device_id: rawDeviceId }, 'ctx-device'));
      const device = (service.execute as ReturnType<typeof vi.fn>).mock.calls[0][1] as RedfishDevice;
      expect(device.deviceId).toBe('ctx-device');
    },
  );
});

describe('RedfishCommandStep.execute kwargs wrapping and result handling', () => {
  it('wraps payload.kwargs as { payload: innerPayload }', async () => {
    const { step, service } = makeStep();
    const innerPayload = { boot_device: 'pxe' };
    await step.execute(ctxWith({ command: 'reliable_boot', kwargs: innerPayload }));
    const kwargs = (service.execute as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(kwargs).toEqual({ payload: innerPayload });
  });

  it('defaults the inner payload to {} when kwargs is absent', async () => {
    const { step, service } = makeStep();
    await step.execute(ctxWith({ command: 'reliable_boot' }));
    const kwargs = (service.execute as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(kwargs).toEqual({ payload: {} });
  });

  it('returns the record result as-is', async () => {
    const { step } = makeStep({ execute: vi.fn(async () => ({ tee: 'enabled' })) });
    const result = await step.execute(ctxWith({ command: 'set_tee' }));
    expect(result).toEqual({ tee: 'enabled' });
  });

  it('returns { success: true } for a non-record result', async () => {
    const { step } = makeStep({ execute: vi.fn(async () => 'plain string') });
    const result = await step.execute(ctxWith({ command: 'reliable_boot' }));
    expect(result).toEqual({ success: true });
  });
});

describe('RedfishCommandStep.execute error re-wrapping', () => {
  it('re-wraps an inner Error as "Redfish command \'<cmd>\' failed: <detail>"', async () => {
    const { step, logger } = makeStep({
      execute: vi.fn(async () => {
        throw new Error('BMC unreachable');
      }),
    });
    await expect(step.execute(ctxWith({ command: 'reliable_boot' }))).rejects.toThrow(
      "Redfish command 'reliable_boot' failed: BMC unreachable",
    );
    expect(logger.error).toHaveBeenCalledWith("Redfish command 'reliable_boot' failed: BMC unreachable", {
      jobId: 'job-1',
    });
  });

  it('re-wraps a non-Error throw using its string form', async () => {
    const { step } = makeStep({
      execute: vi.fn(async () => {
        throw 'raw failure';
      }),
    });
    await expect(step.execute(ctxWith({ command: 'set_tee' }))).rejects.toThrow(
      "Redfish command 'set_tee' failed: raw failure",
    );
  });
});
