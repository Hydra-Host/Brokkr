
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setGrpcServerStatus } from '../../../../src/agent/gateway/grpc-server.service.js';
import { HealthController } from '../../../../src/bridge-status/health.controller.js';
import type {
  RedisConfig,
  RedisDriver,
  RedisDriverFactory,
  RedisDriverPipeline,
} from '../../../../src/common/redis/redis-client/index.js';
import { RedisConnectionError } from '../../../../src/common/redis/redis-client/redis.errors.js';
import { RedisModule } from '../../../../src/common/redis/redis.module.js';
import { RedisService } from '../../../../src/common/redis/redis.service.js';
import { SnmpEngine } from '../../../../src/snmp/engine.js';

class FakePipeline implements RedisDriverPipeline {
  hset(): RedisDriverPipeline {
    return this;
  }
  expire(): RedisDriverPipeline {
    return this;
  }
  async exec(): Promise<unknown[]> {
    return [];
  }
}

class HealthyInMemoryDriver implements RedisDriver {
  readonly store = new Map<string, string>();

  async ping(): Promise<unknown> {
    return 'PONG';
  }
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<unknown> {
    this.store.set(key, value);
    return 'OK';
  }
  async setex(key: string, _ttl: number, value: string): Promise<unknown> {
    this.store.set(key, value);
    return 'OK';
  }
  async setNx(key: string, value: string): Promise<boolean> {
    if (this.store.has(key)) return false;
    this.store.set(key, value);
    return true;
  }
  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }
  async exists(key: string): Promise<number> {
    return this.store.has(key) ? 1 : 0;
  }
  async rpush(): Promise<number> {
    return 0;
  }
  async xadd(): Promise<string> {
    return '1-0';
  }
  async lrange(): Promise<string[]> {
    return [];
  }
  async expire(): Promise<number> {
    return 1;
  }
  async hset(): Promise<number> {
    return 0;
  }
  async hget(): Promise<string | null> {
    return null;
  }
  async hgetall(): Promise<Record<string, string>> {
    return {};
  }
  async *scanMatch(): AsyncIterable<string> {
  }
  async eval(): Promise<unknown> {
    return null;
  }
  pipeline(): RedisDriverPipeline {
    return new FakePipeline();
  }
  multi(): RedisDriverPipeline {
    return new FakePipeline();
  }
  async close(): Promise<void> {
  }
}

class BrokenInMemoryDriver implements RedisDriver {
  private fail(): never {
    throw new RedisConnectionError('ECONNREFUSED — fake broken driver');
  }
  async ping(): Promise<unknown> {
    this.fail();
  }
  async get(): Promise<string | null> {
    this.fail();
  }
  async set(): Promise<unknown> {
    this.fail();
  }
  async setex(): Promise<unknown> {
    this.fail();
  }
  async setNx(): Promise<boolean> {
    this.fail();
  }
  async del(): Promise<number> {
    this.fail();
  }
  async exists(): Promise<number> {
    this.fail();
  }
  async rpush(): Promise<number> {
    this.fail();
  }
  async xadd(): Promise<string> {
    this.fail();
  }
  async lrange(): Promise<string[]> {
    this.fail();
  }
  async expire(): Promise<number> {
    this.fail();
  }
  async hset(): Promise<number> {
    this.fail();
  }
  async hget(): Promise<string | null> {
    this.fail();
  }
  async hgetall(): Promise<Record<string, string>> {
    this.fail();
  }
  async *scanMatch(): AsyncIterable<string> {
    this.fail();
  }
  async eval(): Promise<unknown> {
    this.fail();
  }
  pipeline(): RedisDriverPipeline {
    this.fail();
  }
  multi(): RedisDriverPipeline {
    this.fail();
  }
  async close(): Promise<void> {
  }
}

const FAKE_REDIS_CONFIG: RedisConfig = {
  url: 'redis://fake/0',
  host: 'fake',
  port: 6379,
  username: '',
  password: '',
  db: 0,
  tls: false,
  tlsCaCert: '',
  prefix: '',
  socketTimeout: 5,
  socketConnectTimeout: 5,
  retryOnError: true,
  maxConnections: 1,
  encryptionKey: 'wmjZhYLXlEQTYtwCVFNg1Q4k+5yQEQHLa87eDmf0Tmo=',
  ttls: {
    deviceNetplan: 120,
    bmcCipher: 2_592_000,
    deviceSshIp: 300,
    resolvedIp: 3600,
    deviceInitrd: 600,
    bridgeInterfaces: 300,
    syncVersion: 2_592_000,
  },
};

function buildTestModule(driverFactory: RedisDriverFactory) {
  @Module({
    imports: [
      RedisModule.forRoot({
        config: FAKE_REDIS_CONFIG,
        driverFactory,
        logger: {
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
        },
      }),
    ],
    controllers: [HealthController],
    providers: [{ provide: SnmpEngine, useFactory: () => new SnmpEngine() }],
  })
  class HealthIntegrationTestModule {}
  return HealthIntegrationTestModule;
}

describe('/api/health integration — Redis ping wiring', () => {
  beforeEach(() => {
    setGrpcServerStatus(null);
  });

  afterEach(() => {
    setGrpcServerStatus(null);
  });

  it("returns redis:'ok' when the in-memory Redis driver answers PING", async () => {
    const driver = new HealthyInMemoryDriver();
    const driverFactory: RedisDriverFactory = async () => driver;

    const moduleRef = await Test.createTestingModule({
      imports: [buildTestModule(driverFactory)],
    }).compile();

    try {
      const engine = moduleRef.get(SnmpEngine);
      await engine.start();
      const controller = moduleRef.get(HealthController, { strict: false });

      const body = await controller.healthCheck();

      expect(body.redis).toBe('ok');
      expect(body.status).toBe('OK');
      const redis = moduleRef.get(RedisService);
      expect(redis).toBeInstanceOf(RedisService);
    } finally {
      await moduleRef.close();
    }
  });

  it("breaks the Redis connection, calls again, returns redis:'failed' + status degraded (no throw — HTTP 200 contract)", async () => {
    const driverFactory: RedisDriverFactory = async () => new BrokenInMemoryDriver();

    const moduleRef = await Test.createTestingModule({
      imports: [buildTestModule(driverFactory)],
    }).compile();

    try {
      const engine = moduleRef.get(SnmpEngine);
      await engine.start();
      const controller = moduleRef.get(HealthController, { strict: false });

      const body = await controller.healthCheck();

      expect(body.redis).toBe('failed');
      expect(body.status).toBe('degraded');
    } finally {
      await moduleRef.close();
    }
  });

  it('flips redis:ok → redis:failed when the same RedisService is asked to ping after the driver starts throwing', async () => {
    let driver: RedisDriver = new HealthyInMemoryDriver();
    const driverFactory: RedisDriverFactory = async () => driver;

    const moduleRef = await Test.createTestingModule({
      imports: [buildTestModule(driverFactory)],
    }).compile();

    try {
      const engine = moduleRef.get(SnmpEngine);
      await engine.start();
      const controller = moduleRef.get(HealthController, { strict: false });

      const firstBody = await controller.healthCheck();
      expect(firstBody.redis).toBe('ok');
      expect(firstBody.status).toBe('OK');

      const redis = moduleRef.get(RedisService);
      await redis.close();
      driver = new BrokenInMemoryDriver();

      const secondBody = await controller.healthCheck();
      expect(secondBody.redis).toBe('failed');
      expect(secondBody.status).toBe('degraded');
    } finally {
      await moduleRef.close();
    }
  });
});
