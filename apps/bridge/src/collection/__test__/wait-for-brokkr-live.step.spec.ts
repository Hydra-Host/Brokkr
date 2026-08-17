import { type DeviceSecretAadFields, derivePublicKey, deviceSecretAad, seal } from '@repo/crypto';
import { Buffer } from 'node:buffer';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BrokkrLiveDiagnosticCheck } from '../../brokkr-live/brokkr-live-readiness.service';
import type {
  PowerManagementServiceFactoryLike,
  PowerManagementServiceLike,
} from '../../oob/steps/power-management-service.types';
import type { SagaContext } from '../../saga-framework/saga.types';
import {
  clearActiveZoneCryptoSnapshot,
  setActiveZoneCryptoSnapshot,
} from '../../zone-crypto/zone-crypto.service';
import { WaitForBrokkrLiveStep } from '../steps/wait-for-brokkr-live.step';

function genPriv() {
  return Buffer.from(generateKeyPairSync('x25519').privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32));
}

const hubPriv = genPriv();
const hubPub = derivePublicKey(hubPriv);
const zonePriv = genPriv();
const zonePub = derivePublicKey(zonePriv);

const AAD_FIELDS: DeviceSecretAadFields = {
  zoneId: '00000000-0000-0000-0000-000000000001',
  zoneKeyId: '00000000-0000-0000-0000-0000000000e1',
  deviceId: '00000000-0000-0000-0000-0000000000aa',
  purpose: 'BMC',
  kind: 'USER',
  keyGen: 1,
};

function sealedBmcPayload(plaintext = { user: 'admin', pass: 's3cret' }) {
  const sealed = seal(hubPriv, zonePub, Buffer.from(JSON.stringify(plaintext), 'utf8'), deviceSecretAad(AAD_FIELDS));
  return {
    bmc_ip: '10.0.0.9',
    secrets: {
      bmc: {
        ...AAD_FIELDS,
        ephPub: sealed.ephPub.toString('base64'),
        ciphertext: sealed.ciphertext.toString('base64'),
        tag: sealed.tag.toString('base64'),
      },
    },
  };
}

type WaitOpts = { initialDelay?: number; diagnosticCheck?: BrokkrLiveDiagnosticCheck };

function makeLogger() {
  return { info: vi.fn(async () => undefined) };
}

function makeFactory(ready: boolean) {
  const waitForBrokkrLive = vi.fn(async (_deviceId: string, _opts?: WaitOpts) => ready);
  const factory = { create: vi.fn(async () => ({ waitForBrokkrLive })) };
  return { factory, waitForBrokkrLive };
}

function makePowerFactory(verifyPowerOn = vi.fn(async () => ({ verified: true }))) {
  const power: PowerManagementServiceLike = {
    validateCredentials: vi.fn(async () => ({})),
    powerOff: vi.fn(async () => ({})),
    verifyPowerOff: vi.fn(async () => ({})),
    setBootDevice: vi.fn(async () => ({})),
    verifyBootDevice: vi.fn(async () => ({})),
    powerOn: vi.fn(async () => ({})),
    verifyPowerOn,
    verifyBmcRecovery: vi.fn(async () => ({})),
  };
  const factory: PowerManagementServiceFactoryLike = {
    create: vi.fn(async () => power),
  };
  return { factory, verifyPowerOn };
}

function makeCtx(overrides: Partial<SagaContext> = {}): SagaContext {
  return {
    planId: 'plan-1',
    stepName: 'wait_for_brokkr_live',
    deviceId: 'device-1',
    payload: {},
    jobId: 'job-1',
    attempt: 1,
    metadata: {},
    stepResults: {},
    ...overrides,
  };
}

