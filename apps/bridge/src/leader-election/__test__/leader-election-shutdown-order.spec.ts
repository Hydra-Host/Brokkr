import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RedisDriver, RedisDriverFactory, RedisDriverPipeline } from '../../common/redis/redis-client';
import { REDIS_CONFIG, REDIS_DRIVER_FACTORY, RedisService, type RedisConfig } from '../../common/redis/redis.service';
import {
  LEADER_CACHE,
  LEADER_INTERFACE_ENUMERATOR,
  leaderCacheProvider,
} from '../../composition/leader-election-factory';
import { resetForTests } from '../../crons/cron-registry';
import { ContextLogger } from '../../logger/logger.service';
import { LeaderElectionModule } from '../leader-election.module';
import type { InterfaceEnumerator, VersionInfo } from '../leader-election.service';

function instrumentedRedis(): { factory: RedisDriverFactory; events: string[]; connectCount: () => number } {
  const events: string[] = [];
  let connects = 0;

  const driver: RedisDriver = {
    ping: async () => 'PONG',
    get: async () => null,
    set: async () => 'OK',
    setex: async () => 'OK',
    setNx: async () => {
      events.push('setNx');
      return true;
    },
    del: async () => {
      events.push('del');
      return 1;
    },
    exists: async () => 0,
    rpush: async () => 0,
    xadd: async () => '1-0',
    lrange: async () => [],
    expire: async () => 1,
    hset: async () => {
      events.push('hset');
      return 1;
    },
    hget: async () => null,
    hgetall: async () => ({}),
    scanMatch: async function* () {
    },
    eval: async () => {
      events.push('eval');
      return 1;
    },
    pipeline: () => {
      const pipe: RedisDriverPipeline = {
        hset: () => pipe,
        expire: () => pipe,
        exec: async () => {
          events.push('pipeline.exec');
          return [1, 1];
        },
      };
      return pipe;
    },
    multi: () => {
      const pipe: RedisDriverPipeline = {
        hset: () => pipe,
        expire: () => pipe,
        exec: async () => {
          events.push('multi.exec');
          return [1, 1];
        },
      };
      return pipe;
    },
    close: async () => {
      events.push('close');
    },
  };

  const factory: RedisDriverFactory = async () => {
    connects += 1;
    events.push('connect');
    return driver;
  };

  return { factory, events, connectCount: () => connects };
}

const testRedisConfig = (): RedisConfig => ({
  url: '',
  host: 'localhost',
  port: 6379,
  username: '',
  password: '',
  db: 0,
  tls: false,
  tlsCaCert: '',
  prefix: 'test:',
  socketTimeout: 5,
  socketConnectTimeout: 5,
  retryOnError: false,
  maxConnections: 1,
  encryptionKey: Buffer.alloc(32).toString('base64'),
  ttls: {
    deviceNetplan: 0,
    bmcCipher: 0,
    deviceSshIp: 0,
    resolvedIp: 0,
    deviceInitrd: 0,
    bridgeInterfaces: 0,
    syncVersion: 0,
  },
});

const fakeInterfaces: InterfaceEnumerator = { enumerate: async () => [] };
const fakeVersion = (): VersionInfo => ({ brokkrWorkerVersion: 'test', brokkrLiveVersion: 'test' });

describe('leader-election shutdown order vs RedisService teardown', () => {
  beforeEach(() => resetForTests());
  afterEach(() => resetForTests());

  it('releases the leader lock on a still-open connection, then closes Redis (no reconnect)', async () => {
    const { factory, events, connectCount } = instrumentedRedis();

    @Global()
    @Module({
      providers: [
        { provide: REDIS_CONFIG, useValue: testRedisConfig() },
        { provide: REDIS_DRIVER_FACTORY, useValue: factory },
        RedisService,
        leaderCacheProvider,
        { provide: LEADER_INTERFACE_ENUMERATOR, useValue: fakeInterfaces },
        { provide: ContextLogger, useValue: new ContextLogger() },
      ],
      exports: [LEADER_CACHE, LEADER_INTERFACE_ENUMERATOR, ContextLogger, RedisService],
    })
    class DepsModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        DepsModule,
        LeaderElectionModule.forRoot({
          cacheToken: LEADER_CACHE,
          interfacesToken: LEADER_INTERFACE_ENUMERATOR,
          versionInfo: fakeVersion,
        }),
      ],
    }).compile();

    await moduleRef.init();
    await moduleRef.close();

    expect(connectCount()).toBe(1);

    const closeIdx = events.indexOf('close');
    const evalIdx = events.indexOf('eval');
    const delIdx = events.indexOf('del');
    expect(closeIdx).toBeGreaterThanOrEqual(0);
    expect(evalIdx).toBeGreaterThanOrEqual(0);
    expect(delIdx).toBeGreaterThanOrEqual(0);
    expect(evalIdx).toBeLessThan(closeIdx);
    expect(delIdx).toBeLessThan(closeIdx);
    expect(events.filter((e) => e === 'close')).toHaveLength(1);
  });
});
