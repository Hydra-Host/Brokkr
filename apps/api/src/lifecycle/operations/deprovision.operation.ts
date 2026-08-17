import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DeviceTokenRevocationReason } from '@repo/database';
import { BridgeDeprovisionService } from 'src/brokkr-bridge/lifecycle/deprovision.service';
import { LifecyclePreparationService } from 'src/brokkr-bridge/lifecycle/lifecycle-preparation.service';
import { DeploymentRecord } from 'src/deployments/deployment.record';
import { DeviceTokensService } from 'src/device-tokens/device-tokens.service';
import { ReservationRecord } from 'src/reservations/reservation.record';

export interface DeprovisionContext {
  deploymentId: string;
}

@Injectable()
export class DeprovisionOperation {
  constructor(
    private readonly lifecyclePrep: LifecyclePreparationService,
    private readonly bridgeDeprovision: BridgeDeprovisionService,
    private readonly deviceTokensService: DeviceTokensService,
  ) {}

  async assembleContext(deviceId: string, organizationId: string): Promise<DeprovisionContext> {
    const aggregate = await DeploymentRecord.findAggregateUnscoped({
      where: { endDate: null, server: { deviceId }, customerId: organizationId },
    });
    if (!aggregate) {
      throw new NotFoundException('No active deployment to deprovision for this device');
    }
    return { deploymentId: aggregate.id };
  }

  /** Wipe-only path: re-check at dispatch so a rental that raced in after request gating cannot be wiped open. */
  async dispatchWithoutDeployment(params: { deviceId: string; jobId: string }): Promise<void> {
    const existing = await DeploymentRecord.findAggregateUnscoped({
      where: { endDate: null, server: { deviceId: params.deviceId } },
    });
    if (existing) {
      throw new BadRequestException('Device has an active deployment — end the rental instead of deprovisioning it');
    }

    await this.lifecyclePrep.prepareForDeprovision(params.deviceId, params.jobId);
    await this.bridgeDeprovision.deprovisionDevice(params.deviceId, params.jobId);
  }

  async dispatch(params: {
    deviceId: string;
    organizationId: string;
    deploymentId: string;
    jobId: string;
  }): Promise<void> {
    const record: DeploymentRecord | null = await DeploymentRecord.findOneUnscoped({
      where: { id: params.deploymentId, customerId: params.organizationId, endDate: null },
    });

    if (!record) {
      await this.deviceTokensService.revokeDeploymentTokensForDevice(
        params.deviceId,
        DeviceTokenRevocationReason.DEPLOYMENT_ENDED,
        `Deployment missing during deprovision job ${params.jobId}`,
      );
      throw new NotFoundException('No active deployment to deprovision for this device');
    }
    if (record.data.isLocked) {
      throw new BadRequestException('Cannot deprovision a locked deployment');
    }

    await this.lifecyclePrep.prepareForDeprovision(params.deviceId, params.jobId);
    await this.bridgeDeprovision.deprovisionDevice(params.deviceId, params.jobId);

    await this.deviceTokensService.runWithDeploymentTokenRevocation(
      {
        deviceId: params.deviceId,
        reason: DeviceTokenRevocationReason.DEPLOYMENT_ENDED,
        note: `Deployment ended by deprovision job ${params.jobId}`,
      },
      async (tx) => {
        record.endDeployment();
        await record.save({ tx });
        if (record.data.reservationId) {
          await ReservationRecord.endActiveByIdUnscoped(record.data.reservationId, tx);
        }
      },
    );
  }
}