describe('WaitForBrokkrLiveStep.execute', () => {
  beforeEach(() => {
    setActiveZoneCryptoSnapshot({ zonePriv, zonePub, hubPub, enrolledAt: 1_730_000_000_000 });
  });
  afterEach(() => {
    clearActiveZoneCryptoSnapshot();
  });

  it('skips without creating a service when brokkr_live_check already reports ready', async () => {
    const { factory, waitForBrokkrLive } = makeFactory(true);
    const step = new WaitForBrokkrLiveStep(factory, makeLogger());

    const result = await step.execute(makeCtx({ stepResults: { brokkr_live_check: { ready: true } } }));

    expect(result).toEqual({ skipped: true, reason: 'Brokkr Live already running' });
    expect(factory.create).not.toHaveBeenCalled();
    expect(waitForBrokkrLive).not.toHaveBeenCalled();
  });

  it('waits (does not skip) when rewound even if brokkr_live_check is ready', async () => {
    const { factory, waitForBrokkrLive } = makeFactory(true);
    const step = new WaitForBrokkrLiveStep(factory, makeLogger());

    const result = await step.execute(
      makeCtx({ metadata: { rewound: true }, stepResults: { brokkr_live_check: { ready: true } } }),
    );

    expect(result).toEqual({ os_ready: true });
    expect(waitForBrokkrLive).toHaveBeenCalledTimes(1);
  });

  it('waits (does not skip) when deploy_os ran even if brokkr_live_check is ready', async () => {
    const { factory, waitForBrokkrLive } = makeFactory(true);
    const step = new WaitForBrokkrLiveStep(factory, makeLogger());

    const result = await step.execute(
      makeCtx({ stepResults: { deploy_os: { done: true }, brokkr_live_check: { ready: true } } }),
    );

    expect(result).toEqual({ os_ready: true });
    expect(waitForBrokkrLive).toHaveBeenCalledTimes(1);
  });

  it('returns os_ready without overriding the readiness service initial delay', async () => {
    const { factory, waitForBrokkrLive } = makeFactory(true);
    const step = new WaitForBrokkrLiveStep(factory, makeLogger());

    const result = await step.execute(makeCtx());

    expect(result).toEqual({ os_ready: true });
    expect(factory.create).toHaveBeenCalledWith('job-1');
    expect(waitForBrokkrLive).toHaveBeenCalledWith('device-1', {
      diagnosticCheck: undefined,
    });
  });

  it('passes a BMC power diagnostic when power credentials are present', async () => {
    const { factory, waitForBrokkrLive } = makeFactory(true);
    const { factory: powerFactory, verifyPowerOn } = makePowerFactory();
    const step = new WaitForBrokkrLiveStep(factory, makeLogger(), powerFactory);

    await step.execute(makeCtx({ payload: sealedBmcPayload() }));

    const options = waitForBrokkrLive.mock.calls[0]?.[1];
    expect(options?.diagnosticCheck).toEqual(expect.any(Function));
    await expect(options?.diagnosticCheck?.()).resolves.toEqual({ ok: true });
    expect(powerFactory.create).toHaveBeenCalledWith('job-1');
    expect(verifyPowerOn).toHaveBeenCalledWith(
      { bmcIp: '10.0.0.9', username: 'admin', password: 's3cret' },
      { timeout: 1, pollInterval: 1 },
    );
  });

  it('omits the diagnostic when the cred-saga payload has no sealed secret', async () => {
    const { factory, waitForBrokkrLive } = makeFactory(true);
    const { factory: powerFactory } = makePowerFactory();
    const step = new WaitForBrokkrLiveStep(factory, makeLogger(), powerFactory);

    await step.execute(makeCtx({ payload: { device_id: 'device-1' } }));

    expect(waitForBrokkrLive.mock.calls[0]?.[1]?.diagnosticCheck).toBeUndefined();
    expect(powerFactory.create).not.toHaveBeenCalled();
  });

  it('returns a failed diagnostic when BMC power verification fails', async () => {
    const { factory, waitForBrokkrLive } = makeFactory(true);
    const { factory: powerFactory } = makePowerFactory(vi.fn(async () => Promise.reject(new Error('BMC unreachable'))));
    const step = new WaitForBrokkrLiveStep(factory, makeLogger(), powerFactory);

    await step.execute(makeCtx({ payload: sealedBmcPayload() }));

    const options = waitForBrokkrLive.mock.calls[0]?.[1];
    await expect(options?.diagnosticCheck?.()).resolves.toEqual({
      ok: false,
      inconclusive: true,
      reason: 'BMC power-on verification failed: BMC unreachable',
    });
  });

  it('throws when the OS does not become ready', async () => {
    const { factory } = makeFactory(false);
    const step = new WaitForBrokkrLiveStep(factory, makeLogger());

    await expect(step.execute(makeCtx())).rejects.toThrow('Brokkr Live OS did not become ready');
  });
});
