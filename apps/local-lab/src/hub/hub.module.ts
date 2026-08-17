import { Module } from '@nestjs/common';

import { DatastoreModule } from '../datastore/datastore.module';
import { QueuesModule } from '../queues/queues.module';
import { DeviceTokensReaderService } from './device-tokens.reader';
import { HubController } from './hub.controller';
import { LifecycleJobsReaderService } from './lifecycle-jobs.reader';
import { LifecycleQueueReaderService } from './lifecycle-queue.reader';
import { WebhookDeliveriesReaderService } from './webhook-deliveries.reader';

@Module({
  imports: [DatastoreModule, QueuesModule],
  controllers: [HubController],
  providers: [
    WebhookDeliveriesReaderService,
    LifecycleJobsReaderService,
    LifecycleQueueReaderService,
    DeviceTokensReaderService,
  ],
  exports: [WebhookDeliveriesReaderService, LifecycleJobsReaderService, DeviceTokensReaderService],
})
export class HubModule {}
