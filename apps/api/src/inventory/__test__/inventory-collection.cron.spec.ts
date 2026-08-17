import type { ConfigService } from '@nestjs/config';
import { ServerLifecycleStatus, ServerPowerStatus } from '@repo/database';
import type { Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BridgeInventoryCollectionService } from '../../brokkr-bridge/lifecycle/inventory-collection.service';
import type { LoggerService } from '../../logger/logger.service';
import type { PrismaClient } from '../../prisma/prisma.client';
import { InventoryCollectionCron } from '../inventory-collection.cron';

const JOB = {} as Job;

function buildCron(opts?: {
  devices?: Array<{ id: string; zoneId: string | null }>;
  enqueueRejectsFor?: string;
  enabled?: string;
}) {
  const devices = opts?.devices ?? [{ id: 'dev-1', zoneId: 'zone-1' }];

  const findMany = vi.fn().mockResolvedValue(devices);
  const prisma = { device: { findMany } } as unknown as PrismaClient;

  const startInventoryCollection = vi.fn(async (deviceId: string, _zoneId: string, _source: string) => {
    if (opts?.enqueueRejectsFor === deviceId) throw new Error('enqueue failed');
    return { jobId: `inventory-cron-${deviceId}` };
  });
  const inventoryCollection = { startInventoryCollection } as unknown as BridgeInventoryCollectionService;

  const configService = { get: vi.fn().mockReturnValue(opts?.enabled ?? 'true') } as unknown as ConfigService;

  const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as LoggerService;

  const cron = new InventoryCollectionCron(prisma, inventoryCollection, configService, logger);

  const pause = vi.fn(async () => {});
  (cron as unknown as { _worker: { pause: typeof pause } })._worker = { pause };

  return { cron, findMany, startInventoryCollection, logger, pause };
}

describe('InventoryCollectionCron.process', () => {
  beforeEach(() => vi.clearAllMocks());

  it('scans and enqueues per tick', async () => {
    const { cron, findMany, startInventoryCollection } = buildCron();

    await cron.process(JOB);

    expect(findMany).toHaveBeenCalledOnce();
    expect(startInventoryCollection).toHaveBeenCalledExactlyOnceWith('dev-1', 'zone-1', 'cron');
  });

  it('scans only powered-on servers, since a collection saga against a powered-off box just times out', async () => {
    const { cron, findMany } = buildCron();

    await cron.process(JOB);

    expect(findMany.mock.calls[0][0].where.server).toEqual({
      lifecycleStatus: ServerLifecycleStatus.INVENTORY,
      powerStatus: ServerPowerStatus.On,
    });
  });

  it('throws without scanning when disabled so the tick fails instead of being silently acked', async () => {
    const { cron, findMany, startInventoryCollection } = buildCron({ enabled: 'false' });

    await expect(cron.process(JOB)).rejects.toThrow();
    expect(findMany).not.toHaveBeenCalled();
    expect(startInventoryCollection).not.toHaveBeenCalled();
  });

  it('rethrows a top-level failure so the tick is marked failed', async () => {
    const { cron, findMany } = buildCron();
    findMany.mockRejectedValueOnce(new Error('db down'));

    await expect(cron.process(JOB)).rejects.toThrow('db down');
  });

  it('pauses the worker on bootstrap when disabled', async () => {
    const { cron, pause } = buildCron({ enabled: 'false' });

    await cron.onApplicationBootstrap();

    expect(pause).toHaveBeenCalledOnce();
  });

  it('does not pause the worker on bootstrap when enabled', async () => {
    const { cron, pause } = buildCron();

    await cron.onApplicationBootstrap();

    expect(pause).not.toHaveBeenCalled();
  });

  it('logs a warning when an enqueue fails and continues (AC1)', async () => {
    const { cron, startInventoryCollection, logger } = buildCron({
      devices: [
        { id: 'dev-1', zoneId: 'zone-1' },
        { id: 'dev-2', zoneId: 'zone-1' },
      ],
      enqueueRejectsFor: 'dev-1',
    });

    await cron.process(JOB);

    expect(startInventoryCollection).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});
