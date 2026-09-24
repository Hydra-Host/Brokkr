import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { Module, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { BrokkrBridgeModule } from 'src/brokkr-bridge/brokkr-bridge.module';
import { EmailModule } from 'src/email/email.module';
import { PrismaModule } from 'src/prisma/prisma.module';
import { BridgeAlertingService } from './bridge-alerting.service';
import { DeviceHealthCheckCron } from './device-health-check.cron';
import {
  DEVICE_HEALTH_CHECK_JOB,
  DEVICE_HEALTH_CHECK_QUEUE,
  DEVICE_HEALTH_CHECK_SCHEDULE,
} from './device-health-check.types';
import { DeviceHealthRequestController } from './device-health-request.controller';
import { DeviceHealthRequestService } from './device-health-request.service';
import { HealthCheckDispatcher } from './health-check-dispatcher';
import { HeartbeatMonitorCron } from './heartbeat-monitor.cron';
import { HeartbeatMonitorService } from './heartbeat-monitor.service';
import { HEARTBEAT_MONITOR_JOB, HEARTBEAT_MONITOR_QUEUE, HEARTBEAT_MONITOR_SCHEDULE } from './heartbeat-monitor.types';
import { HeartbeatRetentionCron } from './heartbeat-retention.cron';
import { ZoneAlertingService } from './zone-alerting.service';
import { ZoneFlapAlertingService } from './zone-flap-alerting.service';
import { ZoneFlapDetectionService } from './zone-flap-detection.service';

const repeatableOpts = {
  attempts: 3,
  backoff: { type: 'fixed' as const, delay: 5000 },
  removeOnComplete: { count: 10 },
  removeOnFail: { age: 86400 },
};

@Module({
  imports: [
    PrismaModule,
    EmailModule,
    BrokkrBridgeModule,
    BullModule.registerQueue({ name: DEVICE_HEALTH_CHECK_QUEUE }, { name: HEARTBEAT_MONITOR_QUEUE }),
  ],
  providers: [
    HeartbeatMonitorService,
    HeartbeatMonitorCron,
    HeartbeatRetentionCron,
    DeviceHealthCheckCron,
    DeviceHealthRequestService,
    HealthCheckDispatcher,
    ZoneAlertingService,
    ZoneFlapDetectionService,
    ZoneFlapAlertingService,
    BridgeAlertingService,
  ],
  controllers: [DeviceHealthRequestController],
  exports: [ZoneAlertingService, HealthCheckDispatcher],
})
export class HeartbeatMonitorModule implements OnModuleInit {
  constructor(
    @InjectQueue(DEVICE_HEALTH_CHECK_QUEUE) private readonly deviceHealthQueue: Queue,
    @InjectQueue(HEARTBEAT_MONITOR_QUEUE) private readonly heartbeatQueue: Queue,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.configService.get('DEVICE_HEALTH_CHECK_ENABLED') !== 'false') {
      await this.deviceHealthQueue.upsertJobScheduler(
        DEVICE_HEALTH_CHECK_JOB,
        { pattern: DEVICE_HEALTH_CHECK_SCHEDULE },
        { name: DEVICE_HEALTH_CHECK_JOB, opts: repeatableOpts },
      );
    }
    if (this.configService.get('HEARTBEAT_MONITOR_ENABLED') !== 'false') {
      await this.heartbeatQueue.upsertJobScheduler(
        HEARTBEAT_MONITOR_JOB,
        { pattern: HEARTBEAT_MONITOR_SCHEDULE },
        { name: HEARTBEAT_MONITOR_JOB, opts: repeatableOpts },
      );
    }
  }
}
