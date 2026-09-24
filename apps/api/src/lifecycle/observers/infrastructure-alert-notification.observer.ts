import { HOST_PLUGIN_ID, PLUGIN_EVENT_BUS, type BrokkrEventMap, type PluginEventBus } from '@hydrahost/plugin-sdk';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { findZoneSupplierRecipients } from '@repo/utils';
import { getErrorMessage } from 'src/common/error-utils';
import 'src/events/brokkr-events.types';
import { NotificationService } from 'src/notifications/notification.service';
import { PrismaClient } from 'src/prisma/prisma.client';

@Injectable()
export class InfrastructureAlertNotificationObserver implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InfrastructureAlertNotificationObserver.name);
  private readonly unsubscribers: Array<() => void> = [];

  constructor(
    @Inject(PLUGIN_EVENT_BUS) private readonly eventBus: PluginEventBus,
    private readonly notifications: NotificationService,
    private readonly prisma: PrismaClient,
  ) {}

  onModuleInit(): void {
    const opts = { pluginId: HOST_PLUGIN_ID };
    this.unsubscribers.push(
      this.eventBus.on('device.failed', (e) => this.handleDeviceFailed(e), opts),
      this.eventBus.on('zone.alert', (e) => this.handleZoneAlert(e), opts),
      this.eventBus.on('bridge.alert', (e) => this.handleBridgeAlert(e), opts),
    );
  }

  onModuleDestroy(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
  }

  private async handleDeviceFailed(event: BrokkrEventMap['device.failed']): Promise<void> {
    try {
      const deployment = event.deployment;
      if (!deployment) return;

      const user = await this.prisma.user.findUnique({
        where: { email: deployment.deployer.email },
        select: { id: true },
      });
      if (!user) {
        this.logger.warn(`Skipping device.failed notification: no user for deployer email on device ${event.deviceId}`);
        return;
      }

      await this.notifications.publish({
        type: 'device.failed',
        idempotencyKey: `device-failed:${event.deviceId}:${deployment.id}`,
        userIds: [user.id],
        organizationId: deployment.customerOrganizationId,
        title: 'Device failed',
        body: `Device ${event.deviceName} reported a failure while deployed.`,
        href: `/deployments/${deployment.id}`,
        channels: { inApp: true, email: true },
      });
    } catch (error) {
      this.logger.warn(`Failed to publish device.failed notification: ${getErrorMessage(error)}`);
    }
  }

  private async handleZoneAlert(event: BrokkrEventMap['zone.alert']): Promise<void> {
    try {
      const recipients = await this.recipientsForZone(event.zoneId);
      if (recipients.userIds.length === 0) return;

      await this.notifications.publish({
        type: 'zone.alert',
        idempotencyKey: `zone-alert:${event.zoneId}:${event.lastHeartbeatAt.toISOString()}`,
        userIds: recipients.userIds,
        organizationId: recipients.organizationId,
        title: 'Zone offline',
        body: `Zone ${event.zoneName} is offline. Last heartbeat ${event.lastHeartbeatAt.toISOString()} (${event.timeSinceHeartbeatSeconds}s ago). ${event.deviceCount} devices, ${event.activeRentalsCount} active rentals.`,
        href: `/dcim/zones/${event.zoneId}`,
        channels: { inApp: true, email: true },
      });
    } catch (error) {
      this.logger.warn(`Failed to publish zone.alert notification: ${getErrorMessage(error)}`);
    }
  }

  private async handleBridgeAlert(event: BrokkrEventMap['bridge.alert']): Promise<void> {
    try {
      if (!event.zoneId) {
        this.logger.warn(`Skipping bridge.alert notification: missing zoneId for device ${event.deviceId}`);
        return;
      }

      const recipients = await this.recipientsForZone(event.zoneId);
      if (recipients.userIds.length === 0) return;

      await this.notifications.publish({
        type: 'bridge.alert',
        idempotencyKey: `bridge-alert:${event.deviceId}:${event.lastSeenAt.toISOString()}`,
        userIds: recipients.userIds,
        organizationId: recipients.organizationId,
        title: 'Bridge offline',
        body: `Bridge ${event.instanceId} in zone ${event.zoneName} is offline. Last seen ${event.lastSeenAt.toISOString()} (${event.timeSinceLastSeenSeconds}s ago).`,
        href: `/dcim/zones/${event.zoneId}`,
        channels: { inApp: true, email: true },
      });
    } catch (error) {
      this.logger.warn(`Failed to publish bridge.alert notification: ${getErrorMessage(error)}`);
    }
  }

  private recipientsForZone(zoneId: string) {
    return findZoneSupplierRecipients(
      zoneId,
      (args) => this.prisma.device.findMany(args),
      (args) => this.prisma.member.findMany(args),
    );
  }
}
