import { Injectable } from '@nestjs/common';
import { Prisma } from '@repo/database';
import { Logger } from 'src/common/decorators/logger.decorator';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import type { IpxeIdentifierBundle } from '../types/render-request.types';

const deviceResolverSelect = {
  id: true,
} as const satisfies Prisma.DeviceSelect;

export type ResolvedDeviceRow = Prisma.DeviceGetPayload<{ select: typeof deviceResolverSelect }>;

export type DeviceResolution =
  | {
      kind: 'known';
      device: ResolvedDeviceRow;
      matchedOn: keyof IpxeIdentifierBundle;
    }
  | { kind: 'pending' };

// Tombstoned rows must miss (the dispatcher mints a placeholder instead); deliberately no status filter — DEPROVISIONING must still resolve so the wipe target boots.
const deviceActiveFilter: Prisma.DeviceWhereInput = {
  deletedAt: null,
};
const deviceResolverOrderBy: Prisma.DeviceOrderByWithRelationInput = { createdAt: 'desc' };

@Injectable()
export class DeviceResolverService {
  constructor(
    private readonly prisma: PrismaClient,
    @Logger(DeviceResolverService.name) private readonly logger: LoggerService,
  ) {}

  async resolve(bundle: IpxeIdentifierBundle): Promise<DeviceResolution> {
    const macHit = await this.byMac(bundle.mac);
    if (macHit) return { kind: 'known', device: macHit, matchedOn: 'mac' };

    const ipmiHit = await this.byMac(bundle.ipmi_mac);
    if (ipmiHit) return { kind: 'known', device: ipmiHit, matchedOn: 'ipmi_mac' };

    const uuidHit = await this.byUuid(bundle.system_uuid);
    if (uuidHit) return { kind: 'known', device: uuidHit, matchedOn: 'system_uuid' };

    const serialHit = await this.bySerial(bundle.serial);
    if (serialHit) return { kind: 'known', device: serialHit, matchedOn: 'serial' };

    const chassisHit = await this.byChassisSerial(bundle.chassis_serial);
    if (chassisHit) return { kind: 'known', device: chassisHit, matchedOn: 'chassis_serial' };

    const boardHit = await this.byBoardSerial(bundle.board_serial);
    if (boardHit) return { kind: 'known', device: boardHit, matchedOn: 'board_serial' };

    return { kind: 'pending' };
  }

  private async byMac(mac: string | undefined): Promise<ResolvedDeviceRow | null> {
    if (!mac) return null;
    const normalized = normalizeMacForPrisma(mac);
    return this.findFirstActive(
      {
        AND: [
          deviceActiveFilter,
          { interfaces: { some: { macAddress: { equals: normalized, mode: 'insensitive' }, deletedAt: null } } },
        ],
      },
      `mac=${normalized}`,
    );
  }

  private async byUuid(uuid: string | undefined): Promise<ResolvedDeviceRow | null> {
    if (!uuid) return null;
    return this.findFirstActive(
      { AND: [deviceActiveFilter, { systemUuid: { equals: uuid, mode: 'insensitive' } }] },
      `systemUuid=${uuid}`,
    );
  }

  private async bySerial(serial: string | undefined): Promise<ResolvedDeviceRow | null> {
    if (!serial) return null;
    return this.findFirstActive(
      { AND: [deviceActiveFilter, { serial: { equals: serial, mode: 'insensitive' } }] },
      `serial=${serial}`,
    );
  }

  private async byChassisSerial(serial: string | undefined): Promise<ResolvedDeviceRow | null> {
    if (!serial) return null;
    return this.findFirstActive(
      { AND: [deviceActiveFilter, { chassisSerial: { equals: serial, mode: 'insensitive' } }] },
      `chassisSerial=${serial}`,
    );
  }

  private async byBoardSerial(serial: string | undefined): Promise<ResolvedDeviceRow | null> {
    if (!serial) return null;
    return this.findFirstActive(
      { AND: [deviceActiveFilter, { baseboardSerial: { equals: serial, mode: 'insensitive' } }] },
      `baseboardSerial=${serial}`,
    );
  }

  private async findFirstActive(where: Prisma.DeviceWhereInput, matchLabel: string): Promise<ResolvedDeviceRow | null> {
    const rows = await this.prisma.device.findMany({
      where,
      select: deviceResolverSelect,
      orderBy: deviceResolverOrderBy,
      take: 2,
    });
    if (rows.length === 0) return null;
    if (rows.length > 1) {
      this.logger.warn(
        `Multiple active devices matched ${matchLabel}; returning most recently created (id=${rows[0].id}). ` +
          `Investigate duplicate hardware records.`,
      );
    }
    return rows[0];
  }
}

function normalizeMacForPrisma(mac: string): string {
  return mac.toLowerCase().replace(/-/g, ':');
}
