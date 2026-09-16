import { isRecord } from '@repo/utils';
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deviceIpxeUrl } from '../../../../src/common/redis/redis-keys';
import { disableTee, enableTee, verifyTee } from '../../../../src/lifecycle-deploy/redfish-operations';
import { TeeConfigStep } from '../../../../src/oob/redfish/steps/tee-config.step';
import {
  clearZoneCrypto,
  installZoneCrypto,
  sealedCredPayload,
} from '../../../../src/oob/steps/__test__/sealed-bmc.testutil';
import { ProvisionModule } from '../../../../src/provision/provision.module';
import { buildProvisionSaga } from '../../../../src/provision/provision.workflow';
import { ArmCustomIpxeBootStep } from '../../../../src/provision/steps/arm-custom-ipxe-boot.step';
import { SUPERMICRO_BIOS_PATH, SUPERMICRO_RESET_PATH } from '../../../../src/redfish/__test__/supermicro-tee.testutil';
import type { TeeVerificationResult } from '../../../../src/redfish/vendor/base/tee';
import type { SagaContext, SagaStepExecutor } from '../../../../src/saga-framework/saga.types';
import { BmcStub } from './bmc-stub';

const DEVICE_ID = '00000000-0000-0000-0000-0000000000bb';
const JOB_ID = 'tee-blast-radius';
const CUSTOMER_URL = 'https://customer.example.com/tee/boot.ipxe';
const TDX_KEY = 'TrustDomainExtensions_TDX_';
const CREDS = sealedCredPayload({ bmcIp: '127.0.0.1', user: 'sim', pass: 'sim' });
const CUSTOM_TEE_ENABLE = {
  platform: { slug: 'ipxe-custom-tee', variant: 'tee' },
  tee_requested: true,
  tee_enabled: false,
};
const STANDARD_TEE_ENABLE = {
  platform: { slug: 'ubuntu-24.04' },
  tee_requested: true,
  tee_enabled: false,
};

interface TeeOpsLike {
  enableTee(deviceId: string, bmcIp: string, username: string, password: string, jobId: string): Promise<boolean>;
  disableTee(deviceId: string, bmcIp: string, username: string, password: string, jobId: string): Promise<boolean>;
  verifyTee(
    deviceId: string,
    bmcIp: string,
    username: string,
    password: string,
    jobId: string,
  ): Promise<TeeVerificationResult>;
}

interface ProviderEntry {
  provide?: unknown;
  useFactory?: (...args: unknown[]) => unknown;
}

function isProviderEntry(value: unknown): value is ProviderEntry {
  return isRecord(value) && 'provide' in value && typeof value.useFactory === 'function';
}

const logLines: string[] = [];
const recordingLogger = {
  info: (message: string) => {
    logLines.push(`INFO ${message}`);
    return Promise.resolve();
  },
  warning: (message: string) => {
    logLines.push(`WARN ${message}`);
    return Promise.resolve();
  },
};

const stub = new BmcStub();
const deps = { createRedfishService: stub.createRedfishService };
const redfishOps: TeeOpsLike = {
  enableTee: (deviceId, bmcIp, username, password, jobId) =>
    enableTee(deviceId, bmcIp, username, password, jobId, deps),
  disableTee: (deviceId, bmcIp, username, password, jobId) =>
    disableTee(deviceId, bmcIp, username, password, jobId, deps),
  verifyTee: (deviceId, bmcIp, username, password, jobId) =>
    verifyTee(deviceId, bmcIp, username, password, jobId, deps),
};

const armedUrls = new Map<string, string>();
const ipxeCache = {
  set: (key: string, value: string) => {
    armedUrls.set(key, value);
    return Promise.resolve(armedUrls.size);
  },
};

function ctx(payload: Record<string, unknown>, stepName = 'tee_config'): SagaContext {
  return {
    planId: 'tee-blast-radius-plan',
    stepName,
    deviceId: DEVICE_ID,
    payload: { ...CREDS, ...payload },
    jobId: JOB_ID,
    attempt: 1,
    metadata: {},
    stepResults: {},
  };
}

function countingOps(counts: { enable: number; verify: number }, overrides: Partial<TeeOpsLike> = {}): TeeOpsLike {
  return {
    enableTee: (...args) => {
      counts.enable += 1;
      return redfishOps.enableTee(...args);
    },
    disableTee: (...args) => redfishOps.disableTee(...args),
    verifyTee: (...args) => {
      counts.verify += 1;
      return (overrides.verifyTee ?? redfishOps.verifyTee)(...args);
    },
  };
}

