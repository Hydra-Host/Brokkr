import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { forwardRef, Module, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { BrokkrBridgeModule } from 'src/brokkr-bridge/brokkr-bridge.module';
import { CloudInitTemplatesModule } from 'src/cloud-init-templates/cloud-init-templates.module';
import { CommonModule } from 'src/common/common.module';
import { ContextModule } from 'src/common/context/context.module';
import { LifecycleModule } from 'src/lifecycle/lifecycle.module';
import { PrismaModule } from 'src/prisma/prisma.module';
import { ProvisionModule } from 'src/provision/provision.module';
import { WebhookModule } from 'src/webhook/webhook.module';
import { DeviceHealthService } from './device-health.service';
import { InventoryCollectionCron } from './inventory-collection.cron';
import {
  INVENTORY_COLLECTION_JOB,
  INVENTORY_COLLECTION_QUEUE,
  INVENTORY_COLLECTION_SCHEDULE,
} from './inventory-collection.types';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';

@Module({
  imports: [
    ContextModule,
    CommonModule,
    forwardRef(() => ProvisionModule),
    PrismaModule,
    WebhookModule,
    forwardRef(() => BrokkrBridgeModule),
    forwardRef(() => LifecycleModule),
    CloudInitTemplatesModule,
    BullModule.registerQueue({ name: INVENTORY_COLLECTION_QUEUE }),
  ],
  providers: [InventoryService, DeviceHealthService, InventoryCollectionCron],
  controllers: [InventoryController],
  exports: [InventoryService, DeviceHealthService],
})
export class InventoryModule implements OnModuleInit {
  constructor(
    @InjectQueue(INVENTORY_COLLECTION_QUEUE) private readonly queue: Queue,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.configService.get('INVENTORY_COLLECTION_ENABLED') === 'false') return;
    await this.queue.upsertJobScheduler(
      INVENTORY_COLLECTION_JOB,
      { pattern: INVENTORY_COLLECTION_SCHEDULE },
      {
        name: INVENTORY_COLLECTION_JOB,
        opts: {
          attempts: 3,
          backoff: { type: 'fixed', delay: 5000 },
          removeOnComplete: { count: 10 },
          removeOnFail: { age: 86400 },
        },
      },
    );
  }
}
