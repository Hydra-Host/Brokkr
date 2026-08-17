import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DeviceSecretActorType, DeviceSecretKind, DeviceSecretPurpose, Prisma } from '@repo/database';
import { DeviceSpecHelper } from '@repo/device-domain';
import type { DeviceSecretActor } from 'src/device-secret/device-secret-audit.service';
import { DeviceSecretService, type SealedSecretEnvelope } from 'src/device-secret/device-secret.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { isValidIpv4 } from 'src/utils/ip';

export function extractBmcIp(raw: string): string | null {
  for (const part of raw.split(',')) {
    const ip = part.trim().split('/')[0];
    const { isValid } = isValidIpv4(ip);
    if (isValid) {
      return ip;
    }
  }
  return null;
}

export const deviceContextSelect = {
  id: true,
  zoneId: true,
  ipmiBootDeviceOverride: true,
  architecture: true,
  cpus: { select: { architecture: true }, orderBy: { socketIndex: 'asc' as const } },
  supplier: { select: { id: true } },
  // netplanOverride on both: server-shaped devices carry the canonical value on `Server`, other
  // roles keep it on `Device`. Provision reads it to tell a sim-seeded override from a real render.
  netplanOverride: true,
  server: { select: { teeEnabled: true, teeCapable: true, netplanOverride: true } },
  interfaces: {
    where: { deletedAt: null },
    include: { ipAddresses: { where: { deletedAt: null } } },
  },
} as const satisfies Prisma.DeviceSelect;

export type DeviceContextRow = Prisma.DeviceGetPayload<{ select: typeof deviceContextSelect }>;

export interface DeviceContext {
  device: DeviceContextRow;
  zoneId: string;
  bmcIp: string;
  /** BMC credential sealed to the zone key — the hub can never decrypt it, only the zone bridge can. */
  bmcSecret: SealedSecretEnvelope;
}

export function bmcSecretDispatchFields(bmcSecret: SealedSecretEnvelope): { secrets: { bmc: SealedSecretEnvelope } } {
  return { secrets: { bmc: bmcSecret } };
}

export interface DeviceZoneContext {
  device: { id: string };
  zoneId: string;
}

@Injectable()
export class DeviceContextService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly deviceSecretService: DeviceSecretService,
  ) {}

  async resolve(deviceId: string): Promise<DeviceContext> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId, deletedAt: null },
      select: deviceContextSelect,
    });

    if (!device) {
      throw new BadRequestException(`Device ${deviceId} not found`);
    }

    return this.resolveFromDevice(device);
  }

  async resolveZoneContext(deviceId: string): Promise<DeviceZoneContext> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId, deletedAt: null },
      select: {
        id: true,
        zoneId: true,
        supplier: { select: { id: true } },
      },
    });

    if (!device) {
      throw new NotFoundException(`Device ${deviceId} not found`);
    }

    if (!device.zoneId) {
      throw new BadRequestException(`Device ${device.id} is not assigned to a zone`);
    }

    if (!device.supplier) {
      throw new BadRequestException(`Device ${device.id} has no supplier organization`);
    }

    return {
      device: { id: device.id },
      zoneId: device.zoneId,
    };
  }

  async resolveFromDevice(device: DeviceContextRow): Promise<DeviceContext> {
    const zoneId = device.zoneId;
    if (!zoneId) {
      throw new BadRequestException(`Device ${device.id} is not assigned to a zone`);
    }

    const bmcIp = DeviceSpecHelper.ipmiIp({ interfaces: device.interfaces });
    if (!bmcIp) {
      throw new BadRequestException(`Device ${device.id} has no IPv4 IPMI address on its management interface`);
    }

    if (!device.supplier) {
      throw new BadRequestException(`Device ${device.id} has no supplier organization`);
    }

    // Pinned to BMC/USER so a non-USER secret can never be dispatched; SYSTEM actor since the hub only forwards the sealed blob.
    const dispatchActor: DeviceSecretActor = { type: DeviceSecretActorType.SYSTEM, id: null };
    const bmcSecret = await this.deviceSecretService.getCurrentSealedByKind(
      device.id,
      DeviceSecretPurpose.BMC,
      DeviceSecretKind.USER,
      dispatchActor,
    );
    if (bmcSecret === null) {
      throw new BadRequestException(
        `Device ${device.id} has no usable BMC credential — store one via the BMC Secrets surface ` +
          `(none exists, or the current version was sealed to a superseded zone key and needs re-entry)`,
      );
    }

    return {
      device,
      zoneId,
      bmcIp,
      bmcSecret,
    };
  }
}