beforeEach(() => {
  installZoneCrypto();
  stub.mode = 'supermicro';
  stub.reset();
  logLines.length = 0;
  armedUrls.clear();
});

afterEach(() => clearZoneCrypto());

describe('blast radius of a redfish readback failure during tee verification', () => {
  it('reports an unreachable bmc and unmodeled hardware with different reasons', async () => {
    stub.mode = 'malformed';
    const unreachable = await redfishOps.verifyTee(DEVICE_ID, '127.0.0.1', 'sim', 'sim', JOB_ID);

    stub.mode = 'unmodeled';
    const unmodeled = await redfishOps.verifyTee(DEVICE_ID, '127.0.0.1', 'sim', 'sim', JOB_ID);

    expect(unreachable).toEqual({ ok: false, checked: false, missing: [], reason: 'bmc-unreachable' });
    expect(unmodeled).toEqual({ ok: true, checked: false, missing: [], reason: 'unmodeled' });
    expect(unreachable.reason).not.toBe(unmodeled.reason);
  });

  it('enables tee on the plural tdx key, verifies it, and only then hands the device to the customer ipxe', async () => {
    const counts = { enable: 0, verify: 0 };
    const step = new TeeConfigStep(countingOps(counts), recordingLogger);

    const result = await step.execute(ctx(CUSTOM_TEE_ENABLE));
    const armed = await new ArmCustomIpxeBootStep(ipxeCache).execute(
      ctx(
        { platform: { slug: 'ipxe-custom-tee' }, lifecycle_data: { ipxe_url: CUSTOMER_URL } },
        'arm_custom_ipxe_boot',
      ),
    );

    expect(result).toEqual({ action: 'enabled', success: true });
    expect(counts).toEqual({ enable: 1, verify: 1 });
    expect(stub.attributes[TDX_KEY]).toBe('Enabled');
    expect(stub.patchedKeys()).toContain(TDX_KEY);
    expect(stub.patchedKeys()).not.toContain('TrustDomainExtension_TDX_');
    expect(stub.resets).toBeGreaterThan(0);
    expect(logLines).toContain('INFO TEE verification succeeded on attempt 1');
    expect(armed).toEqual({ armed: true });
    expect(armedUrls.get(deviceIpxeUrl(DEVICE_ID))).toBe(CUSTOMER_URL);
  });

  it('retries the readback three times on an unreachable bmc without re-enabling, then fails the step', async () => {
    const counts = { enable: 0, verify: 0 };
    const step = new TeeConfigStep(
      countingOps(counts, {
        verifyTee: (...args) => {
          stub.mode = 'malformed';
          return redfishOps.verifyTee(...args);
        },
      }),
      recordingLogger,
    );

    await expect(step.execute(ctx(CUSTOM_TEE_ENABLE))).rejects.toThrow(/TEE verification failed after three attempts/);

    expect(counts).toEqual({ enable: 1, verify: 3 });
    expect(stub.attributes[TDX_KEY]).toBe('Enabled');
    expect(
      logLines.filter((line) => line.startsWith('WARN TEE verification could not read the BIOS on attempt')),
    ).toHaveLength(3);
    expect(logLines.some((line) => line.startsWith('WARN TEE verification failed on attempt'))).toBe(false);
    expect(logLines).not.toContain('WARN TEE verification is not available for this hardware');
    expect(armedUrls.size).toBe(0);
  });

  it('verifies a standard platform enable and returns the plain enabled result with no ipxe handoff', async () => {
    const counts = { enable: 0, verify: 0 };
    let requestsBeforeVerify = -1;
    const step = new TeeConfigStep(
      countingOps(counts, {
        verifyTee: (...args) => {
          requestsBeforeVerify = stub.requests.length;
          return redfishOps.verifyTee(...args);
        },
      }),
      recordingLogger,
    );

    const result = await step.execute(ctx(STANDARD_TEE_ENABLE));
    const armed = await new ArmCustomIpxeBootStep(ipxeCache).execute(
      ctx(
        { platform: STANDARD_TEE_ENABLE.platform, lifecycle_data: { ipxe_url: CUSTOMER_URL } },
        'arm_custom_ipxe_boot',
      ),
    );
    const lastReset = stub.requests
      .map((request) => request.method === 'POST' && request.path === SUPERMICRO_RESET_PATH)
      .lastIndexOf(true);
    const readbacks = stub.requests
      .slice(requestsBeforeVerify)
      .filter((request) => request.method === 'GET' && request.path === SUPERMICRO_BIOS_PATH);

    expect(result).toEqual({ action: 'enabled', success: true });
    expect(counts).toEqual({ enable: 1, verify: 1 });
    expect(stub.attributes[TDX_KEY]).toBe('Enabled');
    expect(lastReset).toBeGreaterThan(-1);
    expect(requestsBeforeVerify).toBeGreaterThan(lastReset);
    expect(readbacks).not.toHaveLength(0);
    expect(logLines).toContain('INFO TEE verification succeeded on attempt 1');
    expect(armed).toEqual({ skipped: true, reason: 'platform is not ipxe-custom-tee' });
    expect(armedUrls.size).toBe(0);
  });

  it('fails a standard platform enable before verifying when unmodeled hardware cannot set tee', async () => {
    stub.mode = 'unmodeled';
    const counts = { enable: 0, verify: 0 };
    const step = new TeeConfigStep(countingOps(counts), recordingLogger);

    await expect(step.execute(ctx(STANDARD_TEE_ENABLE))).rejects.toThrow(/enableTee failed: TEE was not enabled/);

    expect(counts).toEqual({ enable: 1, verify: 0 });
    expect(logLines).not.toContain('WARN TEE verification is not available for this hardware');
  });

  it('keeps a standard platform non-blocking when tee is already enabled on unmodeled hardware', async () => {
    stub.mode = 'unmodeled';
    const counts = { enable: 0, verify: 0 };
    const step = new TeeConfigStep(countingOps(counts), recordingLogger);

    const result = await step.execute(ctx({ ...STANDARD_TEE_ENABLE, tee_enabled: true }));

    expect(result).toEqual({ skipped: true, reason: 'current=true, requested=true' });
    expect(counts).toEqual({ enable: 0, verify: 1 });
    expect(logLines).toContain('WARN TEE verification is not available for this hardware');
  });
});

