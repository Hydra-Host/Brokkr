import { Controller, Get, Optional } from '@nestjs/common';

import { getGrpcServerStatus } from '../agent/gateway/grpc-server.service.js';
import { getBullmqConfig } from '../bullmq/bullmq.config.js';
import { BullmqQueueService } from '../bullmq/queue.service.js';
import { RedisService } from '../common/redis/redis.service.js';
import { getLeaderService } from '../leader-election/leader-election.service.js';
import { logDebug } from '../logger/logger.service.js';
import { SnmpEngine } from '../snmp/engine.js';
import { getBridgeVersion } from './bridge.config.js';

interface CountableQueue {
  getJobCounts(...states: string[]): Promise<Record<string, number>>;
}

async function safeQueueDepth(queue: unknown): Promise<number | null> {
  const candidate = queue as Partial<CountableQueue> | null | undefined;
  if (candidate === null || candidate === undefined) return null;
  if (typeof candidate.getJobCounts !== 'function') return null;
  try {
    const counts = await candidate.getJobCounts('wait', 'active', 'delayed');
    return (counts.wait ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);
  } catch {
    return null;
  }
}

@Controller()
export class HealthController {
  constructor(
    private readonly snmpEngine: SnmpEngine,
    @Optional() private readonly redis?: RedisService,
    @Optional() private readonly bullmq?: BullmqQueueService,
  ) {}

  @Get('api/health')
  async healthCheck(): Promise<Record<string, unknown>> {
    try {
      await logDebug('Health check request received');
    } catch {
      // Logger failure must not flap k8s/Nomad readiness.
    }

    let snmpStatus: string;
    try {
      if (this.snmpEngine.isClosed()) {
        snmpStatus = 'closed';
      } else if (this.snmpEngine.isStarted()) {
        snmpStatus = 'ok';
      } else {
        snmpStatus = 'not_initialized';
      }
    } catch {
      snmpStatus = 'error';
    }

    let redisStatus: 'ok' | 'failed' | 'not_initialized' = 'not_initialized';
    if (this.redis !== undefined) {
      try {
        redisStatus = (await this.redis.ping()) ? 'ok' : 'failed';
      } catch {
        redisStatus = 'failed';
      }
    }

    let lifecycleDepth: number | null = null;
    let collectionDepth: number | null = null;
    if (this.bullmq !== undefined) {
      try {
        lifecycleDepth = await safeQueueDepth(await this.bullmq.getLifecycleQueue());
      } catch {
        lifecycleDepth = null;
      }
      try {
        collectionDepth = await safeQueueDepth(await this.bullmq.getCollectionQueue());
      } catch {
        collectionDepth = null;
      }
    }

    let leader: boolean | null = null;
    try {
      const leaderService = getLeaderService();
      leader = leaderService ? leaderService.isLeader : null;
    } catch {
      leader = null;
    }

    let grpcStatus: 'ok' | 'failed' | 'not_initialized' = 'not_initialized';
    try {
      const snapshot = getGrpcServerStatus();
      if (snapshot === null) {
        grpcStatus = 'not_initialized';
      } else if (snapshot.bound) {
        grpcStatus = 'ok';
      } else {
        grpcStatus = 'failed';
      }
    } catch {
      grpcStatus = 'failed';
    }

    // not_initialized counts as ok so the boot window doesn't flap readiness; HTTP stays 200 — probes consume the body's `status`.
    // snmpStatus is 'not_initialized' when SNMP_ENABLED is false (engine never started), which is intentional and healthy.
    const snmpOk = snmpStatus === 'ok' || snmpStatus === 'not_initialized';
    const queueLifecycleOk = this.bullmq === undefined || lifecycleDepth !== null;
    const queueCollectionOk = this.bullmq === undefined || collectionDepth !== null;
    const grpcOk = grpcStatus === 'ok' || grpcStatus === 'not_initialized';
    const subsystemsOk =
      snmpOk &&
      (redisStatus === 'ok' || redisStatus === 'not_initialized') &&
      queueLifecycleOk &&
      queueCollectionOk &&
      grpcOk;
    const status = subsystemsOk ? 'OK' : 'degraded';

    const config = getBullmqConfig();
    return {
      status,
      bridge_version: getBridgeVersion(),
      snmp_engine: snmpStatus,
      redis: redisStatus,
      queue_depth: {
        [config.bullmqQueueName]: lifecycleDepth,
        [config.collectionQueueName]: collectionDepth,
      },
      grpc: grpcStatus,
      leader,
    };
  }
}
