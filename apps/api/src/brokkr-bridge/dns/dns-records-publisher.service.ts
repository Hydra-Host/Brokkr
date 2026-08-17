import { Injectable } from '@nestjs/common';
import type { DnsRecordSource } from '@repo/database';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { DnsRecordsAtomSchema, type DnsRecordsAtom } from './dns-records-atom.schema';
import { DnsRecordsRedisWriterService } from './dns-records-redis-writer.service';

interface RecordRow {
  name: string;
  type: string;
  value: string;
  ttlOverride: number | null;
  source: DnsRecordSource;
}

function excludeAutoCollisions<T extends RecordRow>(records: T[]): T[] {
  const manualKeys = new Set<string>();
  for (const r of records) {
    if (r.source === 'MANUAL') {
      manualKeys.add(`${r.name.toLowerCase()}|${r.type}`);
    }
  }
  if (manualKeys.size === 0) return records;
  return records.filter((r) => r.source !== 'AUTO' || !manualKeys.has(`${r.name.toLowerCase()}|${r.type}`));
}

@Injectable()
export class DnsRecordsPublisherService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly writer: DnsRecordsRedisWriterService,
    @Logger(DnsRecordsPublisherService.name) private readonly logger: LoggerService,
  ) {}

  async republishForZone(zoneId: string): Promise<void> {
    try {
      const atom = await this.buildAtomForZone(zoneId);
      if (atom) {
        await this.writer.set(zoneId, atom);
      } else {
        await this.writer.clear(zoneId);
      }
    } catch (error) {
      this.logger.warn(
        `Eager DNS records republish failed for zone ${zoneId} (reconcile cron will heal): ${getErrorMessage(error)}`,
      );
    }
  }

  async publishAtom(zoneId: string, atom: DnsRecordsAtom): Promise<void> {
    await this.writer.set(zoneId, atom);
  }

  async clearAtom(zoneId: string): Promise<void> {
    await this.writer.clear(zoneId);
  }

  async buildAtomForZone(zoneId: string): Promise<DnsRecordsAtom | null> {
    const domains = await this.prisma.dnsDomain.findMany({
      where: { zoneId, deletedAt: null },
      select: {
        name: true,
        type: true,
        records: {
          where: { deletedAt: null },
          select: {
            name: true,
            type: true,
            value: true,
            ttlOverride: true,
            source: true,
          },
          orderBy: [{ name: 'asc' }, { type: 'asc' }, { value: 'asc' }],
        },
      },
      orderBy: { name: 'asc' },
    });

    if (domains.length === 0) return null;

    return DnsRecordsAtomSchema.parse({
      domains: domains.map((d) => ({
        name: d.name,
        type: d.type,
        records: excludeAutoCollisions(d.records).map((r) => ({
          name: r.name,
          type: r.type,
          value: r.value,
          ttl: r.ttlOverride ?? null,
        })),
      })),
    });
  }
}