describe('arm_custom_ipxe_boot production wiring and ordering', () => {
  it('the production ProvisionModule provides and exports the step', () => {
    const providers: unknown = Reflect.getMetadata('providers', ProvisionModule);
    const exports: unknown = Reflect.getMetadata('exports', ProvisionModule);
    if (!Array.isArray(providers)) throw new Error('ProvisionModule providers metadata missing');
    const entry = providers.find((item) => isProviderEntry(item) && item.provide === ArmCustomIpxeBootStep);
    if (!isProviderEntry(entry) || entry.useFactory === undefined) throw new Error('no ArmCustomIpxeBootStep factory');
    const built = entry.useFactory(ipxeCache);

    expect(built).toBeInstanceOf(ArmCustomIpxeBootStep);
    expect(Array.isArray(exports) && exports.includes(ArmCustomIpxeBootStep)).toBe(true);
  });

  it('the production workflow places arm_custom_ipxe_boot after deploy_os and before power_off', () => {
    const stubStep: SagaStepExecutor = { execute: () => Promise.resolve({}) };
    const saga = buildProvisionSaga({
      brokkrLiveCheck: stubStep,
      pcPowerOff: stubStep,
      pcVerifyPowerOff: stubStep,
      pcSetBootDevice: stubStep,
      pcVerifyBootDevice: stubStep,
      pcPowerOn: stubStep,
      pcVerifyPowerOn: stubStep,
      waitForBrokkrLive: stubStep,
      disableOsBoot: stubStep,
      teeConfig: stubStep,
      waitForAgentSession: stubStep,
      resolveDeployTarget: stubStep,
      wipeDisks: stubStep,
      prepareStorage: stubStep,
      deployOs: stubStep,
      armCustomIpxeBoot: new ArmCustomIpxeBootStep(ipxeCache),
      ensureSolEnabled: stubStep,
      solActivation: stubStep,
      provisionComplete: stubStep,
    });
    const names = saga.steps.map((step) => step.name);

    expect(names.indexOf('arm_custom_ipxe_boot')).toBe(names.indexOf('deploy_os') + 1);
    expect(names.indexOf('power_off')).toBe(names.indexOf('arm_custom_ipxe_boot') + 1);
  });
});
