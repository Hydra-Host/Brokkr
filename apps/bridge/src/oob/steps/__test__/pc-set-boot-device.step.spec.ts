import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SagaContext } from '../../../saga-framework/saga.types.js';
import { clearActiveZoneCryptoSnapshot, setActiveZoneCryptoSnapshot } from '../../../zone-crypto/zone-crypto.service';
import { PcSetBootDeviceStep } from '../pc-set-boot-device.step.js';
import type { PowerManagementServiceLike } from '../power-management-service.types.js';

import { ZONE_CRYPTO_SNAPSHOT, sealedBmcPayload } from './sealed-bmc.testutil';

beforeEach(() => setActiveZoneCryptoSnapshot(ZONE_CRYPTO_SNAPSHOT));
afterEach(() => clearActiveZoneCryptoSnapshot());

function ctxWith(stepResults: Record<string, unknown>): SagaContext {
  return {
    planId: 'plan-1',
    stepName: 'set_boot_device',
    deviceId: 'dev-1',
    payload: { ...sealedBmcPayload(), boot_device: 'pxe' },
    jobId: 'job-1',
    attempt: 1,
    metadata: {},
    stepResults,
  };
}

function makeStep() {
  const setBootDevice = vi.fn<PowerManagementServiceLike['setBootDevice']>(async () => ({
    device: 'pxe',
    result: 'success',
  }));
  const step = new PcSetBootDeviceStep({
    create: async () => ({
      validateCredentials: vi.fn(),
      powerOff: vi.fn(),
      verifyPowerOff: vi.fn(),
      setBootDevice,
      verifyBootDevice: vi.fn(),
      powerOn: vi.fn(),
      verifyPowerOn: vi.fn(),
      verifyBmcRecovery: vi.fn(),
    }),
  });
  return { step, setBootDevice };
}

describe('PcSetBootDeviceStep boot override persistence', () => {
  it('requests a one-time override after the custom iPXE handoff was armed', async () => {
    const { step, setBootDevice } = makeStep();

    await step.execute(ctxWith({ arm_custom_ipxe_boot: { armed: true } }));

    expect(setBootDevice.mock.calls[0]?.[2]).toEqual({ persistent: false });
  });

  it.each([
    ['a skipped arm step', { arm_custom_ipxe_boot: { skipped: true, reason: 'platform is not a custom iPXE OS' } }],
    ['an empty arm result', { arm_custom_ipxe_boot: {} }],
    ['no arm result at all', {}],
  ])('requests a persistent override with %s', async (_label, stepResults) => {
    const { step, setBootDevice } = makeStep();

    await step.execute(ctxWith(stepResults));

    expect(setBootDevice.mock.calls[0]?.[2]).toEqual({ persistent: true });
  });
});
