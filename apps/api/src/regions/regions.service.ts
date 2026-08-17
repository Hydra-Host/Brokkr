import { Injectable } from '@nestjs/common';
import { GeoJsonMultiPolygonSchema, type RegionResponse } from '@repo/api-client';
import { Logger } from 'src/common/decorators/logger.decorator';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { loadRegionSeeds } from './region-seed';

@Injectable()
export class RegionsService {
  constructor(
    private readonly prisma: PrismaClient,
    @Logger(RegionsService.name) private readonly logger: LoggerService,
  ) {}

  async list(): Promise<RegionResponse[]> {
    const regions = await this.prisma.region.findMany({ orderBy: { priority: 'asc' } });
    return regions.map((region) => {
      const parsed = GeoJsonMultiPolygonSchema.safeParse(region.boundary);
      if (!parsed.success) {
        this.logger.error(`Region ${region.slug} has an invalid boundary geometry; returning an empty boundary`);
      }
      return {
        id: region.id,
        slug: region.slug,
        name: region.name,
        description: region.description,
        color: region.color,
        centroidLat: region.centroidLat,
        centroidLng: region.centroidLng,
        boundary: parsed.success ? parsed.data : { type: 'MultiPolygon', coordinates: [] },
      };
    });
  }

  async seedRegionsIfEmpty(): Promise<number> {
    if ((await this.prisma.region.count()) > 0) return 0;

    const seeds = loadRegionSeeds();
    const writes = seeds.map((seed) => {
      const data = {
        name: seed.name,
        description: seed.description ?? null,
        boundary: seed.boundary,
        centroidLat: seed.centroidLat,
        centroidLng: seed.centroidLng,
        priority: seed.priority,
        color: seed.color ?? null,
      };
      return this.prisma.region.upsert({
        where: { slug: seed.slug },
        create: { slug: seed.slug, ...data },
        update: data,
      });
    });
    await this.prisma.$transaction(writes);
    return seeds.length;
  }
}
