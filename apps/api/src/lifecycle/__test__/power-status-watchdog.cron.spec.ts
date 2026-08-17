import { ServerPowerStatus } from '@repo/database';
import { TRANSITIONAL_SERVER_POWER_STATUSES } from '@repo/device-domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LoggerService } from '../../logger/logger.service';
import type { PrismaClient } from '../../prisma/prisma.client';
import { PowerStatusWatchdogCron } from '../power-status-watchdog.cron';

function buildCron() {
  const updateMany = vi.fn().mockResolvedValue({ count: 0 });
  const prisma = { server: { updateMany } } as unknown as PrismaClient;
  const logger = { error: vi.fn(), warn: vi.fn() } as unknown as LoggerService;

  return { cron: new PowerStatusWatchdogCron(prisma, logger), updateMany, logger };
}

describe('PowerStatusWatchdogCron', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T05:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('exports all transitional server power statuses', () => {
    expect(TRANSITIONAL_SERVER_POWER_STATUSES).toEqual([
      ServerPowerStatus.PoweringOn,
      ServerPowerStatus.PoweringOff,
      ServerPowerStatus.Rebooting,
    ]);
  });

  it('clears stale transitional power statuses with one conditional update', async () => {
    const { cron, updateMany } = buildCron();

    await cron.handleCron();

    expect(updateMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        powerStatus: { in: [...TRANSITIONAL_SERVER_POWER_STATUSES] },
        updatedAt: { lt: new Date('2026-07-30T04:45:00.000Z') },
        device: { deletedAt: null },
      },
      data: { powerStatus: null },
    });
  });

  it('logs a query error', async () => {
    const { cron, updateMany, logger } = buildCron();
    updateMany.mockRejectedValueOnce(new Error('query failed'));

    await cron.handleCron();

    expect(logger.error).toHaveBeenCalledWith('The power status watchdog query failed: query failed');
  });

  it('skips an overlapping run', async () => {
    const { cron, updateMany, logger } = buildCron();
    let resolveQuery: (result: { count: number }) => void = () => {};
    updateMany.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveQuery = resolve;
      }),
    );

    const firstRun = cron.handleCron();
    await cron.handleCron();

    expect(updateMany).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      'Skipping the power status watchdog because the previous run is still active',
    );

    resolveQuery({ count: 0 });
    await firstRun;
  });
});
