import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { DeviceRole } from '@repo/database';
import { Job } from 'bullmq';
import { PrismaClient } from 'src/prisma/prisma.client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { DEVICE_DATA_SWEEP_PAGE_SIZE, DEVICE_DATA_SYNC_CHUNK_SIZE } from '../device-data-reconcile.types';
import { DeviceDataReconcilerCron } from '../device-data-reconciler.cron';
import { DeviceRecordPublisher, MONITORED_DEVICE_ROLES } from '../device-record-publisher.service';

const ZONE_A = '550e8400-e29b-41d4-a716-446655440042';
const ZONE_B = '550e8400-e29b-41d4-a716-446655440043';

function deviceRow(id: string, zoneId: string, role: DeviceRole | null) {
  return { id, zoneId, role, deviceModel: null, interfaces: [] };
}

describe('DeviceDataReconcilerCron', () => {
  let cron: DeviceDataReconcilerCron;
  let prisma: { device: { findMany: Mock } };
  let publisher: { syncDeviceDataBatch: Mock; purgeDeviceData: Mock };
  let logger: { debug: Mock; warn: Mock };

  async function build(env: Record<string, string> = {}): Promise<void> {
    prisma = { device: { findMany: vi.fn().mockResolvedValue([]) } };
    publisher = {
      syncDeviceDataBatch: vi.fn().mockResolvedValue({ written: 0, deleted: 0 }),
      purgeDeviceData: vi.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeviceDataReconcilerCron,
        { provide: PrismaClient, useValue: prisma },
        { provide: DeviceRecordPublisher, useValue: publisher },
        { provide: ConfigService, useValue: { get: (key: string) => env[key] } },
        {
          provide: `LoggerService${DeviceDataReconcilerCron.name}`,
          useValue: {
            log: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
            verbose: vi.fn(),
            setContext: vi.fn().mockReturnThis(),
          },
        },
      ],
    }).compile();

    cron = module.get(DeviceDataReconcilerCron);
    logger = module.get(`LoggerService${DeviceDataReconcilerCron.name}`);
  }

  beforeEach(async () => build());
  afterEach(() => vi.restoreAllMocks());

  it('syncs monitored-role devices batched per zone; sweep scoped, paginated, live zoned rows only', async () => {
    const zoneARows = [deviceRow('pdu-1', ZONE_A, DeviceRole.PDU), deviceRow('srv-1', ZONE_A, DeviceRole.Server)];
    const zoneBRows = [deviceRow('commission-1', ZONE_B, null)];
    prisma.device.findMany.mockResolvedValueOnce([...zoneARows, ...zoneBRows]);
    publisher.syncDeviceDataBatch.mockResolvedValue({ written: 2, deleted: 0 });

    await cron.process({} as Job);

    const syncArgs = prisma.device.findMany.mock.calls[0][0];
    expect(syncArgs.where.deletedAt).toBeNull();
    expect(syncArgs.where.zoneId).toEqual({ not: null });
    expect(syncArgs.where.OR).toEqual([{ role: { in: [...MONITORED_DEVICE_ROLES] } }, { role: null }]);
    expect(syncArgs.take).toBe(DEVICE_DATA_SWEEP_PAGE_SIZE);
    expect(syncArgs.orderBy).toEqual({ id: 'asc' });

    expect(publisher.syncDeviceDataBatch).toHaveBeenCalledTimes(2);
    expect(publisher.syncDeviceDataBatch).toHaveBeenCalledWith(ZONE_A, zoneARows);
    expect(publisher.syncDeviceDataBatch).toHaveBeenCalledWith(ZONE_B, zoneBRows);
  });

  it('pages the monitored sweep by cursor so large fleets never load in one query', async () => {
    const pageOne = Array.from({ length: DEVICE_DATA_SWEEP_PAGE_SIZE }, (_, i) =>
      deviceRow(`d${String(i).padStart(5, '0')}`, ZONE_A, DeviceRole.Server),
    );
    const pageTwo = [deviceRow('last-1', ZONE_A, DeviceRole.Server)];
    prisma.device.findMany.mockResolvedValueOnce(pageOne).mockResolvedValueOnce(pageTwo).mockResolvedValue([]);
    publisher.syncDeviceDataBatch.mockResolvedValue({ written: 1, deleted: 0 });

    await cron.process({} as Job);

    const secondCall = prisma.device.findMany.mock.calls[1][0];
    expect(secondCall.cursor).toEqual({ id: pageOne[pageOne.length - 1].id });
    expect(secondCall.skip).toBe(1);
    expect(publisher.syncDeviceDataBatch).toHaveBeenCalledTimes(
      Math.ceil(DEVICE_DATA_SWEEP_PAGE_SIZE / DEVICE_DATA_SYNC_CHUNK_SIZE) + 1,
    );
  });

  it('purges demoted and tombstoned devices after the writes (closes the mid-sweep soft-delete race)', async () => {
    prisma.device.findMany
      .mockResolvedValueOnce([deviceRow('pdu-1', ZONE_A, DeviceRole.PDU)])
      .mockResolvedValueOnce([{ id: 'demoted-1', zoneId: ZONE_A }])
      .mockResolvedValueOnce([{ id: 'deleted-1', zoneId: ZONE_B }]);

    const order: string[] = [];
    publisher.syncDeviceDataBatch.mockImplementation(async () => {
      order.push('sync');
      return { written: 1, deleted: 0 };
    });
    publisher.purgeDeviceData.mockImplementation(async () => {
      order.push('purge');
    });

    await cron.process({} as Job);

    const tombstonedWhere = prisma.device.findMany.mock.calls[2][0].where;
    expect(tombstonedWhere.deletedAt.gte).toBeInstanceOf(Date);

    expect(publisher.purgeDeviceData).toHaveBeenCalledWith(ZONE_A, ['demoted-1']);
    expect(publisher.purgeDeviceData).toHaveBeenCalledWith(ZONE_B, ['deleted-1']);
    expect(order).toEqual(['sync', 'purge', 'purge']);
  });

  it('runs a FULL demotion purge on the first tick, then windows by updatedAt until the next hourly pass', async () => {
    await cron.process({} as Job);
    const firstDemotedWhere = prisma.device.findMany.mock.calls[1][0].where;
    expect(firstDemotedWhere.role).toEqual({ not: null, notIn: [...MONITORED_DEVICE_ROLES] });
    expect(firstDemotedWhere.updatedAt).toBeUndefined();

    prisma.device.findMany.mockClear();
    await cron.process({} as Job);
    const secondDemotedWhere = prisma.device.findMany.mock.calls[1][0].where;
    expect(secondDemotedWhere.updatedAt.gte).toBeInstanceOf(Date);
  });

  it('keeps the full purge active until a demotion pass completes without failures', async () => {
    prisma.device.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'stranded-1', zoneId: ZONE_A }])
      .mockResolvedValueOnce([]);
    publisher.purgeDeviceData.mockRejectedValueOnce(new Error('redis down'));
    await cron.process({} as Job);

    prisma.device.findMany.mockClear();
    await cron.process({} as Job);
    expect(prisma.device.findMany.mock.calls[1][0].where.updatedAt).toBeUndefined();

    prisma.device.findMany.mockClear();
    await cron.process({} as Job);
    expect(prisma.device.findMany.mock.calls[1][0].where.updatedAt.gte).toBeInstanceOf(Date);
  });

  it('paginates the purge queries like the monitored sweep', async () => {
    await cron.process({} as Job);

    for (const call of [1, 2]) {
      const args = prisma.device.findMany.mock.calls[call][0];
      expect(args.take).toBe(DEVICE_DATA_SWEEP_PAGE_SIZE);
      expect(args.orderBy).toEqual({ id: 'asc' });
      expect(args.select).toEqual({ id: true, zoneId: true });
    }
  });

  it('continues the sweep when one zone batch fails to sync', async () => {
    prisma.device.findMany
      .mockResolvedValueOnce([deviceRow('bad', ZONE_A, DeviceRole.PDU), deviceRow('good', ZONE_B, DeviceRole.Server)])
      .mockResolvedValue([]);
    publisher.syncDeviceDataBatch
      .mockRejectedValueOnce(new Error('redis down'))
      .mockResolvedValueOnce({ written: 1, deleted: 0 });

    await expect(cron.process({} as Job)).resolves.toBeUndefined();

    expect(publisher.syncDeviceDataBatch).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(ZONE_A));
  });

  it('throws instead of silently acking a tick when disabled', async () => {
    await build({ DEVICE_DATA_RECONCILE_ENABLED: 'false' });

    await expect(cron.process({} as Job)).rejects.toThrow(/disabled/i);
    expect(prisma.device.findMany).not.toHaveBeenCalled();
  });
});
