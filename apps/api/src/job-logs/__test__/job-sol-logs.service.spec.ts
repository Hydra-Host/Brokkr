import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { type JobSolLogsResponse } from '@repo/api-client';
import { LifecycleJobRecord } from '@repo/lifecycle';
import { type DeviceContextService } from 'src/brokkr-bridge/device-context.service';
import { type SolLogService } from 'src/brokkr-bridge/sol-logs/sol-log.service';
import { type ContextService } from 'src/common/context/context.service';
import { type LoggerService } from 'src/logger/logger.service';
import { afterEach, beforeEach, describe, expect, it, vi, type MockedFunction } from 'vitest';
import { type DevicePin, JobSolLogsService } from '../job-sol-logs.service';

const query = { cursor: 0, limit: 500 };

const page: JobSolLogsResponse = {
  entries: [{ index: 0, timestamp: '2026-09-17T00:00:00.000', message: ' login:' }],
  nextCursor: null,
  complete: true,
};

describe('JobSolLogsService', () => {
  let requirePermission: MockedFunction<ContextService['requirePermission']>;
  let requireInstanceOperator: MockedFunction<ContextService['requireInstanceOperator']>;
  let buildAuditPayload: MockedFunction<ContextService['buildAuditPayload']>;
  let findByDeviceIdOrThrow: MockedFunction<DevicePin['findByDeviceIdOrThrow']>;
  let findByIdUnscoped: ReturnType<typeof vi.spyOn>;
  let resolveZoneContext: MockedFunction<DeviceContextService['resolveZoneContext']>;
  let getLogsPage: MockedFunction<SolLogService['getLogsPage']>;
  let log: MockedFunction<LoggerService['log']>;
  let service: JobSolLogsService;

  beforeEach(() => {
    requirePermission = vi.fn();
    requireInstanceOperator = vi.fn();
    buildAuditPayload = vi.fn();
    buildAuditPayload.mockReturnValue({ triggeredBy: 'u1' });
    findByDeviceIdOrThrow = vi.fn();
    findByDeviceIdOrThrow.mockResolvedValue({ data: { id: 'dev-1' } });
    findByIdUnscoped = vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped');
    findByIdUnscoped.mockResolvedValue({ data: { deviceId: 'dev-1' } });
    resolveZoneContext = vi.fn();
    resolveZoneContext.mockResolvedValue({ device: { id: 'dev-1' }, zoneId: 'zone-1' });
    getLogsPage = vi.fn();
    getLogsPage.mockResolvedValue(page);
    log = vi.fn();

    service = new JobSolLogsService(
      { findByDeviceIdOrThrow },
      { resolveZoneContext },
      { requirePermission, requireInstanceOperator, buildAuditPayload },
      { getLogsPage },
      { log },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects callers without the job-log:access permission before pinning the device', async () => {
    requirePermission.mockImplementation(() => {
      throw new ForbiddenException();
    });

    await expect(service.getJobSolLogs('dev-1', 'job-1', query)).rejects.toBeInstanceOf(ForbiddenException);
    expect(requirePermission).toHaveBeenCalledWith('job-log', 'access');
    expect(requireInstanceOperator).not.toHaveBeenCalled();
    expect(findByDeviceIdOrThrow).not.toHaveBeenCalled();
  });

  it('rejects non-operator organizations after the permission check', async () => {
    requireInstanceOperator.mockImplementation(() => {
      throw new ForbiddenException();
    });

    await expect(service.getJobSolLogs('dev-1', 'job-1', query)).rejects.toBeInstanceOf(ForbiddenException);
    expect(requirePermission.mock.invocationCallOrder[0]).toBeLessThan(
      requireInstanceOperator.mock.invocationCallOrder[0],
    );
    expect(findByDeviceIdOrThrow).not.toHaveBeenCalled();
  });

  it('propagates the device pin 404 without looking up the job', async () => {
    findByDeviceIdOrThrow.mockRejectedValue(new NotFoundException('Device not found'));

    await expect(service.getJobSolLogs('dev-1', 'job-1', query)).rejects.toBeInstanceOf(NotFoundException);
    expect(findByIdUnscoped).not.toHaveBeenCalled();
    expect(getLogsPage).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown job', async () => {
    findByIdUnscoped.mockResolvedValue(null);

    await expect(service.getJobSolLogs('dev-1', 'missing', query)).rejects.toBeInstanceOf(NotFoundException);
    expect(getLogsPage).not.toHaveBeenCalled();
  });

  it('returns 404 when the job belongs to another device', async () => {
    findByIdUnscoped.mockResolvedValue({ data: { deviceId: 'dev-2' } });

    await expect(service.getJobSolLogs('dev-1', 'job-1', query)).rejects.toBeInstanceOf(NotFoundException);
    expect(resolveZoneContext).not.toHaveBeenCalled();
    expect(getLogsPage).not.toHaveBeenCalled();
  });

  it('reads the page for the device zone and returns it verbatim', async () => {
    const result = await service.getJobSolLogs('dev-1', 'job-1', query);

    expect(findByDeviceIdOrThrow).toHaveBeenCalledWith('dev-1');
    expect(findByIdUnscoped).toHaveBeenCalledWith('job-1');
    expect(resolveZoneContext).toHaveBeenCalledWith('dev-1');
    expect(getLogsPage).toHaveBeenCalledWith('zone-1', 'job-1', 0, 500);
    expect(result).toBe(page);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('actor=u1'));
  });

  it('propagates a zone-less device error unchanged', async () => {
    resolveZoneContext.mockRejectedValue(new BadRequestException('Device dev-1 is not assigned to a zone'));

    await expect(service.getJobSolLogs('dev-1', 'job-1', query)).rejects.toBeInstanceOf(BadRequestException);
    expect(getLogsPage).not.toHaveBeenCalled();
  });
});
