import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { LayerRecord } from '@repo/layers';
import { randomUUID } from 'crypto';
import { DeviceContextService } from 'src/brokkr-bridge/device-context.service';
import { DeviceRecordPublisher } from 'src/brokkr-bridge/device-record/device-record-publisher.service';
import { BridgePowerControlService } from 'src/brokkr-bridge/lifecycle/power-control.service';
import { ServerTokenService } from 'src/brokkr-bridge/server-token/server-token.service';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { ConfigAtomWriter } from 'src/common/redis/config-atom-writer.service';
import { rescueSshKeys, TTL_RESCUE_SSH_KEYS_SECONDS } from 'src/common/redis/redis-keys';
import { LoggerService } from 'src/logger/logger.service';
import { DeploymentPresenter } from './deployment.presenter';
import type { DeploymentAggregate } from './types/deployments.types';

type RescueMutableRecord = {
  setRescueLayer: (rescueLayerId: string | null) => unknown;
  save: () => Promise<unknown>;
};

@Injectable()
export class RescueModeService {
  constructor(
    private readonly deviceContextService: DeviceContextService,
    private readonly configAtomWriter: ConfigAtomWriter,
    private readonly serverTokenService: ServerTokenService,
    private readonly deviceRecordPublisher: DeviceRecordPublisher,
    private readonly bridgePowerControlService: BridgePowerControlService,
    @Logger(RescueModeService.name) private readonly logger: LoggerService,
  ) {}

  async activate(opts: {
    deviceId: string;
    aggregate: DeploymentAggregate;
    record: RescueMutableRecord;
    rescueOsSlug: string;
    opLabel: string;
  }): Promise<void> {
    const { deviceId, aggregate, record, rescueOsSlug, opLabel } = opts;

    if (aggregate.isLocked) {
      throw new BadRequestException('Cannot activate rescue mode: deployment is locked');
    }
    if (!DeploymentPresenter.isRescueModeEligible(aggregate)) {
      throw new BadRequestException(
        'Cannot activate rescue mode: rescue mode is only available when the deployment is provisioned or failed',
      );
    }

    const rescueLayer = await LayerRecord.findBySlug(rescueOsSlug);
    if (!rescueLayer) {
      throw new NotFoundException('Rescue mode operating system not found');
    }
    if (aggregate.rescueLayer?.id === rescueLayer.id) {
      throw new BadRequestException('Device is already in requested mode');
    }

    const sshKeysStr = DeploymentPresenter.extractSshKeys(aggregate)
      .map((key) => key.key)
      .join('\n');
    const { zoneId } = await this.deviceContextService.resolveZoneContext(deviceId);
    await this.configAtomWriter.setString(zoneId, rescueSshKeys(deviceId), sshKeysStr, TTL_RESCUE_SSH_KEYS_SECONDS);

    record.setRescueLayer(rescueLayer.id);
    await record.save();

    await this.rebootIntoNewBootTarget(deviceId, opLabel);
  }

  async deactivate(opts: {
    deviceId: string;
    aggregate: Pick<DeploymentAggregate, 'isLocked' | 'rescueLayer'>;
    record: RescueMutableRecord;
    opLabel: string;
  }): Promise<void> {
    const { deviceId, aggregate, record, opLabel } = opts;

    if (!aggregate.rescueLayer) {
      throw new BadRequestException('Deployment is not in rescue mode');
    }
    if (aggregate.isLocked) {
      throw new BadRequestException('Cannot deactivate rescue mode: deployment is locked');
    }

    // Clear rescue OS before publishing/rebooting, else the stale rescue_os would be re-published.
    record.setRescueLayer(null);
    await record.save();

    try {
      const { zoneId } = await this.deviceContextService.resolveZoneContext(deviceId);
      await this.configAtomWriter.delKey(zoneId, rescueSshKeys(deviceId));
    } catch (error) {
      this.logger.warn(
        `Failed to delete rescue ssh_pub_keys for rescue deactivate of ${deviceId}: ${getErrorMessage(error)}`,
      );
    }

    await this.rebootIntoNewBootTarget(deviceId, opLabel);
  }

  private async rebootIntoNewBootTarget(deviceId: string, opLabel: string): Promise<void> {
    const rebootJobId = randomUUID();
    await this.serverTokenService.writeForDeviceBestEffort(deviceId, { requestId: rebootJobId, opLabel });

    try {
      const result = await this.deviceRecordPublisher.writeForDevice(deviceId, { requestId: rebootJobId });
      DeviceRecordPublisher.warnIfPublishSkipped(this.logger, result, opLabel, deviceId);
    } catch (error) {
      this.logger.warn(`Failed to publish device_record for ${opLabel} of ${deviceId}: ${getErrorMessage(error)}`);
    }

    await this.bridgePowerControlService.rebootDevice(deviceId, rebootJobId, { bootDevice: 'pxe' });
  }
}
