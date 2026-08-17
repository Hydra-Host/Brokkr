import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import Redis from 'ioredis';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { atomsMatch, ConfigAtomWriter, REDIS_CLIENT, scanKeys } from 'src/common/redis';
import { DNS_RECORDS_KEY } from 'src/common/redis/redis-keys';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { DnsRecordDerivationService } from './dns-record-derivation.service';
import { DnsRecordsAtomSchema, type DnsRecordsAtom } from './dns-records-atom.schema';
import { DnsRecordsPublisherService } from './dns-records-publisher.service';

const DNS_RECORDS_SCAN_PATTERN = '*:config:dns-records';
const DNS_RECORDS_KEY_RE = /^(.+):config:dns-records$/;

interface PublishedEntry {
  zoneId: string;
  atom: DnsRecordsAtom | null;
}

@Injectable()
export class DnsRecordsReconcilerService {
  private running = false;

  constructor(
    private readonly derivation: DnsRecordDerivationService,
    private readonly publisher: DnsRecordsPublisherService,
    private readonly atomWriter: ConfigAtomWriter,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly prisma: PrismaClient,
    @Logger(DnsRecordsReconcilerService.name) private readonly logger: LoggerService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'dns-records-reconciler' })
  async handleCron(): Promise<void> {
    if (this.running) {
      this.logger.warn('Skipping DNS records reconcile — previous run still in flight');
      return;
    }
    const lockKey = 'dns-records-reconciler:lock';
    const acquired = await this.redis.set(lockKey, '1', 'EX', 55, 'NX');
    if (!acquired) return;
    this.running = true;
    try {
      await this.reconcile();
    } catch (error) {
      this.logger.error(`DNS records reconcile failed: ${getErrorMessage(error)}`);
    } finally {
      this.running = false;
      await this.redis.del(lockKey).catch(() => {});
    }
  }

  private async reconcile(): Promise<void> {
    await this.derivation.rederiveAll();

    const published = await this.scanPublished();
    const publishedByZone = new Map<string, PublishedEntry>(published.map((e) => [e.zoneId, e]));

    const desiredZoneIds = await this.loadDesiredZoneIds();
    const desiredByZone = new Map<string, DnsRecordsAtom>();
    const failedZoneIds = new Set<string>();

    for (const zoneId of desiredZoneIds) {
      try {
        const atom = await this.publisher.buildAtomForZone(zoneId);
        if (atom) desiredByZone.set(zoneId, atom);
      } catch (error) {
        failedZoneIds.add(zoneId);
        this.logger.error(`Failed to derive DNS records atom for zone ${zoneId}: ${getErrorMessage(error)}`);
      }
    }

    for (const [zoneId, atom] of desiredByZone) {
      const current = publishedByZone.get(zoneId);
      if (current && atomsMatch(atom, current.atom)) continue;
      try {
        await this.publisher.publishAtom(zoneId, atom);
        this.logger.warn(
          `Reconciled DNS records for zone ${zoneId}: republished (${current ? 'divergent' : 'missing'})`,
        );
      } catch (error) {
        this.logger.error(`Failed to republish DNS records for zone ${zoneId}: ${getErrorMessage(error)}`);
      }
    }

    for (const entry of published) {
      if (desiredByZone.has(entry.zoneId) || failedZoneIds.has(entry.zoneId)) continue;
      try {
        await this.publisher.clearAtom(entry.zoneId);
        this.logger.warn(`Cleared orphaned DNS records atom for zone ${entry.zoneId}`);
      } catch (error) {
        this.logger.error(`Failed to clear orphaned DNS records for zone ${entry.zoneId}: ${getErrorMessage(error)}`);
      }
    }
  }

  private async scanPublished(): Promise<PublishedEntry[]> {
    const keys = await scanKeys(this.redis, DNS_RECORDS_SCAN_PATTERN);
    const reads = keys.map(async (key): Promise<PublishedEntry | null> => {
      const match = DNS_RECORDS_KEY_RE.exec(key);
      if (!match) {
        this.logger.warn(`Unrecognized DNS records atom key shape: ${key} — skipping`);
        return null;
      }
      const [, zoneId] = match;
      try {
        const value = await this.atomWriter.readAtom(zoneId, DNS_RECORDS_KEY, DnsRecordsAtomSchema);
        return { zoneId, atom: value };
      } catch (error) {
        this.logger.warn(`Failed to read DNS records atom ${key}: ${getErrorMessage(error)} — treating as divergent`);
        return { zoneId, atom: null };
      }
    });
    return (await Promise.all(reads)).filter((entry) => entry !== null);
  }

  private async loadDesiredZoneIds(): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ zoneId: string }>>`
      SELECT DISTINCT dd."zoneId"
      FROM "DnsDomain" dd
      JOIN "Zone" z ON z."id" = dd."zoneId"
      WHERE dd."deletedAt" IS NULL
        AND z."deletedAt" IS NULL
        AND z."dnsEnabled" = true
    `;
    return rows.map((r) => r.zoneId);
  }
}
