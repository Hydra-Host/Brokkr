import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RedisService } from '../../common/redis/redis.service';
import { allSpecs, resetForTests as resetCronRegistry } from '../../crons/cron-registry';
import { LeaderElectionModule } from '../../leader-election/leader-election.module';
import type { LeaderCache } from '../../leader-election/leader-election.service';
import { OsNetworkInterfaceEnumerator } from '../../leader-election/local-interface-enumerator';
import { ContextLogger } from '../../logger/logger.service';
import {
  LEADER_CACHE,
  LEADER_INTERFACE_ENUMERATOR,
  buildLeaderElectionModuleOptions,
  buildLeaderElectionVersionInfo,
  leaderCacheProvider,
  leaderInterfaceEnumeratorProvider,
} from '../leader-election-factory';

vi.hoisted(() => {
  vi.stubEnv('BRIDGE_API_VERSION', '9.9.9');
});

afterAll(() => {
  vi.unstubAllEnvs();
});

class FakeRedisService {
  setNx = async (): Promise<boolean> => true;
  setNxOwned = async (): Promise<boolean> => true;
  renewIfOwner = async (): Promise<boolean> => true;
  deleteIfOwner = async (): Promise<boolean> => true;
  get = async (): Promise<string | null> => null;
  hset = async (): Promise<number> => 1;
  hgetall = async (): Promise<Record<string, string>> => ({});
  delete = async (): Promise<number> => 1;
  keys = async (): Promise<string[]> => [];
}

@Global()
@Module({
  providers: [
    { provide: RedisService, useClass: FakeRedisService },
    { provide: ContextLogger, useValue: new ContextLogger() },
  ],
  exports: [RedisService, ContextLogger],
})
class FakeRedisModule {}

describe('LeaderElectionModule composition', () => {
  beforeEach(() => resetCronRegistry());
  afterEach(() => resetCronRegistry());

  it('buildLeaderElectionModuleOptions returns the LEADER_CACHE / LEADER_INTERFACE_ENUMERATOR tokens', () => {
    const opts = buildLeaderElectionModuleOptions({});
    expect(opts.cacheToken).toBe(LEADER_CACHE);
    expect(opts.interfacesToken).toBe(LEADER_INTERFACE_ENUMERATOR);
    const versions = opts.versionInfo();
    expect(versions.brokkrWorkerVersion).toBe('9.9.9');
    expect(versions.brokkrLiveVersion).toBe('latest-prod');
  });

  it('buildLeaderElectionVersionInfo publishes the bridge version from BRIDGE_API_VERSION, not BRIDGE_VERSION', () => {
    const versionInfo = buildLeaderElectionVersionInfo({
      BRIDGE_VERSION: '0.0.0',
      BROKKR_LIVE_VERSION: '2.0.0',
    });
    expect(versionInfo()).toEqual({
      brokkrWorkerVersion: '9.9.9',
      brokkrLiveVersion: '2.0.0',
    });
  });

  it('leaderCacheProvider adapts RedisService into the LeaderCache surface', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [{ provide: RedisService, useClass: FakeRedisService }, leaderCacheProvider],
    }).compile();
    const cache = moduleRef.get<LeaderCache>(LEADER_CACHE);
    await expect(cache.setNx('k', 'v', { ttlSeconds: 30 })).resolves.toBe(true);
    await expect(cache.renewIfOwner('k', 'v', { ttlSeconds: 30 })).resolves.toBe(true);
    await expect(cache.hset('k', { a: 'b' }, { ttlSeconds: 30 })).resolves.toBe(1);
    await moduleRef.close();
  });

  it('forwards opts.ttlSeconds as the positional ttl and preserves key/value ordering', async () => {
    const setNxOwned = vi.fn(async () => true);
    const renewIfOwner = vi.fn(async () => true);
    const hset = vi.fn(async () => 1);

    class CapturingRedisService {
      setNxOwned = setNxOwned;
      renewIfOwner = renewIfOwner;
      hset = hset;
    }

    const moduleRef = await Test.createTestingModule({
      providers: [{ provide: RedisService, useClass: CapturingRedisService }, leaderCacheProvider],
    }).compile();
    const cache = moduleRef.get<LeaderCache>(LEADER_CACHE);

    await cache.setNx('leader-key', 'instance-id', { ttlSeconds: 30 });
    await cache.renewIfOwner('leader-key', 'instance-id', { ttlSeconds: 30 });
    await cache.hset('registry-key', { is_leader: 'True' }, { ttlSeconds: 120 });

    expect(setNxOwned).toHaveBeenCalledWith('leader-key', 'instance-id', 30);
    expect(renewIfOwner).toHaveBeenCalledWith('leader-key', 'instance-id', 30);
    expect(hset).toHaveBeenCalledWith('registry-key', { is_leader: 'True' }, 120);
    await moduleRef.close();
  });

  it('leaderInterfaceEnumeratorProvider always provides the real-host-NIC enumerator', () => {
    const factory = leaderInterfaceEnumeratorProvider as { useFactory: () => unknown };
    expect(factory.useFactory()).toBeInstanceOf(OsNetworkInterfaceEnumerator);
  });

  it('AppModule-style composition registers leader_heartbeat at boot', async () => {
    @Global()
    @Module({
      providers: [leaderCacheProvider, leaderInterfaceEnumeratorProvider],
      exports: [LEADER_CACHE, LEADER_INTERFACE_ENUMERATOR],
    })
    class LeaderElectionCompositionModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        FakeRedisModule,
        LeaderElectionCompositionModule,
        LeaderElectionModule.forRoot(buildLeaderElectionModuleOptions({})),
      ],
    }).compile();
    await moduleRef.init();

    const names = allSpecs().map((s) => s.name);
    expect(names).toContain('leader_heartbeat');

    await moduleRef.close();
  });
});
