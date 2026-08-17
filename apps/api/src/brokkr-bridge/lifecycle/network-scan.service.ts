import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { Logger } from 'src/common/decorators/logger.decorator';
import { REDIS_CLIENT } from 'src/common/redis';
import { LoggerService } from 'src/logger/logger.service';
import { z } from 'zod';
import { NETWORK_SCAN_RESULT_TTL_SECONDS } from '../constants/lifecycle.constants';
import { BridgeQueueService } from '../queue/bridge-queue.service';

function resultKey(planId: string): string {
  return `network-scan:result:${planId}`;
}

const networkScanPollResultSchema = z.object({
  status: z.enum(['pending', 'complete', 'failed']),
  result: z.object({ scanResults: z.record(z.unknown()) }).optional(),
  error: z.string().optional(),
});

export type NetworkScanPollResult = z.infer<typeof networkScanPollResultSchema>;

@Injectable()
export class BridgeNetworkScanService {
  constructor(
    private readonly bridgeQueueService: BridgeQueueService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Logger(BridgeNetworkScanService.name)
    private readonly logger: LoggerService,
  ) {}

  async startScan(zoneId: string, subnet: string): Promise<{ success: true; planId: string }> {
    const planId = `scan-${randomUUID()}`;

    this.logger.log(`Starting network scan: zone=${zoneId}, subnet=${subnet}`, planId);

    const key = resultKey(planId);
    await this.redis.set(key, JSON.stringify({ status: 'pending' }), 'EX', NETWORK_SCAN_RESULT_TTL_SECONDS);

    let bullmqJob;
    try {
      bullmqJob = await this.bridgeQueueService.enqueueSagaJob(zoneId, 'network_scan', planId, { subnet }, zoneId);
    } catch (error) {
      await this.redis.del(key);
      throw error;
    }

    this.logger.log(`network_scan saga enqueued: planId=${planId}, bullmqJobId=${bullmqJob.id}`, planId);

    return { success: true, planId };
  }

  async getScanResult(planId: string): Promise<NetworkScanPollResult> {
    const raw = await this.redis.get(resultKey(planId));

    if (!raw) {
      return { status: 'pending' };
    }

    return networkScanPollResultSchema.parse(JSON.parse(raw));
  }

  async storeScanResult(
    planId: string,
    status: 'complete' | 'failed',
    result?: Record<string, unknown>,
    error?: string,
  ): Promise<void> {
    const data: NetworkScanPollResult = { status };
    if (result) {
      data.result = { scanResults: result };
    }
    if (error) {
      data.error = error;
    }

    await this.redis.set(resultKey(planId), JSON.stringify(data), 'EX', NETWORK_SCAN_RESULT_TTL_SECONDS);
    this.logger.log(`Stored network scan result: planId=${planId}, status=${status}`, planId);
  }
}
