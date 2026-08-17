import { Controller } from '@nestjs/common';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';

import { contract } from '../contract';
import { DeviceTokensReaderService } from './device-tokens.reader';
import { LifecycleJobsReaderService } from './lifecycle-jobs.reader';
import { LifecycleQueueReaderService } from './lifecycle-queue.reader';
import { WebhookDeliveriesReaderService } from './webhook-deliveries.reader';

@Controller()
export class HubController {
  constructor(
    private readonly deliveries: WebhookDeliveriesReaderService,
    private readonly lifecycleJobs: LifecycleJobsReaderService,
    private readonly lifecycleQueue: LifecycleQueueReaderService,
    private readonly deviceTokens: DeviceTokensReaderService,
  ) {}

  @TsRestHandler(contract.listWebhookDeliveries)
  listWebhookDeliveries() {
    return tsRestHandler(contract.listWebhookDeliveries, async ({ query }) => ({
      status: 200 as const,
      body: await this.deliveries.list({
        status: query.status ?? null,
        webhookId: query.webhookId ?? null,
        limit: query.limit,
        offset: query.offset,
      }),
    }));
  }

  @TsRestHandler(contract.listLifecycleJobs)
  listLifecycleJobs() {
    return tsRestHandler(contract.listLifecycleJobs, async ({ query }) => ({
      status: 200 as const,
      body: await this.lifecycleJobs.list({
        phases: query.phases,
        deviceId: query.deviceId ?? null,
        limit: query.limit,
        offset: query.offset,
      }),
    }));
  }

  @TsRestHandler(contract.getLifecycleJob)
  getLifecycleJob() {
    return tsRestHandler(contract.getLifecycleJob, async ({ params }) => ({
      status: 200 as const,
      body: await this.lifecycleJobs.get(params.jobId),
    }));
  }

  @TsRestHandler(contract.getLifecycleJobQueueJobs)
  getLifecycleJobQueueJobs() {
    return tsRestHandler(contract.getLifecycleJobQueueJobs, async ({ params }) => ({
      status: 200 as const,
      body: await this.lifecycleQueue.forJob(params.jobId),
    }));
  }

  @TsRestHandler(contract.listDeviceTokens)
  listDeviceTokens() {
    return tsRestHandler(contract.listDeviceTokens, async ({ query }) => ({
      status: 200 as const,
      body: await this.deviceTokens.list({
        deviceId: query.deviceId ?? null,
        status: query.status ?? null,
        limit: query.limit,
        offset: query.offset,
      }),
    }));
  }

  @TsRestHandler(contract.getDeviceTokenEvents)
  getDeviceTokenEvents() {
    return tsRestHandler(contract.getDeviceTokenEvents, async ({ params, query }) => ({
      status: 200 as const,
      body: await this.deviceTokens.events(params.tokenId, query.limit, query.offset),
    }));
  }
}
