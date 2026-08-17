import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Logger } from 'src/common/decorators/logger.decorator';
import { LoggerService } from 'src/logger/logger.service';
import { BridgeQueueService } from '../queue/bridge-queue.service';

export type InventoryCollectionSource = 'manual' | 'cron' | 'phone-home';

const PLAN_ID_PREFIX: Record<InventoryCollectionSource, string> = {
  manual: 'manual-collect-',
  cron: 'inventory-cron-',
  'phone-home': 'phone-home-discovery-',
};

@Injectable()
export class BridgeInventoryCollectionService {
  constructor(
    private readonly bridgeQueueService: BridgeQueueService,
    @Logger(BridgeInventoryCollectionService.name)
    private readonly logger: LoggerService,
  ) {}

  async startInventoryCollection(
    deviceId: string,
    zoneId: string,
    source: InventoryCollectionSource = 'manual',
  ): Promise<{ jobId: string }> {
    const planId = `${PLAN_ID_PREFIX[source]}${randomUUID()}`;
    const coalesceKey = `inventory-cron-${deviceId}`;
    const job = await this.bridgeQueueService.enqueueSagaJob(
      zoneId,
      'inventory_collection',
      planId,
      { device_id: deviceId },
      deviceId,
      { removeOnComplete: { age: 300 }, removeOnFail: { age: 3600 }, coalesceKey },
    );
    const jobId = job.id ?? coalesceKey;
    this.logger.log(
      `inventory_collection enqueued: device=${deviceId}, zone=${zoneId}, source=${source}, jobId=${jobId}, planId=${planId}`,
      planId,
    );
    return { jobId };
  }
}
