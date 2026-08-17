import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isRecord } from '@repo/utils';
import Redis from 'ioredis';
import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadRedisConfig } from '../../../../src/common/redis/redis-client';
import { createIoredisDriverFactory } from '../../../../src/common/redis/redis-client/ioredis-driver';
import { RedisEncryptor } from '../../../../src/common/redis/redis-client/redis-encryptor';
import { RedisService } from '../../../../src/common/redis/redis.service';
import { OobModule } from '../../../../src/oob/oob.module';
import { TeeConfigStep } from '../../../../src/oob/redfish/steps/tee-config.step';
import { ProvisionModule } from '../../../../src/provision/provision.module';
import { buildProvisionSaga } from '../../../../src/provision/provision.workflow';
import { ArmCustomIpxeBootStep } from '../../../../src/provision/steps/arm-custom-ipxe-boot.step';
import type { TeeVerificationResult } from '../../../../src/redfish/vendor/base/tee';
import type { SagaContext, SagaStepExecutor } from '../../../../src/saga-framework/saga.types';
import {
  clearActiveZoneCryptoSnapshot,
  setActiveZoneCryptoSnapshot,
  zoneCryptoFromCacheBlob,
} from '../../../../src/zone-crypto/zone-crypto.service';
import { BmcStub } from './bmc-stub';

const ZONE = '00000000-0000-0000-0000-111111111111';
const AT_REST_KEY = 'I1GOxiD9hSt9QvHUdylUSXKW/WHM6PF2dUCovWeSTXg=';
const LIVE_DEVICE = '00000000-0000-0000-0000-000000000001';
const STAMP = Date.now();
const DEVICE_ID = `2455bra0-0000-4000-8000-${String(STAMP).slice(-12)}`;
const JOB_ID = `sim2455-blast-${STAMP}`;
const EVIDENCE = `/tmp/sim2455-blastradius-evidence-${STAMP}.txt`;
const CUSTOMER_URL = 'https://customer.example.com/tee/boot.ipxe';
const ARMED_KEY = `${ZONE}:device:${DEVICE_ID}:config:ipxe_url`;

interface TeeOpsLike {
  enableTee(deviceId: string, bmcIp: string, username: string, password: string, jobId: string): Promise<boolean>;
  disableTee(deviceId: string, bmcIp: string, username: string, password: string, jobId: string): Promise<unknown>;
  verifyTee(
    deviceId: string,
    bmcIp: string,
    username: string,
    password: string,
    jobId: string,
  ): Promise<TeeVerificationResult>;
}

function isTeeOps(value: unknown): value is TeeOpsLike {
  return (
    isRecord(value) &&
    typeof value.enableTee === 'function' &&
    typeof value.disableTee === 'function' &&
    typeof value.verifyTee === 'function'
  );
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
  info: async (message: string) => void logLines.push(`INFO ${message}`),
  warning: async (message: string) => void logLines.push(`WARN ${message}`),
  error: async (message: string) => void logLines.push(`ERROR ${message}`),
};

async function note(text: string): Promise<void> {
  await appendFile(EVIDENCE, `${text}\n`);
}

const stub = new BmcStub();
let sealedBmcSecret: unknown;
let productionOps: TeeOpsLike;
let admin: Redis;
let redisService: RedisService;

function ctx(payload: Record<string, unknown>, stepName = 'tee_config'): SagaContext {
  return {
    planId: `sim2455-blast-${STAMP}`,
    stepName,
    deviceId: DEVICE_ID,
    payload: { bmc_ip: '127.0.0.1', secrets: { bmc: sealedBmcSecret }, ...payload },
    jobId: JOB_ID,
    attempt: 1,
    metadata: {},
    stepResults: {},
  };
}

function countingOps(counts: { enable: number; verify: number }, overrides: Partial<TeeOpsLike> = {}): TeeOpsLike {
  return {
    enableTee: async (...args) => {
      counts.enable += 1;
      return productionOps.enableTee(...args);
    },
    disableTee: (...args) => productionOps.disableTee(...args),
    verifyTee: async (...args) => {
      counts.verify += 1;
      return (overrides.verifyTee ?? productionOps.verifyTee)(...args);
    },
  };
}

