import type { ConfigService } from '@nestjs/config';
import { DeviceRole } from '@repo/database';
import type { Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeviceContext, DeviceContextService } from '../../brokkr-bridge/device-context.service';
import type { BridgeQueueService } from '../../brokkr-bridge/queue/bridge-queue.service';
import type { LoggerService } from '../../logger/logger.service';
import type { PrismaClient } from '../../prisma/prisma.client';
import { DeviceHealthCheckCron } from '../device-health-check.cron';

const JOB = {} as Job;

const CTX: DeviceContext = {
  bmcIp: '10.0.0.1',
  credentials: { bmc_user: 'admin', bmc_pass: 'secret' },
} as unknown as DeviceContext;

function buildCron(opts?: {
  devices?: Array<{ id: string; zoneId: string | null; networkType: unknown; interfaces: unknown[] }>;
  enqueueRejectsFor?: string;
  resolveRejectsFor?: string;
  enabled?: string;
}) {
  const devices = opts?.devices ?? [{ id: 'dev-1', zoneId: 'zone-1', networkType: 'STANDARD', interfaces: [] }];

  const findMany = vi.fn().mockResolvedValue(devices);
  const prisma = { device: { findMany } } as unknown as PrismaClient;

  const enqueueSagaJob = vi.fn(
    async (_zone: string, _saga: string, _plan: string, _payload: unknown, deviceId: string) => {
      if (opts?.enqueueRejectsFor === deviceId) throw new Error('enqueue failed');
    },
  );
  const bridgeQueueService = { enqueueSagaJob } as unknown as BridgeQueueService;

  const resolveFromDevice = vi.fn(async (device: { id: string }) => {
    if (opts?.resolveRejectsFor === device.id) throw new Error('no creds');
    return CTX;
  });
  const deviceContext = { resolveFromDevice } as unknown as DeviceContextService;

  const configService = { get: vi.fn().mockReturnValue(opts?.enabled ?? 'true') } as unknown as ConfigService;

  const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as LoggerService;

  const cron = new DeviceHealthCheckCron(prisma, bridgeQueueService, deviceContext, configService, logger);

  const pause = vi.fn(async () => {});
  (cron as unknown as { _worker: { pause: typeof pause } })._worker = { pause };

  return { cron, findMany, enqueueSagaJob, resolveFromDevice, logger, pause };
}

describe('DeviceHealthCheckCron.process', () => {
  beforeEach(() => vi.clearAllMocks());

  it('scans and enqueues per tick', async () => {
    const { cron, findMany, enqueueSagaJob } = buildCron();

    await cron.process(JOB);

    expect(findMany).toHaveBeenCalledOnce();
    expect(enqueueSagaJob).toHaveBeenCalledOnce();
  });

  it('scans both role values, since canonical rows are Server and only legacy imports are Baremetal', async () => {
    const { cron, findMany } = buildCron();

    await cron.process(JOB);

    expect(findMany.mock.calls[0][0].where.role).toEqual({ in: [DeviceRole.Baremetal, DeviceRole.Server] });
  });

  it('throws without scanning when disabled so the tick fails instead of being silently acked', async () => {
    const { cron, findMany, enqueueSagaJob } = buildCron({ enabled: 'false' });

    await expect(cron.process(JOB)).rejects.toThrow();
    expect(findMany).not.toHaveBeenCalled();
    expect(enqueueSagaJob).not.toHaveBeenCalled();
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

  it('skips a device whose context cannot be resolved', async () => {
    const { cron, enqueueSagaJob } = buildCron({
      devices: [
        { id: 'dev-1', zoneId: 'zone-1', networkType: 'STANDARD', interfaces: [] },
        { id: 'dev-2', zoneId: 'zone-1', networkType: 'STANDARD', interfaces: [] },
      ],
      resolveRejectsFor: 'dev-1',
    });

    await cron.process(JOB);

    expect(enqueueSagaJob).toHaveBeenCalledOnce();
  });

  it('logs a warning when an enqueue fails (AC1)', async () => {
    const { cron, logger } = buildCron({ enqueueRejectsFor: 'dev-1' });

    await cron.process(JOB);

    expect(logger.warn).toHaveBeenCalledOnce();
  });
});
