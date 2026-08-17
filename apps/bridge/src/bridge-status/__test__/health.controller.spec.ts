import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setGrpcServerStatus, type GrpcServerStatus } from '../../agent/gateway/grpc-server.service.js';
import { getBullmqConfig } from '../../bullmq/bullmq.config.js';
import type { BullmqQueueService } from '../../bullmq/queue.service.js';
import type { RedisService } from '../../common/redis/redis.service.js';
import { setLeaderService, type LeaderElectionService } from '../../leader-election/leader-election.service.js';
import { SnmpEngine } from '../../snmp/engine.js';
import { HealthController } from '../health.controller.js';

describe('HealthController', () => {
  beforeEach(() => {
    setGrpcServerStatus(null);
  });
  afterEach(() => {
    setGrpcServerStatus(null);
  });

  it('returns OK with bridge_version and snmp_engine ok after start()', async () => {
    const engine = new SnmpEngine();
    await engine.start();
    const body = await new HealthController(engine).healthCheck();
    expect(body.status).toBe('OK');
    expect(typeof body.bridge_version).toBe('string');
    expect(body.snmp_engine).toBe('ok');
  });

  it('reports not_initialized in the post-construction / pre-start() boot window', async () => {
    const body = await new HealthController(new SnmpEngine()).healthCheck();
    expect(body.snmp_engine).toBe('not_initialized');
  });

  it('returns OK status when SNMP is not_initialized (SNMP_ENABLED=false path)', async () => {
    // Engine never started — simulates SNMP_ENABLED=false.  Health must still be OK.
    const body = await new HealthController(new SnmpEngine()).healthCheck();
    expect(body.snmp_engine).toBe('not_initialized');
    expect(body.status).toBe('OK');
  });

  it('reports a closed engine', async () => {
    const engine = new SnmpEngine();
    await engine.close();
    const body = await new HealthController(engine).healthCheck();
    expect(body.snmp_engine).toBe('closed');
  });

  it('exposes status and bridge_version on the response body', async () => {
    const engine = new SnmpEngine();
    await engine.start();
    const body = await new HealthController(engine).healthCheck();
    expect(typeof body).toBe('object');
    expect(body).toHaveProperty('status', 'OK');
    expect(body).toHaveProperty('bridge_version');
  });

  it('returns the OK payload even when logDebug throws', async () => {
    const loggerModule = await import('../../logger/logger.service.js');
    const spy = vi.spyOn(loggerModule, 'logDebug').mockImplementation(async () => {
      throw new Error('Logging failed');
    });
    try {
      const engine = new SnmpEngine();
      await engine.start();
      await expect(new HealthController(engine).healthCheck()).resolves.toMatchObject({
        status: 'OK',
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('returns a consistent payload across repeated calls', async () => {
    const engine = new SnmpEngine();
    await engine.start();
    const ctrl = new HealthController(engine);
    const first = await ctrl.healthCheck();
    const second = await ctrl.healthCheck();
    const third = await ctrl.healthCheck();
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it('exposes healthCheck as a callable method', () => {
    const engine = new SnmpEngine();
    const ctrl = new HealthController(engine);
    expect(typeof ctrl.healthCheck).toBe('function');
  });

  describe('subsystem readiness wiring', () => {
    function makeRedis(pingResult: boolean | Error): RedisService {
      return {
        ping: async (): Promise<boolean> => {
          if (pingResult instanceof Error) throw pingResult;
          return pingResult;
        },
      } as unknown as RedisService;
    }

    function makeBullmq(
      lifecycleCounts: Record<string, number> | null | Error,
      collectionCounts: Record<string, number> | null | Error,
    ): BullmqQueueService {
      const makeQueue = (counts: Record<string, number> | null | Error): unknown =>
        counts === null
          ? null
          : {
              getJobCounts: async (): Promise<Record<string, number>> => {
                if (counts instanceof Error) throw counts;
                return counts;
              },
            };
      return {
        getLifecycleQueue: async () => makeQueue(lifecycleCounts),
        getCollectionQueue: async () => makeQueue(collectionCounts),
      } as unknown as BullmqQueueService;
    }

    it("reports redis:'ok' when ping succeeds + still returns OK status", async () => {
      const engine = new SnmpEngine();
      await engine.start();
      const body = await new HealthController(engine, makeRedis(true)).healthCheck();
      expect(body.redis).toBe('ok');
      expect(body.status).toBe('OK');
    });

    it("reports redis:'failed' when ping returns false, marks status degraded, still HTTP 200", async () => {
      const engine = new SnmpEngine();
      await engine.start();
      const body = await new HealthController(engine, makeRedis(false)).healthCheck();
      expect(body.redis).toBe('failed');
      expect(body.status).toBe('degraded');
    });

    it("reports redis:'failed' when ping throws (defensive swallow)", async () => {
      const engine = new SnmpEngine();
      await engine.start();
      const body = await new HealthController(engine, makeRedis(new Error('ECONNREFUSED'))).healthCheck();
      expect(body.redis).toBe('failed');
      expect(body.status).toBe('degraded');
    });

    it("reports redis:'not_initialized' when no RedisService is wired", async () => {
      const engine = new SnmpEngine();
      await engine.start();
      const body = await new HealthController(engine).healthCheck();
      expect(body.redis).toBe('not_initialized');
      expect(body.status).toBe('OK');
    });

    it('reports per-queue depth as wait+active+delayed', async () => {
      const engine = new SnmpEngine();
      await engine.start();
      const body = await new HealthController(
        engine,
        makeRedis(true),
        makeBullmq({ wait: 3, active: 2, delayed: 1 }, { wait: 0, active: 0, delayed: 0 }),
      ).healthCheck();
      const cfg = getBullmqConfig();
      const depths = body.queue_depth as Record<string, number | null>;
      expect(depths[cfg.bullmqQueueName]).toBe(6);
      expect(depths[cfg.collectionQueueName]).toBe(0);
      expect(body.status).toBe('OK');
    });

    it('returns null queue depth when a queue is not wired (still 200, status degraded)', async () => {
      const engine = new SnmpEngine();
      await engine.start();
      const body = await new HealthController(
        engine,
        makeRedis(true),
        makeBullmq(null, { wait: 0, active: 0, delayed: 0 }),
      ).healthCheck();
      const cfg = getBullmqConfig();
      const depths = body.queue_depth as Record<string, number | null>;
      expect(depths[cfg.bullmqQueueName]).toBeNull();
      expect(depths[cfg.collectionQueueName]).toBe(0);
      expect(body.status).toBe('degraded');
    });

    it('reports leader flag from getLeaderService() when a service is registered', async () => {
      const engine = new SnmpEngine();
      await engine.start();
      const fakeLeader = { isLeader: true } as unknown as LeaderElectionService;
      setLeaderService(fakeLeader);
      try {
        const body = await new HealthController(engine).healthCheck();
        expect(body.leader).toBe(true);
      } finally {
        setLeaderService(null);
      }
    });

    it('reports leader:null when no leader service is registered (orchestrator-disabled path)', async () => {
      setLeaderService(null);
      const engine = new SnmpEngine();
      await engine.start();
      const body = await new HealthController(engine).healthCheck();
      expect(body.leader).toBeNull();
    });

    it("reports grpc:'ok' when the orchestrator has published a bound snapshot", async () => {
      const engine = new SnmpEngine();
      await engine.start();
      const snapshot: GrpcServerStatus = {
        bound: true,
        internalHost: '127.0.0.1',
        internalPort: 9082,
      };
      setGrpcServerStatus(snapshot);
      const body = await new HealthController(engine).healthCheck();
      expect(body.grpc).toBe('ok');
      expect(body.status).toBe('OK');
    });

    it("reports grpc:'failed' when the orchestrator published bound=false (GRPC_ENABLED=false or bind failed) and marks status degraded", async () => {
      const engine = new SnmpEngine();
      await engine.start();
      setGrpcServerStatus({
        bound: false,
        internalHost: '127.0.0.1',
        internalPort: 9082,
      });
      const body = await new HealthController(engine).healthCheck();
      expect(body.grpc).toBe('failed');
      expect(body.status).toBe('degraded');
    });

    it("reports grpc:'not_initialized' when no snapshot is registered (boot window) and keeps status OK", async () => {
      const engine = new SnmpEngine();
      await engine.start();
      const body = await new HealthController(engine).healthCheck();
      expect(body.grpc).toBe('not_initialized');
      expect(body.status).toBe('OK');
    });

    it('always returns a JSON body (HTTP 200 contract preserved across subsystem failures)', async () => {
      const engine = new SnmpEngine();
      await engine.close();
      const body = await new HealthController(
        engine,
        makeRedis(false),
        makeBullmq(new Error('boom'), new Error('boom')),
      ).healthCheck();
      expect(body.status).toBe('degraded');
      expect(body.snmp_engine).toBe('closed');
      expect(body.redis).toBe('failed');
      const cfg = getBullmqConfig();
      const depths = body.queue_depth as Record<string, number | null>;
      expect(depths[cfg.bullmqQueueName]).toBeNull();
      expect(depths[cfg.collectionQueueName]).toBeNull();
    });
  });
});
