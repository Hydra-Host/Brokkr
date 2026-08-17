import { Injectable } from '@nestjs/common';
import { ServerPowerStatus } from '@repo/database';
import { BridgePowerControlService } from 'src/brokkr-bridge/lifecycle/power-control.service';
import { PrismaClient } from 'src/prisma/prisma.client';

@Injectable()
export class RebootOperation {
  constructor(
    private readonly bridgePowerControl: BridgePowerControlService,
    private readonly prisma: PrismaClient,
  ) {}

  async dispatch(deviceId: string, jobId: string): Promise<void> {
    await this.prisma.device.update({
      where: { id: deviceId },
      data: {
        lastJobId: jobId,
        server: {
          upsert: {
            create: { powerStatus: ServerPowerStatus.Rebooting },
            update: { powerStatus: ServerPowerStatus.Rebooting },
          },
        },
      },
    });
    await this.bridgePowerControl.rebootDevice(deviceId, jobId);
  }
}
