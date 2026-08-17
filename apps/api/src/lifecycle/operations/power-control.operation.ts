import { Injectable } from '@nestjs/common';
import { ServerPowerStatus } from '@repo/database';
import { BridgePowerControlService } from 'src/brokkr-bridge/lifecycle/power-control.service';
import { PrismaClient } from 'src/prisma/prisma.client';

@Injectable()
export class PowerControlOperation {
  constructor(
    private readonly bridgePowerControl: BridgePowerControlService,
    private readonly prisma: PrismaClient,
  ) {}

  async dispatch(deviceId: string, jobId: string, operation: 'on' | 'off'): Promise<void> {
    const powerStatus = operation === 'on' ? ServerPowerStatus.PoweringOn : ServerPowerStatus.PoweringOff;
    await this.prisma.device.update({
      where: { id: deviceId },
      data: { lastJobId: jobId, server: { upsert: { create: { powerStatus }, update: { powerStatus } } } },
    });

    if (operation === 'on') {
      await this.bridgePowerControl.powerOnDevice(deviceId, jobId);
    } else {
      await this.bridgePowerControl.powerOffDevice(deviceId, jobId);
    }
  }
}
