import { ContextIdFactory, ModuleRef } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { bmcCredentials, type BmcCredentials } from '../../../common/bmc.types';
import { DeviceSensorsModule } from '../device-sensors.module';
import { DeviceSensorsService } from '../device-sensors.service';
import type { DeviceVendorHints, RedfishProbeClient, ScrapePlanDeps, VendorHints } from '../device-sensors.types';
import { GpuLayout } from '../device-sensors.types';

const CREDS: BmcCredentials = bmcCredentials('10.0.0.1', 'u', 'p');

const HINTS: VendorHints = {
  baselineChassisId: '1',
  baselineUrlTrailingSlash: false,
  gpuLayout: GpuLayout.NONE,
  gpuCount: 0,
  gpuSlots: [],
  gpuChassisIds: [],
};

class FixedHints implements DeviceVendorHints {
  async get(): Promise<VendorHints> {
    return HINTS;
  }
}

const SINGLE_PROBE_PLAN: ScrapePlanDeps = {
  buildScrapePlan: () => [{ url: '/probe', extracts: [], tags: {} }],
  extractPoints: () => ({}),
  allMeasurements: [],
};

describe('DeviceSensorsService: request scope', () => {
  let moduleRef: Awaited<ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>> | null = null;

  afterEach(async () => {
    if (moduleRef !== null) {
      await moduleRef.close();
      moduleRef = null;
    }
  });

  it('resolves a fresh service instance per request context', async () => {
    moduleRef = await Test.createTestingModule({ imports: [DeviceSensorsModule] }).compile();

    const ref = moduleRef.get(ModuleRef, { strict: false });
    const ctxA = ContextIdFactory.create();
    const ctxB = ContextIdFactory.create();

    const instanceA = await ref.resolve(DeviceSensorsService, ctxA, { strict: false });
    const instanceB = await ref.resolve(DeviceSensorsService, ctxB, { strict: false });
    const instanceAAgain = await ref.resolve(DeviceSensorsService, ctxA, { strict: false });

    expect(instanceA).not.toBe(instanceB);
    expect(instanceA).toBe(instanceAAgain);
  });
});

describe('DeviceSensorsService: authRejected isolation', () => {
  it('each instance reports its own auth result under simulated concurrency', async () => {
    const releaseBad = new Deferred<void>();
    const releaseOk = new Deferred<void>();

    const badProbe = new GatedProbe(releaseBad.promise,  true);
    const okProbe = new GatedProbe(releaseOk.promise,  false);

    const badRequestService = new DeviceSensorsService(new FixedHints(), () => badProbe, SINGLE_PROBE_PLAN);
    const okRequestService = new DeviceSensorsService(new FixedHints(), () => okProbe, SINGLE_PROBE_PLAN);

    const badPromise = badRequestService.collect('bad', CREDS);
    const okPromise = okRequestService.collect('ok', CREDS);

    releaseOk.resolve();
    await okPromise;
    expect(okRequestService.authRejected).toBe(false);

    releaseBad.resolve();
    await badPromise;
    expect(badRequestService.authRejected).toBe(true);

    expect(okRequestService.authRejected).toBe(false);
  });

  it('a shared singleton leaks authRejected across concurrent collects (demonstrates pre-fix bug)', async () => {
    const releaseBad = new Deferred<void>();
    const releaseOk = new Deferred<void>();

    const badProbe = new GatedProbe(releaseBad.promise, true);
    const okProbe = new GatedProbe(releaseOk.promise, false);
    let calls = 0;
    const factory = (): RedfishProbeClient => (calls++ === 0 ? badProbe : okProbe);

    const shared = new DeviceSensorsService(new FixedHints(), factory, SINGLE_PROBE_PLAN);

    const badPromise = shared.collect('bad', CREDS);
    const okPromise = shared.collect('ok', CREDS);

    releaseBad.resolve();
    await badPromise;
    expect(shared.authRejected).toBe(true);

    releaseOk.resolve();
    await okPromise;
    expect(shared.authRejected).toBe(false);
  });
});

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T | PromiseLike<T>) => void;
  reject!: (reason?: unknown) => void;
  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

class GatedProbe implements RedfishProbeClient {
  authRejected = false;
  constructor(
    private readonly gate: Promise<void>,
    private readonly rejectsAuth: boolean,
  ) {}
  resetAuth(): void {
    this.authRejected = false;
  }
  async get(): Promise<Record<string, unknown> | null> {
    await this.gate;
    if (this.rejectsAuth) {
      this.authRejected = true;
      return null;
    }
    return {};
  }
}
