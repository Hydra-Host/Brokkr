import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RedisService } from '../../common/redis/redis.service';
import { allSpecs, resetForTests } from '../../crons/cron-registry';
import { LeaderElectionModule } from '../../leader-election/leader-election.module';
import type { InterfaceEnumerator, LeaderCache, VersionInfo } from '../../leader-election/leader-election.service';
import { LeaderElectionService } from '../../leader-election/leader-election.service';
import { ContextLogger } from '../../logger/logger.service';
import { VrrpReconcilerService } from '../vrrp-reconciler.service';
import { VrrpModule } from '../vrrp.module';

const LEADER_CACHE_TOKEN = Symbol('LEADER_CACHE_TOKEN');
const INTERFACE_ENUMERATOR_TOKEN = Symbol('INTERFACE_ENUMERATOR_TOKEN');

const fakeCache: LeaderCache = {
  setNx: async () => false,
  renewIfOwner: async () => false,
  deleteIfOwner: async () => false,
  get: async () => null,
  hset: async () => 0,
  hgetall: async () => ({}),
  delete: async () => 0,
  scan: async () => [],
};

const fakeInterfaces: InterfaceEnumerator = {
  enumerate: async () => [],
};

const fakeVersion = (): VersionInfo => ({
  brokkrWorkerVersion: 'test',
  brokkrLiveVersion: 'test',
});

const fakeRedisService = {
  scan: async () => [],
  get: async () => null,
  delete: async () => 0,
} as unknown as RedisService;

@Global()
@Module({
  providers: [
    { provide: LEADER_CACHE_TOKEN, useValue: fakeCache },
    { provide: INTERFACE_ENUMERATOR_TOKEN, useValue: fakeInterfaces },
    { provide: ContextLogger, useValue: new ContextLogger() },
    { provide: RedisService, useValue: fakeRedisService },
  ],
  exports: [LEADER_CACHE_TOKEN, INTERFACE_ENUMERATOR_TOKEN, ContextLogger, RedisService],
})
class FakeDepsModule {}

function buildTestingModule() {
  return Test.createTestingModule({
    imports: [
      FakeDepsModule,
      LeaderElectionModule.forRoot({
        cacheToken: LEADER_CACHE_TOKEN,
        interfacesToken: INTERFACE_ENUMERATOR_TOKEN,
        versionInfo: fakeVersion,
      }),
      VrrpModule.forRoot(),
    ],
  }).compile();
}

describe('VrrpModule cron registration', () => {
  beforeEach(() => resetForTests());
  afterEach(() => {
    resetForTests();
    vi.restoreAllMocks();
  });

  it('registers vrrp_reconcile on onModuleInit', async () => {
    const moduleRef = await buildTestingModule();
    await moduleRef.init();

    const names = allSpecs().map((s) => s.name);
    expect(names).toContain('vrrp_reconcile');

    await moduleRef.close();
  });

  it('vrrp_reconcile spec carries the coarse whole-tick watchdog timeout and the leader-heartbeat interval', async () => {
    const moduleRef = await buildTestingModule();
    await moduleRef.init();

    const spec = allSpecs().find((s) => s.name === 'vrrp_reconcile');
    expect(spec).toBeDefined();
    expect(spec!.intervalMs).toBe(10_000);
    expect(spec!.timeoutMs).toBe(60_000);

    await moduleRef.close();
  });

  it('registers vrrp_reconcile unconditionally, with no enabledWhen gate', async () => {
    const moduleRef = await buildTestingModule();
    await moduleRef.init();

    const spec = allSpecs().find((s) => s.name === 'vrrp_reconcile');
    expect(spec).toBeDefined();
    expect(spec!.enabledWhen).toBeUndefined();

    await moduleRef.close();
  });
});

describe('VrrpModule shutdown ordering', () => {
  beforeEach(() => resetForTests());
  afterEach(() => {
    resetForTests();
    vi.restoreAllMocks();
  });

  it('detaches VRRP VIPs before releasing leadership on module shutdown', async () => {
    const detachSpy = vi.spyOn(VrrpReconcilerService.prototype, 'detachAll');
    const stopSpy = vi.spyOn(LeaderElectionService.prototype, 'stop');

    const moduleRef = await buildTestingModule();
    await moduleRef.init();

    await moduleRef.close();

    expect(detachSpy).toHaveBeenCalledTimes(1);
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(detachSpy.mock.invocationCallOrder[0]).toBeLessThan(stopSpy.mock.invocationCallOrder[0]);
  });
});
