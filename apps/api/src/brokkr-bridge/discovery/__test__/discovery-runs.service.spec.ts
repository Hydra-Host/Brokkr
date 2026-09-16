import { NotFoundException } from '@nestjs/common';
import { BaremetalRecord } from 'src/devices/baremetal.record';
import { type PrismaClient } from 'src/prisma/prisma.client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscoveryRunsService } from '../discovery-runs.service';

function runRow(over: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    deviceId: 'dev-1',
    status: 'SUCCEEDED',
    jobId: 'job-1',
    zonePrefix: 'zone-1',
    handlerVersion: 'abc1234',
    bridgeCollectorVersion: '1.2.3',
    collectorsExpected: 4,
    collectorsReceived: 4,
    collectorsApplied: ['dmi'],
    collectorsSkipped: [],
    composersApplied: ['network'],
    s3Prefix: 'dev-1/20260910-1200/',
    startedAt: new Date('2026-09-10T12:00:00.000Z'),
    completedAt: new Date('2026-09-10T12:00:30.000Z'),
    durationMs: 30_000,
    issues: [],
    ...over,
  };
}

function issueRow(over: Record<string, unknown> = {}) {
  return {
    id: 'issue-1',
    runId: 'run-1',
    phase: 'HANDLER',
    collector: 'dmi',
    code: 'HANDLER_THREW',
    severity: 'ERROR',
    detail: { message: 'boom' },
    createdAt: new Date('2026-09-10T12:00:10.000Z'),
    ...over,
  };
}

describe('DiscoveryRunsService', () => {
  let findMany: ReturnType<typeof vi.fn>;
  let count: ReturnType<typeof vi.fn>;
  let findByDeviceIdOrThrow: ReturnType<typeof vi.spyOn>;
  let service: DiscoveryRunsService;

  beforeEach(() => {
    findMany = vi.fn().mockResolvedValue([]);
    count = vi.fn().mockResolvedValue(0);
    findByDeviceIdOrThrow = vi
      .spyOn(BaremetalRecord, 'findByDeviceIdOrThrow')
      .mockResolvedValue({ data: { id: 'dev-1' } } as unknown as BaremetalRecord);

    const prisma = { discoveryRun: { findMany, count } } as unknown as PrismaClient;
    service = new DiscoveryRunsService(prisma);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns runs newest first', async () => {
    findMany.mockResolvedValue([
      runRow({ id: 'run-2', startedAt: new Date('2026-09-10T13:00:00.000Z') }),
      runRow({ id: 'run-1' }),
    ]);
    count.mockResolvedValue(2);

    const result = await service.listForDevice('dev-1', { page: 1 });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ startedAt: 'desc' }, { id: 'desc' }] }),
    );
    expect(result.data.map((run) => run.id)).toEqual(['run-2', 'run-1']);
    expect(result.data[0].startedAt).toBe('2026-09-10T13:00:00.000Z');
  });

  it('reports an in-flight run with no completion timestamp or duration', async () => {
    findMany.mockResolvedValue([runRow({ status: 'STARTED', completedAt: null, durationMs: null })]);
    count.mockResolvedValue(1);

    const result = await service.listForDevice('dev-1', { page: 1 });

    expect(result.data[0].completedAt).toBeNull();
    expect(result.data[0].durationMs).toBeNull();
  });

  it('nests issues under the run that recorded them', async () => {
    findMany.mockResolvedValue([
      runRow({ status: 'PARTIAL', issues: [issueRow(), issueRow({ id: 'issue-2', severity: 'WARN' })] }),
    ]);
    count.mockResolvedValue(1);

    const result = await service.listForDevice('dev-1', { page: 1 });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ include: { issues: { orderBy: { createdAt: 'asc' } } } }),
    );
    expect(result.data[0].issues).toEqual([
      {
        id: 'issue-1',
        phase: 'HANDLER',
        collector: 'dmi',
        code: 'HANDLER_THREW',
        severity: 'ERROR',
        detail: { message: 'boom' },
        createdAt: '2026-09-10T12:00:10.000Z',
      },
      {
        id: 'issue-2',
        phase: 'HANDLER',
        collector: 'dmi',
        code: 'HANDLER_THREW',
        severity: 'WARN',
        detail: { message: 'boom' },
        createdAt: '2026-09-10T12:00:10.000Z',
      },
    ]);
  });

  it('returns an empty page for a device with no runs', async () => {
    const result = await service.listForDevice('dev-1', { page: 1 });

    expect(result.data).toEqual([]);
    expect(result.meta).toEqual({ page: 1, pageSize: 25, totalItems: 0, totalPages: 0 });
  });

  it('scopes the query to the caller tenant device', async () => {
    findByDeviceIdOrThrow.mockRejectedValue(new NotFoundException('Device not found'));

    await expect(service.listForDevice('other-tenant-device', { page: 1 })).rejects.toBeInstanceOf(NotFoundException);
    expect(findMany).not.toHaveBeenCalled();

    findByDeviceIdOrThrow.mockResolvedValue({ data: { id: 'dev-1' } } as unknown as BaremetalRecord);
    await service.listForDevice('dev-1', { page: 1 });

    expect(findByDeviceIdOrThrow).toHaveBeenCalledWith('dev-1');
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { deviceId: 'dev-1' } }));
  });
});
