import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { OperatingSystemSlug } from '@repo/api-client';
import { type Layer, LayerKind, ServerLifecycleStatus } from '@repo/database';
import { LayerRecord } from '@repo/layers';
import { PrismaClient } from 'src/prisma/prisma.client';

const logger = new Logger('LifecycleRepository');

export function assertInstallableLayer(layer: Pick<Layer, 'kind'>, slug: string): void {
  if (layer.kind !== LayerKind.BASE && layer.kind !== LayerKind.LEGACY) {
    logger.warn(`assertInstallableLayer: slug=${slug} kind=${layer.kind}`);
    throw new BadRequestException(`Operating system ${slug} is not installable`);
  }
}

@Injectable()
export class LifecycleRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async fetchReprovisionableDevice(
    deviceId: string,
    sshKeyIds: string[],
    operatingSystemSlug: OperatingSystemSlug,
    organizationId: string,
  ) {
    const [device, sshKeys] = await this.prisma.$transaction([
      this.prisma.device.findUnique({
        where: { id: deviceId },
        include: {
          server: {
            include: {
              deployments: { where: { endDate: null }, include: { customer: true } },
            },
          },
          storageDrives: true,
        },
      }),
      this.prisma.sshKeys.findMany({
        where: {
          id: { in: sshKeyIds },
          dateDeleted: null,
          user: { members: { some: { organizationId, deletedAt: null } } },
        },
      }),
    ]);
    const baseLayer = await LayerRecord.findBySlug(operatingSystemSlug);

    return { device, sshKeys, baseLayer };
  }

  async fetchProvisionableDevice(
    deviceId: string,
    sshKeyIds: string[],
    operatingSystemSlug: OperatingSystemSlug,
    organizationId: string,
  ) {
    const [device, sshKeys] = await this.prisma.$transaction([
      this.prisma.device.findUnique({
        where: {
          id: deviceId,
          server: {
            lifecycleStatus: ServerLifecycleStatus.INVENTORY,
            deployments: { none: { endDate: null } },
          },
        },
        include: { storageDrives: true },
      }),
      this.prisma.sshKeys.findMany({
        where: {
          id: { in: sshKeyIds },
          dateDeleted: null,
          user: { members: { some: { organizationId, deletedAt: null } } },
        },
      }),
    ]);
    const baseLayer = await LayerRecord.findBySlug(operatingSystemSlug);

    return { device, sshKeys, baseLayer };
  }

  async fetchSshPublicKeys(sshKeyIds: string[], organizationId: string): Promise<string[]> {
    const keys = await this.prisma.sshKeys.findMany({
      where: {
        id: { in: sshKeyIds },
        dateDeleted: null,
        user: { members: { some: { organizationId, deletedAt: null } } },
      },
      select: { key: true },
    });
    return keys.map((k) => k.key);
  }

  async fetchStorageDrives(deviceId: string) {
    return this.prisma.storageDrive.findMany({ where: { deviceId } });
  }
}
