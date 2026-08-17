import { Injectable, NotFoundException } from '@nestjs/common';
import { CreateDeviceDiagnosticsRequest } from '@repo/api-client';
import { Prisma, ServerPowerStatus } from '@repo/database';
import { statusSlugToServerLifecycle } from '@repo/device-domain';
import { PrismaClient } from 'src/prisma/prisma.client';

@Injectable()
export class PhoneHomeRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async getDeviceByUuid(deviceId: string) {
    return this.prisma.device.findUnique({
      where: {
        id: deviceId,
      },
      include: {
        supplier: true,
        server: { select: { lifecycleStatus: true } },
      },
    });
  }

  async hasActiveDeployment(deviceUuid: string): Promise<boolean> {
    const deployment = await this.prisma.deployment.findFirst({
      where: { server: { deviceId: deviceUuid }, endDate: null },
      select: { id: true },
    });
    return deployment !== null;
  }

  async createDeviceDiagnostics(deviceId: string, dto: CreateDeviceDiagnosticsRequest) {
    const deployment = await this.prisma.deployment.findFirst({
      where: { server: { device: { id: deviceId } }, endDate: null },
    });

    if (!deployment) {
      throw new NotFoundException('Deployment not found');
    }

    return this.prisma.deviceDiagnostics.create({
      data: {
        deployment: {
          connect: { id: deployment.id },
        },
        type: dto.type,
        data: dto.data as Prisma.InputJsonValue,
      },
    });
  }

  // Reports a real transition (status change OR first write); race-safe via unique-deviceId createMany +
  // conditional updateMany. The aux powerStatus write runs first so the status writes stay the final fallible ops.
  async updateDevice(
    deviceId: string,
    status: string,
    powerStatus?: ServerPowerStatus | null,
  ): Promise<{ transitioned: boolean }> {
    const lifecycleStatus = statusSlugToServerLifecycle(status);
    const serverData = { lifecycleStatus, ...(powerStatus ? { powerStatus } : {}) };

    if (powerStatus) {
      await this.prisma.server.updateMany({ where: { deviceId }, data: { powerStatus } });
    }
    const { count: created } = await this.prisma.server.createMany({
      data: [{ deviceId, ...serverData }],
      skipDuplicates: true,
    });
    let transitioned = created === 1;
    if (!transitioned) {
      // serverData (not just status): a row raced in between the aux write and createMany still gets
      // powerStatus on a status flip; a row already at this status self-heals on the next phone-home.
      const { count } = await this.prisma.server.updateMany({
        where: { deviceId, lifecycleStatus: { not: lifecycleStatus } },
        data: serverData,
      });
      transitioned = count === 1;
    }
    return { transitioned };
  }
}