beforeAll(async () => {
  const port = await stub.start();
  process.env.LOCAL_SIMULATION_ENABLED = 'true';
  process.env.SIM_REDFISH_PORT = String(port);
  process.env.BROKKR_ZONE_ID = ZONE;
  process.env.BRIDGE_AT_REST_KEY = AT_REST_KEY;

  admin = new Redis('redis://127.0.0.1:6379');
  const raw = await admin.getBuffer(`${ZONE}:zone_crypto`);
  if (raw === null) throw new Error('no live zone_crypto blob');
  const blob = Buffer.from(new RedisEncryptor(AT_REST_KEY).decrypt(raw.toString('utf8')), 'utf8');
  setActiveZoneCryptoSnapshot(zoneCryptoFromCacheBlob(blob));

  const secretRaw = await admin.get(`${ZONE}:device:${LIVE_DEVICE}:secrets:bmc:user`);
  if (secretRaw === null) throw new Error('no live sealed BMC secret');
  const envelope: unknown = JSON.parse(secretRaw);
  if (!isRecord(envelope) || !isRecord(envelope.value)) throw new Error('unexpected sealed secret envelope');
  sealedBmcSecret = envelope.value;

  redisService = new RedisService(
    loadRedisConfig(process.env),
    createIoredisDriverFactory(loadRedisConfig(process.env)),
  );
  await redisService.requireConnection();

  const providers: unknown = Reflect.getMetadata('providers', OobModule);
  if (!Array.isArray(providers)) throw new Error('OobModule providers metadata missing');
  const entry = providers.find((item) => isProviderEntry(item) && item.provide === TeeConfigStep);
  if (!isProviderEntry(entry) || entry.useFactory === undefined) throw new Error('no TeeConfigStep factory');
  const created = entry.useFactory(recordingLogger);
  if (!(created instanceof TeeConfigStep)) throw new Error('factory did not build a TeeConfigStep');
  const ops = { ...created }['redfish'];
  if (!isTeeOps(ops)) throw new Error('production TeeConfigStep has no wired redfish TEE ops');
  productionOps = ops;

  await note(`[SETUP] stub BMC 127.0.0.1:${port}; live zone_crypto + sealed BMC secret from ${ZONE}`);
});

afterAll(async () => {
  clearActiveZoneCryptoSnapshot();
  if (admin) {
    await admin.del(ARMED_KEY);
    await admin.quit();
  }
  await stub.stop();
  if (redisService) {
    await redisService.onApplicationShutdown();
  }
});

beforeEach(async () => {
  stub.mode = 'supermicro';
  stub.sticky = false;
  stub.reset(stub.teeNonCompliantAttributes());
  logLines.length = 0;
  await admin.del(ARMED_KEY);
});

describe('blast radius of a transient redfish error during tee verification', () => {
  it('a transient BMC error is reported as checked:false, indistinguishable from unmodeled hardware', async () => {
    stub.mode = 'malformed';

    const errored = await productionOps.verifyTee(DEVICE_ID, '127.0.0.1', 'sim', 'sim', JOB_ID);

    stub.mode = 'unmodeled';
    stub.reset({});
    const unmodeled = await productionOps.verifyTee(DEVICE_ID, '127.0.0.1', 'sim', 'sim', JOB_ID);

    await note(
      `[BLAST CONFLATION] transientRedfishError=${JSON.stringify(errored)} ` +
        `genuinelyUnmodeledHardware=${JSON.stringify(unmodeled)}`,
    );
    expect(errored.checked).toBe(false);
    expect(unmodeled.checked).toBe(false);
    expect(errored.checked).toBe(unmodeled.checked);
  });

  it('the ipxe-custom-tee step skips all retries and hands off a TEE-unapplied device on a transient BMC error', async () => {
    const counts = { enable: 0, verify: 0 };
    const step = new TeeConfigStep(
      countingOps(counts, {
        verifyTee: async (...args) => {
          stub.mode = 'malformed';
          const result = await productionOps.verifyTee(...args);
          stub.mode = 'supermicro';
          return result;
        },
      }),
      recordingLogger,
    );

    const result = await step.execute(
      ctx({ platform: { slug: 'ipxe-custom-tee', variant: 'tee' }, tee_requested: true, tee_enabled: false }),
    );

    const biosAfter = { ...stub.attributes };
    const armed = await new ArmCustomIpxeBootStep(redisService).execute(
      ctx(
        { platform: { slug: 'ipxe-custom-tee' }, lifecycle_data: { ipxe_url: CUSTOMER_URL } },
        'arm_custom_ipxe_boot',
      ),
    );
    const storedUrl = await admin.get(ARMED_KEY);

    await note(
      `[BLAST NO-RETRY] step=${JSON.stringify(result)} counts=${JSON.stringify(counts)} ` +
        `logs=${JSON.stringify(logLines)}\n` +
        `[BLAST TEE-NOT-APPLIED] biosAfterEnable=${JSON.stringify(biosAfter)}\n` +
        `[BLAST HANDOFF] arm=${JSON.stringify(armed)} liveRedis ${ARMED_KEY}=${String(storedUrl)}`,
    );

    expect(counts.verify).toBe(1);
    expect(counts.enable).toBe(1);
    expect(logLines).toContain('WARN TEE verification is not available for this hardware');
    expect(logLines.some((line) => line.startsWith('WARN TEE verification failed on attempt'))).toBe(false);
    expect(result).toEqual({ action: 'enabled', success: true });
    expect(biosAfter['TrustDomainExtension_TDX_']).toBe('Disabled');
    expect(armed).toEqual({ armed: true });
    expect(storedUrl).toBe(CUSTOMER_URL);
  });

  it('the same transient error reported as checked:true retries three times and then fails the step', async () => {
    const counts = { enable: 0, verify: 0 };
    const step = new TeeConfigStep(
      countingOps(counts, {
        verifyTee: () => Promise.resolve({ ok: false, checked: true, missing: [] }),
      }),
      recordingLogger,
    );

    await expect(
      step.execute(
        ctx({ platform: { slug: 'ipxe-custom-tee', variant: 'tee' }, tee_requested: true, tee_enabled: false }),
      ),
    ).rejects.toThrow(/TEE verification failed after three attempts/);

    await note(`[BLAST CONTROL checked:true] counts=${JSON.stringify(counts)} logs=${JSON.stringify(logLines)}`);
    expect(counts.verify).toBe(3);
    expect(counts.enable).toBe(3);
  });
});

