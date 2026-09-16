import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { LifecycleJobRecord } from '@repo/lifecycle';
import { type Redis } from 'ioredis';
import { type DeviceContextService } from 'src/brokkr-bridge/device-context.service';
import { type ContextService } from 'src/common/context/context.service';
import { type LoggerService } from 'src/logger/logger.service';
import { type PrismaClient } from 'src/prisma/prisma.client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobLogsService } from '../job-logs.service';

function entryFields(over: Partial<Record<string, string>> = {}): string[] {
  const base: Record<string, string> = {
    timestamp: '2026-08-28T00:00:00.000Z',
    log_level: 'info',
    message: 'step complete',
    app_name: 'brokkr-hub',
    app_class_name: 'BridgeResultsConsumer',
    ...over,
  };
  return Object.entries(base).flat();
}

describe('JobLogsService', () => {
  let requireInstanceOperator: ReturnType<typeof vi.fn>;
  let requirePermission: ReturnType<typeof vi.fn>;
  let findUnique: ReturnType<typeof vi.fn>;
  let findMany: ReturnType<typeof vi.fn>;
  let deviceFindUnique: ReturnType<typeof vi.fn>;
  let findByIdUnscoped: ReturnType<typeof vi.spyOn>;
  let findManyUnscoped: ReturnType<typeof vi.spyOn>;
  let resolveZoneContext: ReturnType<typeof vi.fn>;
  let xrange: ReturnType<typeof vi.fn>;
  let service: JobLogsService;

  beforeEach(() => {
    requireInstanceOperator = vi.fn();
    requirePermission = vi.fn();
    findUnique = vi.fn().mockResolvedValue({ id: 'job-1', deviceId: 'dev-1' });
    findMany = vi.fn().mockResolvedValue([]);
    deviceFindUnique = vi.fn().mockResolvedValue({ id: 'dev-1' });
    findByIdUnscoped = vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(null);
    findManyUnscoped = vi.spyOn(LifecycleJobRecord, 'findManyUnscoped').mockResolvedValue([]);
    resolveZoneContext = vi.fn().mockResolvedValue({ device: { id: 'dev-1' }, zoneId: 'zone-1' });
    xrange = vi.fn().mockResolvedValue([]);

    const contextService = {
      requireInstanceOperator,
      requirePermission,
      buildAuditPayload: vi.fn().mockReturnValue({ triggeredBy: 'u1' }),
    } as unknown as ContextService;
    const prisma = {
      job: { findUnique, findMany },
      device: { findUnique: deviceFindUnique },
    } as unknown as PrismaClient;
    const deviceContext = { resolveZoneContext } as unknown as DeviceContextService;
    const redis = { xrange } as unknown as Redis;
    const logger = { log: vi.fn(), warn: vi.fn() } as unknown as LoggerService;

    service = new JobLogsService(redis, prisma, deviceContext, contextService, logger);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects non-operator organizations with 403', async () => {
    requireInstanceOperator.mockImplementation(() => {
      throw new ForbiddenException();
    });

    await expect(service.getJobLogs('job-1', { limit: 100 })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.listDeviceJobs('dev-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(xrange).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('rejects callers without the job-log:access permission with 403', async () => {
    requirePermission.mockImplementation(() => {
      throw new ForbiddenException();
    });

    await expect(service.getJobLogs('job-1', { limit: 100 })).rejects.toBeInstanceOf(ForbiddenException);
    expect(requirePermission).toHaveBeenCalledWith('job-log', 'access');
    expect(xrange).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown job', async () => {
    findUnique.mockResolvedValue(null);

    await expect(service.getJobLogs('missing', { limit: 100 })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns 404 for a job without a device', async () => {
    findUnique.mockResolvedValue({ deviceId: null });
    findByIdUnscoped.mockResolvedValue({ data: { deviceId: null } });

    await expect(service.getJobLogs('job-1', { limit: 100 })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('resolves the device from a lifecycle job without consulting the legacy table', async () => {
    findByIdUnscoped.mockResolvedValue({ data: { deviceId: 'dev-1' } });

    await service.getJobLogs('plan-1', { limit: 100 });

    expect(findUnique).not.toHaveBeenCalled();
    expect(xrange).toHaveBeenCalledWith('zone-1:job:logs:plan-1', '-', '+', 'COUNT', 100);
  });

  it('falls back to the legacy job table when no lifecycle job exists', async () => {
    await service.getJobLogs('job-1', { limit: 100 });

    expect(findByIdUnscoped).toHaveBeenCalledWith('job-1');
    expect(findUnique).toHaveBeenCalledWith({ where: { id: 'job-1' }, select: { deviceId: true } });
    expect(xrange).toHaveBeenCalledWith('zone-1:job:logs:job-1', '-', '+', 'COUNT', 100);
  });

  it('returns 404 when the zone context cannot be resolved', async () => {
    resolveZoneContext.mockRejectedValue(new NotFoundException('Device dev-1 not found'));

    await expect(service.getJobLogs('job-1', { limit: 100 })).rejects.toBeInstanceOf(NotFoundException);
    expect(xrange).not.toHaveBeenCalled();
  });

  it('propagates infrastructure errors from zone resolution instead of masking them as 404', async () => {
    resolveZoneContext.mockRejectedValue(new Error('db down'));

    await expect(service.getJobLogs('job-1', { limit: 100 })).rejects.toThrow('db down');
    expect(xrange).not.toHaveBeenCalled();
  });

  it('returns 404 when listing jobs for an unknown device', async () => {
    deviceFindUnique.mockResolvedValue(null);

    await expect(service.listDeviceJobs('missing')).rejects.toBeInstanceOf(NotFoundException);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('reads from the start without a cursor and exclusively after the cursor with one', async () => {
    await service.getJobLogs('job-1', { limit: 100 });
    await service.getJobLogs('job-1', { cursor: '1700000000000-5', limit: 100 });

    expect(xrange).toHaveBeenNthCalledWith(1, 'zone-1:job:logs:job-1', '-', '+', 'COUNT', 100);
    expect(xrange).toHaveBeenNthCalledWith(2, 'zone-1:job:logs:job-1', '(1700000000000-5', '+', 'COUNT', 100);
  });

  it('returns a null nextCursor on a short page', async () => {
    xrange.mockResolvedValue([['1-1', entryFields()]]);

    const result = await service.getJobLogs('job-1', { limit: 2 });

    expect(result.nextCursor).toBeNull();
    expect(result.entries).toHaveLength(1);
  });

  it('returns the last stream id as nextCursor on a full page', async () => {
    xrange.mockResolvedValue([
      ['1-1', entryFields()],
      ['1-2', entryFields({ message: 'second' })],
    ]);

    const result = await service.getJobLogs('job-1', { limit: 2 });

    expect(result.nextCursor).toBe('1-2');
    expect(result.entries.map((entry) => entry.id)).toEqual(['1-1', '1-2']);
  });

  it('skips malformed entries while keeping valid ones and advancing the cursor off raw length', async () => {
    xrange.mockResolvedValue([
      ['1-1', entryFields()],
      ['1-2', ['timestamp', '2026-08-28T00:00:01.000Z', 'log_level', 'info']],
      ['1-3', entryFields({ message: 'third' })],
    ]);

    const result = await service.getJobLogs('job-1', { limit: 3 });

    expect(result.entries).toEqual([
      {
        id: '1-1',
        timestamp: '2026-08-28T00:00:00.000Z',
        logLevel: 'info',
        message: 'step complete',
        appName: 'brokkr-hub',
        appClassName: 'BridgeResultsConsumer',
      },
      {
        id: '1-3',
        timestamp: '2026-08-28T00:00:00.000Z',
        logLevel: 'info',
        message: 'third',
        appName: 'brokkr-hub',
        appClassName: 'BridgeResultsConsumer',
      },
    ]);
    expect(result.nextCursor).toBe('1-3');
  });

  it('returns identical entries on repeated reads', async () => {
    xrange.mockResolvedValue([['1-1', entryFields()]]);

    const first = await service.getJobLogs('job-1', { limit: 100 });
    const second = await service.getJobLogs('job-1', { limit: 100 });

    expect(second).toEqual(first);
  });

  it('lists lifecycle and legacy jobs for a device merged newest first', async () => {
    findManyUnscoped.mockResolvedValue([
      {
        data: {
          id: 'plan-1',
          jobType: 'Provision',
          phase: 'RUNNING',
          createdAt: new Date('2026-08-28T12:00:00.000Z'),
          error: null,
        },
      },
    ]);
    findMany.mockResolvedValue([
      {
        id: 'job-2',
        jobType: 'Commission',
        status: 'Failed',
        createdAt: new Date('2026-08-28T10:00:00.000Z'),
        error: 'deploy_os failed',
      },
      {
        id: 'job-3',
        jobType: 'Provision',
        status: 'Completed',
        createdAt: new Date('2026-08-28T14:00:00.000Z'),
        error: null,
      },
    ]);

    const result = await service.listDeviceJobs('dev-1');

    expect(findManyUnscoped).toHaveBeenCalledWith({
      where: { deviceId: 'dev-1' },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    expect(findMany).toHaveBeenCalledWith({
      where: { deviceId: 'dev-1' },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    expect(result.jobs).toEqual([
      {
        id: 'job-3',
        jobType: 'Provision',
        status: 'Completed',
        createdAt: '2026-08-28T14:00:00.000Z',
        error: null,
      },
      {
        id: 'plan-1',
        jobType: 'Provision',
        status: 'RUNNING',
        createdAt: '2026-08-28T12:00:00.000Z',
        error: null,
      },
      {
        id: 'job-2',
        jobType: 'Commission',
        status: 'Failed',
        createdAt: '2026-08-28T10:00:00.000Z',
        error: 'deploy_os failed',
      },
    ]);
  });

  it('caps the merged job list at 100', async () => {
    const lifecycle = Array.from({ length: 60 }, (_, i) => ({
      data: {
        id: `plan-${i}`,
        jobType: 'Provision',
        phase: 'COMPLETED',
        createdAt: new Date(Date.UTC(2026, 7, 1, 0, i)),
        error: null,
      },
    }));
    const legacy = Array.from({ length: 60 }, (_, i) => ({
      id: `job-${i}`,
      jobType: 'Commission',
      status: 'Completed',
      createdAt: new Date(Date.UTC(2026, 6, 1, 0, i)),
      error: null,
    }));
    findManyUnscoped.mockResolvedValue(lifecycle);
    findMany.mockResolvedValue(legacy);

    const result = await service.listDeviceJobs('dev-1');

    expect(result.jobs).toHaveLength(100);
    expect(result.jobs[0].id).toBe('plan-59');
    expect(result.jobs[59].id).toBe('plan-0');
    expect(result.jobs[60].id).toBe('job-59');
  });
});
