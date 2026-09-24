import {
  DEFERRED_ABORT_CAUSE_OPERATOR_APPROVAL_REJECTED,
  HOST_PLUGIN_ID,
  PLUGIN_EVENT_BUS,
  type BrokkrEventMap,
  type PluginEventBus,
} from '@hydrahost/plugin-sdk';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import '@repo/lifecycle';
import { getErrorMessage } from 'src/common/error-utils';
import { DeploymentRecord } from 'src/deployments/deployment.record';
import { NotificationService } from 'src/notifications/notification.service';

@Injectable()
export class ProvisionOutcomeNotificationObserver implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProvisionOutcomeNotificationObserver.name);
  private readonly unsubscribers: Array<() => void> = [];

  constructor(
    @Inject(PLUGIN_EVENT_BUS) private readonly eventBus: PluginEventBus,
    private readonly notifications: NotificationService,
  ) {}

  onModuleInit(): void {
    const opts = { pluginId: HOST_PLUGIN_ID };
    this.unsubscribers.push(
      this.eventBus.on('provision.completed', (e) => this.handleProvisionCompleted(e), opts),
      this.eventBus.on('provision.failed', (e) => this.handleProvisionFailed(e), opts),
      this.eventBus.on('provision.started', (e) => this.handleProvisionStarted(e), opts),
    );
  }

  onModuleDestroy(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
  }

  private async handleProvisionCompleted(event: BrokkrEventMap['provision.completed']): Promise<void> {
    try {
      const target = await this.resolveAudience(event);
      if (!target) return;

      await this.notifications.publish({
        type: 'provision.completed',
        idempotencyKey: `provision-completed:${event.jobId}`,
        userIds: [target.userId],
        organizationId: target.organizationId,
        title: 'Provisioning complete',
        body: `Provisioning of ${target.displayName} completed successfully.`,
        href: target.href,
        channels: { inApp: true, email: true },
      });
    } catch (error) {
      this.logger.warn(`Failed to publish provision.completed notification: ${getErrorMessage(error)}`);
    }
  }

  private async handleProvisionFailed(event: BrokkrEventMap['provision.failed']): Promise<void> {
    try {
      if (event.cause === DEFERRED_ABORT_CAUSE_OPERATOR_APPROVAL_REJECTED) return;

      const target = await this.resolveAudience(event);
      if (!target) return;

      const reason = event.error.trim() || 'unknown error';
      await this.notifications.publish({
        type: 'provision.failed',
        idempotencyKey: `provision-failed:${event.jobId}`,
        userIds: [target.userId],
        organizationId: target.organizationId,
        title: 'Provisioning failed',
        body: `Provisioning of ${target.displayName} failed: ${reason}`,
        href: target.href,
        channels: { inApp: true, email: true },
      });
    } catch (error) {
      this.logger.warn(`Failed to publish provision.failed notification: ${getErrorMessage(error)}`);
    }
  }

  private async handleProvisionStarted(event: BrokkrEventMap['provision.started']): Promise<void> {
    try {
      const target = await this.resolveAudience(event);
      if (!target) return;

      await this.notifications.publish({
        type: 'provision.started',
        idempotencyKey: `provision-started:${event.jobId}`,
        userIds: [target.userId],
        organizationId: target.organizationId,
        title: 'Provisioning started',
        body: `Provisioning of ${target.displayName} has started.`,
        href: target.href,
        channels: { inApp: true, email: true },
      });
    } catch (error) {
      this.logger.warn(`Failed to publish provision.started notification: ${getErrorMessage(error)}`);
    }
  }

  private async resolveAudience(event: {
    deploymentId: string | null;
    organizationId: string | null;
  }): Promise<{ userId: string; organizationId?: string; displayName: string; href?: string } | null> {
    if (!event.deploymentId) {
      this.logger.warn('Skipping lifecycle notification: missing deployment id');
      return null;
    }

    const aggregate = await DeploymentRecord.findAggregateUnscoped({ where: { id: event.deploymentId } });
    if (!aggregate?.deployer?.id) {
      this.logger.warn(`Skipping lifecycle notification: no deployer for deployment ${event.deploymentId}`);
      return null;
    }

    const deviceName = aggregate.server?.device?.name;
    const displayName = deviceName ?? aggregate.nickname;
    const organizationId = event.organizationId ?? aggregate.customerId;

    return {
      userId: aggregate.deployer.id,
      organizationId: organizationId || undefined,
      displayName,
      href: `/deployments/${event.deploymentId}`,
    };
  }
}
