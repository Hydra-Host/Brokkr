import { PLUGIN_EVENT_BUS, type PluginEventBus } from '@hydrahost/plugin-sdk';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Deployment, DeploymentLifecycleActionType } from '@repo/database';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { EmailService } from 'src/email/email.service';
import { LoggerService } from 'src/logger/logger.service';
import { StatusTransitionType } from '../device-status-effects/transitions';
import { DeviceNotificationsRepository } from './device-notifications.repository';
import { DeviceWithSupplierAndDeployment, SupplierWithMembersAndUsers } from './device-notifications.types';

@Injectable()
export class DeviceNotificationsService {
  private readonly hydraHostEnv: string;

  constructor(
    private readonly emailService: EmailService,
    private readonly deviceNotificationsRepo: DeviceNotificationsRepository,
    private readonly configService: ConfigService,
    @Inject(PLUGIN_EVENT_BUS)
    private readonly eventBus: PluginEventBus,
    @Logger(DeviceNotificationsService.name)
    private readonly logger: LoggerService,
  ) {
    // HH_ENV is unset on self-hosted BOSS — default (not getOrThrow) so boot can't crash; non-'prod' skips managed notifications.
    this.hydraHostEnv = this.configService.get<string>('HH_ENV') ?? 'local';
  }

  async handleStatusTransitionNotification(statusTransition: StatusTransitionType, deviceId: string) {
    if (this.hydraHostEnv !== 'prod') {
      return;
    }

    switch (statusTransition) {
      case StatusTransitionType.InventorySuccess:
        return this.sendDeviceInInventoryEmail(deviceId);
      case StatusTransitionType.ProvisionSuccess:
        return this.sendDeviceProvisionSuccessEmail(deviceId);
      case StatusTransitionType.FailedStatus:
        return this.handleDeviceFailure(deviceId);
      default:
        return;
    }
  }

  async sendDeviceInInventoryEmail(deviceId: string) {
    const deviceAndSupplier = await this.deviceNotificationsRepo.getDeviceWithSupplierAndDeployment(deviceId);

    const supplier = deviceAndSupplier?.device.supplier;
    const deployment = deviceAndSupplier?.device.deployments[0];

    if (!supplier || deployment) {
      return;
    }

    const emails = this.extractSupplierEmails(supplier);
    const primaryIp = this.getPrimaryIp(deviceAndSupplier);

    await this.emailService.send.supplierDeviceInInventory({
      emails,
      orgName: supplier.name,
      deviceId: deviceAndSupplier.deviceId,
      primaryIp,
    });
  }

  async sendDeviceProvisionSuccessEmail(deviceId: string) {
    const deviceAndSupplier = await this.deviceNotificationsRepo.getDeviceWithSupplierAndDeployment(deviceId);

    const supplier = deviceAndSupplier?.device.supplier;
    const deployment = deviceAndSupplier?.device.deployments[0];

    if (!supplier || !deployment) {
      return;
    }

    if (this.isReprovision(deployment)) {
      return;
    }

    const reservationType = this.determineReservationType(deployment, supplier);
    const emails = this.extractSupplierEmails(supplier);

    const primaryIp = this.getPrimaryIp(deviceAndSupplier);

    await this.emailService.send.supplierDeviceProvisionSuccess({
      emails,
      orgName: supplier.name,
      deviceId: deviceAndSupplier.deviceId,
      primaryIp,
      reservationType,
    });
  }

  async handleDeviceFailure(deviceId: string) {
    try {
      const deviceAndSupplier = await this.deviceNotificationsRepo.getDeviceWithSupplierAndDeployment(deviceId);

      if (!deviceAndSupplier) {
        this.logger.warn(`Device not found for ID: ${deviceId}`);
        return;
      }

      const activeDeployment = deviceAndSupplier.device.deployments[0] ?? null;
      const primaryIp = this.getPrimaryIp(deviceAndSupplier);

      this.eventBus.emit('device.failed', {
        deviceId,
        deviceName: deviceAndSupplier.device.name,
        primaryIp: primaryIp === 'N/A' ? null : primaryIp,
        deployment: activeDeployment
          ? {
              id: activeDeployment.id,
              customerOrganizationId: activeDeployment.customerId,
              operatingSystemName: activeDeployment.baseLayer?.name ?? null,
              deployer: {
                email: activeDeployment.deployer.email,
                firstName: activeDeployment.deployer.firstName,
                lastName: activeDeployment.deployer.lastName,
              },
            }
          : null,
      });

      this.logger.log(`Emitted device.failed for device: ${deviceId}`);
    } catch (error) {
      this.logger.error(`Failed to handle device failure for device ${deviceId}`, getErrorMessage(error));
    }
  }

  private determineReservationType(
    deployment: Deployment,
    supplier: SupplierWithMembersAndUsers,
  ): 'Self-Provisioned' | 'Customer Rental' {
    return deployment.customerId === supplier.id ? 'Self-Provisioned' : 'Customer Rental';
  }

  private extractSupplierEmails(supplier: SupplierWithMembersAndUsers): string[] {
    return supplier.members.map((membership) => membership.user.email);
  }

  private getPrimaryIp(deviceAndSupplier: DeviceWithSupplierAndDeployment): string {
    return deviceAndSupplier.primaryIp4 ?? deviceAndSupplier.primaryIp6 ?? 'N/A';
  }

  private isReprovision(deployment: DeviceWithSupplierAndDeployment['device']['deployments'][number]): boolean {
    return (
      deployment.lifecycleActions &&
      deployment.lifecycleActions.length > 0 &&
      deployment.lifecycleActions[0].actionType === DeploymentLifecycleActionType.Reprovision
    );
  }
}
