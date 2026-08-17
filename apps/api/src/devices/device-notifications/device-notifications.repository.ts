import { Injectable } from '@nestjs/common';
import { DeviceSpecHelper } from '@repo/device-domain';
import { PrismaClient } from 'src/prisma/prisma.client';

@Injectable()
export class DeviceNotificationsRepository {
  constructor(private readonly prismaService: PrismaClient) {}

  async getDeviceWithSupplierAndDeployment(deviceId: string) {
    const row = await this.prismaService.device.findUnique({
      where: { id: deviceId },
      include: {
        supplier: {
          include: {
            members: {
              where: {
                deletedAt: null,
                assignedRole: {
                  rolePermissions: { some: { permission: { resource: 'device', action: 'update' } } },
                },
              },
              include: {
                user: true,
              },
            },
          },
        },
        server: {
          include: {
            deployments: {
              where: {
                endDate: null,
              },
              include: {
                deployer: true,
                customer: true,
                baseLayer: true,
                lifecycleActions: {
                  orderBy: {
                    performedAt: 'desc',
                  },
                },
              },
            },
          },
        },
        interfaces: {
          where: { deletedAt: null },
          include: {
            ipAddresses: {
              where: { deletedAt: null },
              include: { natOutside: { where: { deletedAt: null }, select: { address: true } } },
            },
          },
        },
      },
    });

    if (!row) {
      return null;
    }

    const { server, ...deviceWithoutServer } = row;
    const device = { ...deviceWithoutServer, deployments: server?.deployments ?? [] };

    return {
      deviceId: device.id,
      primaryIp4: DeviceSpecHelper.ipv4(device) || null,
      primaryIp6: DeviceSpecHelper.ipv6(device) || null,
      device,
    };
  }
}
