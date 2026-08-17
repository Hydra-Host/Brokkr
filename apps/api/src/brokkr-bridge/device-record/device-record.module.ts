import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { Module, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { RedisModule } from 'src/common/redis';
import { NetplanModule } from 'src/devices/netplan/netplan.module';
import { PrismaModule } from 'src/prisma/prisma.module';
import {
  DEVICE_DATA_RECONCILE_JOB,
  DEVICE_DATA_RECONCILE_QUEUE,
  DEVICE_DATA_RECONCILE_SCHEDULE,
} from './device-data-reconcile.types';
import { DeviceDataReconcilerCron } from './device-data-reconciler.cron';
import { DeviceRecordPublisher } from './device-record-publisher.service';
import { DeviceResolverService } from './device-resolver.service';

@Module({
  imports: [PrismaModule, RedisModule, NetplanModule, BullModule.registerQueue({ name: DEVICE_DATA_RECONCILE_QUEUE })],
  providers: [DeviceRecordPublisher, DeviceResolverService, DeviceDataReconcilerCron],
  exports: [DeviceRecordPublisher, DeviceResolverService],
})
export class DeviceRecordModule implements OnModuleInit {
  constructor(
    @InjectQueue(DEVICE_DATA_RECONCILE_QUEUE) private readonly queue: Queue,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.configService.get('DEVICE_DATA_RECONCILE_ENABLED') === 'false') return;
    await this.queue.upsertJobScheduler(
      DEVICE_DATA_RECONCILE_JOB,
      { pattern: DEVICE_DATA_RECONCILE_SCHEDULE },
      {
        name: DEVICE_DATA_RECONCILE_JOB,
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
