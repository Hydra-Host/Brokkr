import { Injectable } from '@nestjs/common';
import { ZoneAddressType } from '@repo/database';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { parseBoundaryOrEmpty, resolveRegionForPoint, type RegionShape } from './geo';

interface LoadedRegion extends RegionShape {
  slug: string;
  priority: number;
}

@Injectable()
export class RegionAssignmentService {
  constructor(
    private readonly prisma: PrismaClient,
    @Logger(RegionAssignmentService.name) private readonly logger: LoggerService,
  ) {}

  async loadRegions(): Promise<LoadedRegion[]> {
    const rows = await this.prisma.region.findMany({ orderBy: { priority: 'asc' } });
    const loaded: LoadedRegion[] = [];
    for (const row of rows) {
      loaded.push({
        id: row.id,
        slug: row.slug,
        priority: row.priority,
        centroid: [row.centroidLng, row.centroidLat],
        boundary: parseBoundaryOrEmpty(row.boundary, () =>
          this.logger.error(
            `Region ${row.slug} has an invalid boundary geometry; excluding it from point-in-polygon but keeping it for the centroid fallback`,
          ),
        ),
      });
    }
    return loaded;
  }

  async assignZone(zoneId: string, regions?: LoadedRegion[]): Promise<string | null> {
    const loaded = regions ?? (await this.loadRegions());
    const zone = await this.prisma.zone.findUnique({
      where: { id: zoneId },
      select: {
        regionId: true,
        addresses: {
          where: { type: ZoneAddressType.PRIMARY, deletedAt: null },
          select: { latitude: true, longitude: true },
          take: 1,
        },
      },
    });

    if (!zone) return null;

    const address = zone.addresses[0];
    const regionId =
      address?.latitude != null && address?.longitude != null
        ? resolveRegionForPoint(address.longitude, address.latitude, loaded)
        : null;
    if (regionId !== zone.regionId) {
      await this.prisma.zone.update({ where: { id: zoneId }, data: { regionId } });
    }
    return regionId;
  }

  async assignZoneSafe(zoneId: string): Promise<void> {
    try {
      await this.assignZone(zoneId);
    } catch (error) {
      this.logger.error(`Failed to assign region for zone ${zoneId}: ${getErrorMessage(error)}`);
    }
  }

  async recomputeAllZones(): Promise<{ total: number; assigned: number; unassigned: number }> {
    const regions = await this.loadRegions();
    const zones = await this.prisma.zone.findMany({
      where: { deletedAt: null },
      select: {
        id: true,
        regionId: true,
        addresses: {
          where: { type: ZoneAddressType.PRIMARY, deletedAt: null },
          select: { latitude: true, longitude: true },
          take: 1,
        },
      },
    });

    let assigned = 0;
    let unassigned = 0;
    const writes = [];
    for (const zone of zones) {
      const address = zone.addresses[0];
      const regionId =
        address?.latitude != null && address?.longitude != null
          ? resolveRegionForPoint(address.longitude, address.latitude, regions)
          : null;
      if (regionId !== zone.regionId) {
        writes.push(this.prisma.zone.update({ where: { id: zone.id }, data: { regionId } }));
      }
      if (regionId) assigned++;
      else unassigned++;
    }
    if (writes.length > 0) await this.prisma.$transaction(writes);
    return { total: zones.length, assigned, unassigned };
  }
}
