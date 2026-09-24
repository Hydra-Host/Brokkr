import { HOST_PLUGIN_ID, PLUGIN_EVENT_BUS, type BrokkrEventMap, type PluginEventBus } from '@hydrahost/plugin-sdk';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import '@repo/lifecycle';
import { BRAND_NAME } from 'src/common/branding';
import { getErrorMessage } from 'src/common/error-utils';
import { DeploymentRecord } from 'src/deployments/deployment.record';
import { NotificationService } from 'src/notifications/notification.service';
import { OrganizationMembershipsService } from 'src/organizations/members/organization-members.service';
import { formatMilliseconds } from 'src/utils/time-conversions';

@Injectable()
export class InterruptionEmailObserver implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InterruptionEmailObserver.name);
  private readonly unsubscribers: Array<() => void> = [];

  constructor(
    @Inject(PLUGIN_EVENT_BUS) private readonly eventBus: PluginEventBus,
    private readonly notifications: NotificationService,
    private readonly memberships: OrganizationMembershipsService,
  ) {}

  onModuleInit(): void {
    const opts = { pluginId: HOST_PLUGIN_ID };
    this.unsubscribers.push(
      this.eventBus.on('deployment.interruption.scheduled', (e) => this.handleScheduled(e), opts),
      this.eventBus.on('deployment.interruption.completed', (e) => this.handleCompleted(e), opts),
      this.eventBus.on('deployment.interruption.queued', (e) => this.handleQueued(e), opts),
    );
  }

  onModuleDestroy(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
  }

  private async handleScheduled(event: BrokkrEventMap['deployment.interruption.scheduled']): Promise<void> {
    try {
      if (!event.organizationId) return;

      const aggregate = await DeploymentRecord.findAggregateUnscoped({ where: { id: event.deploymentId } });
      if (!aggregate) return;

      const members = await this.memberships.getMembersForAnOrganization(event.organizationId);
      const userIds = [...new Set(members.map((m) => m.user.id))];
      if (userIds.length === 0) return;

      const delayInMs = Math.max(0, event.interruptAt.getTime() - Date.now());
      const delayLabel = formatMilliseconds(delayInMs) || 'a short time';

      await this.notifications.publish({
        type: 'deployment.interruption.scheduled',
        idempotencyKey: `interruption-scheduled:${event.deploymentId}:${event.interruptAt.toISOString()}`,
        userIds,
        organizationId: event.organizationId,
        title: 'Deployment interruption notice',
        body: `A deployment will be deleted from your ${BRAND_NAME} account in approximately ${delayLabel}. Deployment: ${aggregate.nickname}.`,
        href: `/deployments/${event.deploymentId}`,
        channels: { inApp: true, email: true },
      });
    } catch (error) {
      this.logger.warn(`Failed to publish deployment.interruption.scheduled notification: ${getErrorMessage(error)}`);
    }
  }

  private async handleCompleted(event: BrokkrEventMap['deployment.interruption.completed']): Promise<void> {
    try {
      const aggregate = await DeploymentRecord.findAggregateUnscoped({ where: { id: event.deploymentId } });
      if (!aggregate?.deployer?.id) return;

      await this.notifications.publish({
        type: 'deployment.interruption.completed',
        idempotencyKey: `interruption-completed:${event.deploymentId}`,
        userIds: [aggregate.deployer.id],
        organizationId: event.organizationId ?? aggregate.customerId ?? undefined,
        title: 'Deployment interruption complete',
        body: `Your deployment has been interrupted. Deployment: ${aggregate.nickname}.`,
        href: `/deployments/${event.deploymentId}`,
        channels: { inApp: true, email: true },
      });
    } catch (error) {
      this.logger.warn(`Failed to publish deployment.interruption.completed notification: ${getErrorMessage(error)}`);
    }
  }

  private async handleQueued(event: BrokkrEventMap['deployment.interruption.queued']): Promise<void> {
    try {
      const members = await this.memberships.getMembersForAnOrganization(event.incomingOrgId);
      const userIds = [...new Set(members.map((m) => m.user.id))];
      if (userIds.length === 0) return;

      const delayLabel = formatMilliseconds(event.delayMs) || 'a short time';

      await this.notifications.publish({
        type: 'deployment.interruption.queued',
        idempotencyKey: `interruption-queued:${event.incomingOrgId}:${event.deviceId}:${event.delayMs}`,
        userIds,
        organizationId: event.incomingOrgId,
        title: 'Interruption request queued',
        body: `Your interruption request has been issued. Provisioning of ${event.deploymentName} (device ${event.deviceId}) will begin in approximately ${delayLabel}.`,
        channels: { inApp: true, email: true },
      });
    } catch (error) {
      this.logger.warn(`Failed to publish deployment.interruption.queued notification: ${getErrorMessage(error)}`);
    }
  }
}
