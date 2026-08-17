import { Injectable, NotFoundException } from '@nestjs/common';
import { CreateDeviceDiagnosticsRequest } from '@repo/api-client';
import { DeviceTokenContext, ServerLifecycleStatus, ServerPowerStatus } from '@repo/database';
import { serverLifecycleToSlug, statusSlugToServerLifecycle } from '@repo/device-domain';
import { getTelemetryMeter } from '@repo/telemetry';
import { BridgeInventoryCollectionService } from 'src/brokkr-bridge/lifecycle/inventory-collection.service';
import { QualifyOrchestrationService } from 'src/brokkr-bridge/lifecycle/qualify-orchestration.service';
import { ContextService } from 'src/common/context/context.service';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LifecycleInboundService } from 'src/lifecycle/inbound/lifecycle-inbound.service';
import { LoggerService } from 'src/logger/logger.service';
import { createDeviceLifecycleTransitionsCounter } from 'src/telemetry/domain-metrics';
import { PhoneHomeRepository } from './phone-home.repository';
import type { DeviceAggregate } from './phone-home.types';

@Injectable()
export class PhoneHomeService {
  // No-op meters when telemetry/metrics are off. Labels are low-cardinality by
  // construction: token-context and lifecycle-status enums.
  private readonly phoneHomesProcessed = getTelemetryMeter('brokkr-hub').createCounter('brokkr.phone_home.processed', {
    description: 'Phone-home callbacks processed, by token context and resulting status',
  });
  private readonly lifecycleTransitions = createDeviceLifecycleTransitionsCounter();

  constructor(
    @Logger(PhoneHomeService.name) private readonly logger: LoggerService,
    private readonly phoneHomeRepository: PhoneHomeRepository,
    private readonly qualifyOrchestration: QualifyOrchestrationService,
    private readonly bridgeInventoryCollection: BridgeInventoryCollectionService,
    private readonly lifecycleInbound: LifecycleInboundService,
    private readonly contextService: ContextService,
  ) {
    // Pre-register the alerted-on series at zero: increase()/rate() can't see a series' birth, so
    // without this the first FAILED transition after a hub restart never fires the saga-failures alert.
    this.lifecycleTransitions.add(0, { to_status: ServerLifecycleStatus.FAILED, source: 'phone_home' });
  }

  async createDeviceDiagnostics(deviceId: string, data: CreateDeviceDiagnosticsRequest) {
    const device = await this.phoneHomeRepository.getDeviceByUuid(deviceId);
    if (!device) {
      throw new NotFoundException(`Device with ID ${deviceId} not found`);
    }

    return this.phoneHomeRepository.createDeviceDiagnostics(deviceId, data);
  }

  async execute(deviceId: string) {
    this.logger.log(`Processing phone home for device ${deviceId}`);

    const device = await this.phoneHomeRepository.getDeviceByUuid(deviceId);
    if (!device) {
      throw new NotFoundException('Device not found');
    }

    const updatedDeviceStatus = await this.parseDeviceStatusUpdate(device);
    // Phone-home proves the device is running regardless of bridge-reported power. The conditional write
    // reports whether the status actually changed, so concurrent/same-status re-phones don't double-count.
    const { transitioned } = await this.phoneHomeRepository.updateDevice(
      device.id,
      updatedDeviceStatus,
      ServerPowerStatus.On,
    );

    // Slug→enum conversion cannot throw here: updateDevice already applied it.
    const writtenLifecycleStatus = statusSlugToServerLifecycle(updatedDeviceStatus);
    if (transitioned) {
      this.lifecycleTransitions.add(1, { to_status: writtenLifecycleStatus, source: 'phone_home' });
    }
    this.phoneHomesProcessed.add(1, {
      token_context: this.contextService.deviceIdentity?.context ?? 'unknown',
      resulting_status: updatedDeviceStatus,
    });

    if (updatedDeviceStatus === 'provisioned') {
      await this.qualifyOrchestration.handleDeviceProvisioned(device.id);
      await this.lifecycleInbound.applyPhoneHome(device.id);
    }

    await this.maybeEnqueueDiscovery(device, updatedDeviceStatus);

    return { deviceId };
  }

  private async maybeEnqueueDiscovery(device: DeviceAggregate, updatedStatus: string) {
    if (updatedStatus !== 'inventory') {
      return;
    }

    const zoneId = device.zoneId;
    if (!zoneId) {
      this.logger.warn(`Cannot enqueue discovery for device ${device.id}: no zoneId assigned`);
      return;
    }

    try {
      await this.bridgeInventoryCollection.startInventoryCollection(device.id, zoneId, 'phone-home');
      this.logger.log(`Phone-home triggered discovery for device ${device.id} (inventory)`);
    } catch (error) {
      this.logger.warn(`Failed to enqueue phone-home discovery for device ${device.id}: ${getErrorMessage(error)}`);
    }
  }

  private async parseDeviceStatusUpdate(device: DeviceAggregate) {
    const tokenContext = this.contextService.deviceIdentity?.context ?? null;
    const lifecycle = device.server?.lifecycleStatus ?? null;
    switch (lifecycle) {
      case ServerLifecycleStatus.PROVISIONING:
        return tokenContext === DeviceTokenContext.BROKKR_LIVE ? 'provisioning' : 'provisioned';
      case ServerLifecycleStatus.OFFLINE: {
        const hasActiveDeployment = await this.phoneHomeRepository.hasActiveDeployment(device.id);
        if (hasActiveDeployment && tokenContext === DeviceTokenContext.BROKKR_LIVE) {
          return 'offline';
        }
        return hasActiveDeployment ? 'provisioned' : 'inventory';
      }
      case ServerLifecycleStatus.DEPROVISIONING:
        if (tokenContext === DeviceTokenContext.DEPLOYMENT_OS || tokenContext === null) {
          this.logger.warn(
            `Deployed-OS phone-home for device ${device.id} while DEPROVISIONING — ` +
              `the provisioned OS booted again (deprovision wipe likely failed)`,
          );
          return 'failed';
        }
        return 'deprovisioning';
      default: {
        if (lifecycle) return serverLifecycleToSlug(lifecycle);
        const hasActiveDeployment = await this.phoneHomeRepository.hasActiveDeployment(device.id);
        return hasActiveDeployment ? 'provisioned' : 'inventory';
      }
    }
  }
}
