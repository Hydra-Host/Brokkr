import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { Module, forwardRef, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  LIFECYCLE_SCHEDULED_QUEUE,
  LIFECYCLE_STUCK_SWEEP_JOB,
  LIFECYCLE_STUCK_SWEEP_QUEUE,
  LIFECYCLE_STUCK_SWEEP_SCHEDULE,
  LIFECYCLE_WATCHDOG_QUEUE,
} from '@repo/lifecycle';
import { Queue } from 'bullmq';
import { InstanceOperatorGuard } from 'src/auth/guards/instance-operator.guard';
import { BrokkrBridgeModule } from 'src/brokkr-bridge/brokkr-bridge.module';
import { DeploymentsModule } from 'src/deployments/deployments.module';
import { DeviceTokensModule } from 'src/device-tokens/device-tokens.module';
import { NotificationsModule } from 'src/notifications/notifications.module';
import { OrganizationsModule } from 'src/organizations/organizations.module';
import { HostPluginGateBusModule } from 'src/plugin-host/host-plugin-gate-bus.module';
import { PrismaModule } from 'src/prisma/prisma.module';
import { ProvisionModule } from 'src/provision/provision.module';
import { ReservationsModule } from '../reservations/reservations.module';
import { ClusterNetworkService } from './cluster-network.service';
import { LifecycleInboundService } from './inbound/lifecycle-inbound.service';
import { LifecycleScheduledConsumer } from './inbound/lifecycle-scheduled.consumer';
import { LifecycleStuckSweepCron } from './inbound/lifecycle-stuck-sweep.cron';
import { LifecycleWatchdogConsumer } from './inbound/lifecycle-watchdog.consumer';
import { InterruptibleApprovalsController } from './interruptible-approvals.controller';
import { InterruptibleApprovalsService } from './interruptible-approvals.service';
import { LifecycleRepository } from './lifecycle.repository';
import { LifecycleService } from './lifecycle.service';
import { DeploymentLifecycleActionObserver } from './observers/deployment-lifecycle-action.observer';
import { DeploymentWebhookObserver } from './observers/deployment-webhook.observer';
import { InfrastructureAlertNotificationObserver } from './observers/infrastructure-alert-notification.observer';
import { InterruptionEmailObserver } from './observers/interruption-email.observer';
import { ProvisionOutcomeNotificationObserver } from './observers/provision-outcome-notification.observer';
import { DeprovisionOperation } from './operations/deprovision.operation';
import { PowerControlOperation } from './operations/power-control.operation';
import { ProvisionDispatcher } from './operations/provision-dispatch';
import { ProvisionOperation } from './operations/provision.operation';
import { RebootOperation } from './operations/reboot.operation';
import { ReprovisionOperation } from './operations/reprovision.operation';
import { OperatorDeviceOpsService } from './operator-device-ops.service';
import { PowerStatusWatchdogCron } from './power-status-watchdog.cron';

@Module({
  imports: [
    forwardRef(() => BrokkrBridgeModule),
    forwardRef(() => DeploymentsModule),
    DeviceTokensModule,
    NotificationsModule,
    OrganizationsModule,
    PrismaModule,
    ProvisionModule,
    ReservationsModule,
    HostPluginGateBusModule,
    BullModule.registerQueue(
      { name: LIFECYCLE_SCHEDULED_QUEUE },
      { name: LIFECYCLE_WATCHDOG_QUEUE },
      { name: LIFECYCLE_STUCK_SWEEP_QUEUE },
    ),
  ],
  controllers: [InterruptibleApprovalsController],
  providers: [
    LifecycleService,
    ClusterNetworkService,
    InterruptibleApprovalsService,
    InstanceOperatorGuard,
    LifecycleInboundService,
    LifecycleScheduledConsumer,
    LifecycleWatchdogConsumer,
    LifecycleStuckSweepCron,
    PowerStatusWatchdogCron,
    LifecycleRepository,
    ProvisionDispatcher,
    RebootOperation,
    PowerControlOperation,
    DeprovisionOperation,
    ReprovisionOperation,
    ProvisionOperation,
    DeploymentLifecycleActionObserver,
    InterruptionEmailObserver,
    ProvisionOutcomeNotificationObserver,
    InfrastructureAlertNotificationObserver,
    DeploymentWebhookObserver,
    OperatorDeviceOpsService,
  ],
  exports: [LifecycleService, LifecycleInboundService, OperatorDeviceOpsService],
})
export class LifecycleModule implements OnModuleInit {
  constructor(
    @InjectQueue(LIFECYCLE_STUCK_SWEEP_QUEUE) private readonly stuckSweepQueue: Queue,
    private readonly configService: ConfigService,
  ) {}

  // Disabled replicas only skip registration — never removeJobScheduler (shared; one disabled replica would stop the sweep everywhere); attempts > 1 re-queues a tick a disabled replica fails during the worker startup race.
  async onModuleInit(): Promise<void> {
    if (this.configService.get('LIFECYCLE_STUCK_SWEEP_ENABLED') === 'false') return;
    await this.stuckSweepQueue.upsertJobScheduler(
      LIFECYCLE_STUCK_SWEEP_JOB,
      { pattern: LIFECYCLE_STUCK_SWEEP_SCHEDULE },
      {
        name: LIFECYCLE_STUCK_SWEEP_JOB,
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
