import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@repo/database';
import { Job } from 'bullmq';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import {
  DEVICE_DATA_FULL_PURGE_INTERVAL_MS,
  DEVICE_DATA_RECONCILE_INTERVAL_MS,
  DEVICE_DATA_RECONCILE_LOOKBACK_MS,
  DEVICE_DATA_RECONCILE_QUEUE,
  DEVICE_DATA_SWEEP_PAGE_SIZE,
  DEVICE_DATA_SYNC_CHUNK_SIZE,
} from './device-data-reconcile.types';
import {
  DeviceRecordPublisher,
  MONITORED_DEVICE_ROLES,
  deviceDataSyncSelect,
  type DeviceDataSyncRow,
} from './device-record-publisher.service';

@Injectable()
@Processor(DEVICE_DATA_RECONCILE_QUEUE)
export class DeviceDataReconcilerCron extends WorkerHost implements OnApplicationBootstrap {
  private readonly enabled: boolean;
  private lastFullPurgeAt = 0;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly publisher: DeviceRecordPublisher,
    private readonly configService: ConfigService,
    @Logger(DeviceDataReconcilerCron.name) private readonly logger: LoggerService,
  ) {
    super();
    this.enabled = this.configService.get('DEVICE_DATA_RECONCILE_ENABLED') !== 'false';
  }

  // Pause when disabled so this instance never consumes (and drops) a tick scheduled by an enabled instance.
  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) await this.worker.pause();
  }

  async process(_job: Job): Promise<void> {
    // Throw, don't return — the worker starts before the bootstrap pause, so a disabled instance can fetch a tick; failing re-queues it for an enabled one.
    if (!this.enabled) throw new Error('Device data reconcile is disabled on this instance');

    const startTime = Date.now();
    const monitoredRoles = [...MONITORED_DEVICE_ROLES];
    let failed = 0;

    let written = 0;
    let cursor: string | undefined;
    for (;;) {
      const page: Array<DeviceDataSyncRow & { zoneId: string | null }> = await this.prisma.device.findMany({
        where: { deletedAt: null, zoneId: { not: null }, OR: [{ role: { in: monitoredRoles } }, { role: null }] },
        select: { ...deviceDataSyncSelect, zoneId: true },
        orderBy: { id: 'asc' },
        take: DEVICE_DATA_SWEEP_PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
      });
      if (page.length === 0) break;

      for (const [zoneId, batch] of groupByZone(page)) {
        for (const chunk of chunked(batch, DEVICE_DATA_SYNC_CHUNK_SIZE)) {
          try {
            const outcome = await this.publisher.syncDeviceDataBatch(zoneId, chunk);
            written += outcome.written + outcome.deleted;
          } catch (error) {
            failed += chunk.length;
            this.logger.warn(
              `device:{id}:data sync failed for ${chunk.length} device(s) in zone ${zoneId}: ${getErrorMessage(error)}`,
            );
          }
        }
      }

      if (page.length < DEVICE_DATA_SWEEP_PAGE_SIZE) break;
      cursor = page[page.length - 1].id;
    }

    // A role change out of the monitoring set strands the atom unless DEL'd; hourly (and first tick after boot) the updatedAt window drops so older atoms purge.
    const fullPurge = startTime - this.lastFullPurgeAt >= DEVICE_DATA_FULL_PURGE_INTERVAL_MS;
    const lookbackCutoff = new Date(startTime - DEVICE_DATA_RECONCILE_LOOKBACK_MS);
    const demotedOutcome = await this.purgePaginated({
      deletedAt: null,
      zoneId: { not: null },
      role: { not: null, notIn: monitoredRoles },
      ...(fullPurge ? {} : { updatedAt: { gte: lookbackCutoff } }),
    });
    // Tombstones queried fresh AFTER the writes — purging last closes the race where a device soft-deleted mid-sweep gets its atom resurrected.
    const tombstonedOutcome = await this.purgePaginated({
      deletedAt: { gte: lookbackCutoff },
      zoneId: { not: null },
    });
    const purged = demotedOutcome.purged + tombstonedOutcome.purged;
    failed += demotedOutcome.failures + tombstonedOutcome.failures;
    // Mark the hourly timer only after a clean demotion pass so a failed full purge re-runs next tick; tombstone failures don't gate it.
    if (fullPurge && demotedOutcome.failures === 0) {
      this.lastFullPurgeAt = startTime;
    }

    const duration = Date.now() - startTime;
    this.logger.debug(
      `device:{id}:data reconcile: ${written} synced, ${purged} purged${fullPurge ? ' (full)' : ''}, ${failed} failed in ${duration}ms`,
    );
    if (duration > DEVICE_DATA_RECONCILE_INTERVAL_MS) {
      this.logger.warn(
        `device:{id}:data reconcile took ${duration}ms, exceeding its ${DEVICE_DATA_RECONCILE_INTERVAL_MS}ms interval`,
      );
    }
  }

  private async purgePaginated(where: Prisma.DeviceWhereInput): Promise<{ purged: number; failures: number }> {
    let purged = 0;
    let failures = 0;
    let cursor: string | undefined;
    for (;;) {
      const page = await this.prisma.device.findMany({
        where,
        select: { id: true, zoneId: true },
        orderBy: { id: 'asc' },
        take: DEVICE_DATA_SWEEP_PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
      });
      if (page.length === 0) break;

      for (const [zoneId, ids] of groupIdsByZone(page)) {
        for (const chunk of chunked(ids, DEVICE_DATA_SYNC_CHUNK_SIZE)) {
          try {
            await this.publisher.purgeDeviceData(zoneId, chunk);
            purged += chunk.length;
          } catch (error) {
            failures += chunk.length;
            this.logger.warn(
              `device:{id}:data purge failed for ${chunk.length} device(s) in zone ${zoneId}: ${getErrorMessage(error)}`,
            );
          }
        }
      }

      if (page.length < DEVICE_DATA_SWEEP_PAGE_SIZE) break;
      cursor = page[page.length - 1].id;
    }
    return { purged, failures };
  }
}

type ZonedSyncRow = DeviceDataSyncRow & { zoneId: string | null };

function groupByZone(devices: ZonedSyncRow[]): Map<string, DeviceDataSyncRow[]> {
  const byZone = new Map<string, DeviceDataSyncRow[]>();
  for (const device of devices) {
    if (!device.zoneId) continue;
    const batch = byZone.get(device.zoneId);
    if (batch) {
      batch.push(device);
    } else {
      byZone.set(device.zoneId, [device]);
    }
  }
  return byZone;
}

function groupIdsByZone(devices: Array<{ id: string; zoneId: string | null }>): Map<string, string[]> {
  const byZone = new Map<string, string[]>();
  for (const device of devices) {
    if (!device.zoneId) continue;
    const ids = byZone.get(device.zoneId);
    if (ids) {
      ids.push(device.id);
    } else {
      byZone.set(device.zoneId, [device.id]);
    }
  }
  return byZone;
}

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
