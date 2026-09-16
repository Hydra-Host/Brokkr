import { Inject, Injectable } from '@nestjs/common';
import { JobType } from '@repo/database';
import { SYSTEM_JOB_SAGAS } from '@repo/lifecycle';
import { Logger } from 'src/common/decorators/logger.decorator';
import { LifecycleService, type SystemJobSource } from 'src/lifecycle/lifecycle.service';
import { LoggerService } from 'src/logger/logger.service';
import { BridgeQueueService } from '../queue/bridge-queue.service';

export type InventoryCollectionSource = Exclude<SystemJobSource, 'discovery'>;

/** Thrown from the dispatch closure so `proceed` fails the lifecycle row with this reason instead of leaving it to the stuck sweep. */
export class InventoryCollectionCoalescedError extends Error {
  constructor(public readonly jobId: string) {
    super(`inventory_collection coalesced onto active job ${jobId}`);
    this.name = 'InventoryCollectionCoalescedError';
  }
}

@Injectable()
export class BridgeInventoryCollectionService {
  constructor(
    @Inject(BridgeQueueService)
    private readonly bridgeQueueService: Pick<BridgeQueueService, 'hasActiveSagaJob' | 'enqueueSagaJobOrCoalesce'>,
    @Inject(LifecycleService) private readonly lifecycleService: Pick<LifecycleService, 'runSystem'>,
    @Logger(BridgeInventoryCollectionService.name)
    private readonly logger: LoggerService,
  ) {}

  async startInventoryCollection(
    deviceId: string,
    zoneId: string,
    source: InventoryCollectionSource = 'manual',
  ): Promise<{ jobId: string }> {
    // enqueueSagaJobOrCoalesce keys the BullMQ job by coalesceKey, so coalesceKey is the jobId on every path
    const coalesceKey = `inventory-cron-${deviceId}`;
    // a coalesced trigger must leave no lifecycle row: DISPATCHED cannot reach ABORTED, so peek before recording one
    if (await this.bridgeQueueService.hasActiveSagaJob(zoneId, coalesceKey)) {
      this.logger.log(
        `inventory_collection coalesced onto the active job for device ${deviceId}: jobId=${coalesceKey}`,
      );
      return { jobId: coalesceKey };
    }

    try {
      await this.lifecycleService.runSystem({
        jobType: JobType.InventoryCollection,
        deviceId,
        zoneId,
        source,
        dispatch: async (planId) => {
          const { coalesced } = await this.bridgeQueueService.enqueueSagaJobOrCoalesce(
            zoneId,
            SYSTEM_JOB_SAGAS[JobType.InventoryCollection],
            planId,
            { device_id: deviceId },
            deviceId,
            { removeOnComplete: { age: 300 }, removeOnFail: { age: 3600 }, coalesceKey },
          );
          if (coalesced) throw new InventoryCollectionCoalescedError(coalesceKey);
          this.logger.log(
            `inventory_collection enqueued: device=${deviceId}, zone=${zoneId}, source=${source}, jobId=${coalesceKey}, planId=${planId}`,
            planId,
          );
        },
      });
    } catch (error) {
      if (!(error instanceof InventoryCollectionCoalescedError)) throw error;
      this.logger.log(
        `inventory_collection coalesced onto the active job for device ${deviceId} between the peek and the enqueue: jobId=${error.jobId}`,
      );
    }
    return { jobId: coalesceKey };
  }
}