describe('arm_custom_ipxe_boot production wiring and ordering', () => {
  it('the production ProvisionModule provides and exports the new step', () => {
    const providers: unknown = Reflect.getMetadata('providers', ProvisionModule);
    const exports: unknown = Reflect.getMetadata('exports', ProvisionModule);
    if (!Array.isArray(providers)) throw new Error('ProvisionModule providers metadata missing');
    const entry = providers.find((item) => isProviderEntry(item) && item.provide === ArmCustomIpxeBootStep);
    if (!isProviderEntry(entry) || entry.useFactory === undefined) throw new Error('no ArmCustomIpxeBootStep factory');
    const built = entry.useFactory(redisService);

    expect(built).toBeInstanceOf(ArmCustomIpxeBootStep);
    expect(Array.isArray(exports) && exports.includes(ArmCustomIpxeBootStep)).toBe(true);
  });

  it('the production workflow places arm_custom_ipxe_boot after deploy_os and before power_off', async () => {
    const stubStep: SagaStepExecutor = { execute: () => Promise.resolve({}) };
    const saga = buildProvisionSaga({
      resolveDeployTarget: stubStep,
      ipmiValidation: stubStep,
      powerOn: stubStep,
      brokkrLiveCheck: stubStep,
      collectHardware: stubStep,
      teeConfig: stubStep,
      wipeDisks: stubStep,
      prepareStorage: stubStep,
      deployOs: stubStep,
      armCustomIpxeBoot: new ArmCustomIpxeBootStep(redisService),
      ensureSolEnabled: stubStep,
      solActivation: stubStep,
      provisionComplete: stubStep,
      powerOff: stubStep,
      verifyPowerOff: stubStep,
      setBootDevice: stubStep,
      pcPowerOn: stubStep,
      pcVerifyPowerOn: stubStep,
      finalizeProvision: stubStep,
    });
    const names = saga.steps.map((step) => step.name);
    const compiled = await readFile(join(process.cwd(), 'dist', 'provision', 'provision.workflow.js'), 'utf8');

    await note(
      `[AC STEP-ORDER] ...${JSON.stringify(names.slice(names.indexOf('deploy_os'), names.indexOf('power_off') + 1))} ` +
        `liveDistHasStep=${String(compiled.includes("name: 'arm_custom_ipxe_boot'"))}`,
    );

    expect(names.indexOf('arm_custom_ipxe_boot')).toBe(names.indexOf('deploy_os') + 1);
    expect(names.indexOf('power_off')).toBe(names.indexOf('arm_custom_ipxe_boot') + 1);
    expect(compiled).toContain("name: 'arm_custom_ipxe_boot'");
  });
});
