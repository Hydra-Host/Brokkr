
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { allSpecs, resetForTests } from '../../crons/cron-registry';
import { ContextLogger } from '../../logger/logger.service';
import { buildLeaderConfig } from '../leader-election.config';
import { LeaderElectionModule } from '../leader-election.module';
import {
  LeaderElectionService,
  getLeaderService,
  setLeaderService,
  type InterfaceEnumerator,
  type LeaderCache,
  type VersionInfo,
} from '../leader-election.service';

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

@Global()
@Module({
  providers: [
    { provide: LEADER_CACHE_TOKEN, useValue: fakeCache },
    { provide: INTERFACE_ENUMERATOR_TOKEN, useValue: fakeInterfaces },
    { provide: ContextLogger, useValue: new ContextLogger() },
  ],
  exports: [LEADER_CACHE_TOKEN, INTERFACE_ENUMERATOR_TOKEN, ContextLogger],
})
class FakeDepsModule {}

describe('LeaderElectionModule cron registration', () => {
  beforeEach(() => resetForTests());
  afterEach(() => resetForTests());

  it('registers leader_heartbeat on onModuleInit', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        FakeDepsModule,
        LeaderElectionModule.forRoot({
          cacheToken: LEADER_CACHE_TOKEN,
          interfacesToken: INTERFACE_ENUMERATOR_TOKEN,
          versionInfo: fakeVersion,
        }),
      ],
    }).compile();
    await moduleRef.init();

    const names = allSpecs().map((s) => s.name);
    expect(names).toContain('leader_heartbeat');
  });

  it('leader_heartbeat spec carries interval and timeout from LeaderConfig', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        FakeDepsModule,
        LeaderElectionModule.forRoot({
          cacheToken: LEADER_CACHE_TOKEN,
          interfacesToken: INTERFACE_ENUMERATOR_TOKEN,
          versionInfo: fakeVersion,
          config: {
            instanceId: 'test',
            leaderTtlSeconds: 30,
            leaderRenewIntervalSeconds: 7,
            leaderHeartbeatTimeoutSeconds: 11,
            registryTtlSeconds: 120,
            leaderKey: 'bridge:leader',
            registryKeyPrefix: 'bridge:instance:',
          },
        }),
      ],
    }).compile();
    await moduleRef.init();

    const spec = allSpecs().find((s) => s.name === 'leader_heartbeat');
    expect(spec).toBeDefined();
    expect(spec!.intervalMs).toBe(7000);
    expect(spec!.timeoutMs).toBe(11_000);
  });
});

describe('LeaderElectionModule bootstrap/shutdown hooks', () => {
  beforeEach(() => {
    resetForTests();
    setLeaderService(null);
  });
  afterEach(() => {
    resetForTests();
    setLeaderService(null);
  });

  function makeService(): LeaderElectionService {
    return new LeaderElectionService(
      fakeCache,
      fakeInterfaces,
      fakeVersion,
      new ContextLogger(),
      buildLeaderConfig({ BRIDGE_HOSTNAME: 'lifecycle-test' }),
    );
  }

  async function buildModule(service: LeaderElectionService) {
    return Test.createTestingModule({
      imports: [
        FakeDepsModule,
        LeaderElectionModule.forRoot({
          cacheToken: LEADER_CACHE_TOKEN,
          interfacesToken: INTERFACE_ENUMERATOR_TOKEN,
          versionInfo: fakeVersion,
        }),
      ],
    })
      .overrideProvider(LeaderElectionService)
      .useValue(service)
      .compile();
  }

  it('getLeaderService() is null before bootstrap', () => {
    expect(getLeaderService()).toBeNull();
  });

  it('awaits start() before publishing the holder, then publishes the injected instance', async () => {
    const service = makeService();
    let holderDuringStart: LeaderElectionService | null = service;
    const startSpy = vi.spyOn(service, 'start').mockImplementation(async () => {
      holderDuringStart = getLeaderService();
    });

    const moduleRef = await buildModule(service);
    await moduleRef.init();

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(holderDuringStart).toBeNull();
    expect(getLeaderService()).toBe(service);

    await moduleRef.close();
  });

  it('shutdown clears the holder even when stop() rejects', async () => {
    const service = makeService();
    vi.spyOn(service, 'start').mockResolvedValue(undefined);
    vi.spyOn(service, 'stop').mockRejectedValue(new Error('stop failed'));

    const moduleRef = await buildModule(service);
    await moduleRef.init();
    expect(getLeaderService()).toBe(service);

    await expect(moduleRef.close()).resolves.toBeUndefined();
    expect(getLeaderService()).toBeNull();
  });
});
