import { Test, type TestingModule } from '@nestjs/testing';
import type { SanitizationReport } from 'src/brokkr-bridge/types/queue.types';
import { PrismaClient } from 'src/prisma/prisma.client';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { SanitizationReportService } from '../sanitization-report.service';

const DEVICE_ID = '550e8400-e29b-41d4-a716-446655440000';

function makeReport(overrides: Partial<SanitizationReport> = {}): SanitizationReport {
  return {
    version: '1.0',
    standards_reference: ['NIST SP 800-88r2'],
    job_id: 'job-123',
    mode: 'full',
    started_at: '2026-06-21T00:00:00.000Z',
    completed_at: '2026-06-21T00:01:00.000Z',
    duration_seconds: 12.5,
    overall_result: 'pass',
    tool: { name: 'nwipe', version: '0.36' },
    holder_teardown: {},
    disks: [],
    preserved_disks: [],
    skipped_disks: [],
    ...overrides,
  };
}

describe('SanitizationReportService', () => {
  let service: SanitizationReportService;
  let prisma: { device: { findUnique: Mock }; sanitizationReport: { upsert: Mock } };
  let mockLogger: { log: Mock; warn: Mock; error: Mock; debug: Mock; verbose: Mock; setContext: Mock };

  beforeEach(async () => {
    prisma = { device: { findUnique: vi.fn() }, sanitizationReport: { upsert: vi.fn() } };
    mockLogger = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      verbose: vi.fn(),
      setContext: vi.fn().mockReturnThis(),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SanitizationReportService,
        { provide: PrismaClient, useValue: prisma },
        { provide: 'LoggerService', useValue: mockLogger },
      ],
    }).compile();
    service = module.get(SanitizationReportService);
  });

  it('skips persistence (no throw) when the device does not exist', async () => {
    prisma.device.findUnique.mockResolvedValue(null);
    await expect(service.createFromStepResult(DEVICE_ID, 'deprovision', makeReport())).resolves.toBeUndefined();
    expect(prisma.sanitizationReport.upsert).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('upserts keyed on (deviceId, jobId); a failed verdict leaves a no-op update', async () => {
    prisma.device.findUnique.mockResolvedValue({ id: DEVICE_ID });
    await service.createFromStepResult(DEVICE_ID, 'commission', makeReport({ job_id: 'job-xyz', overall_result: 'fail' }));
    expect(prisma.sanitizationReport.upsert).toHaveBeenCalledTimes(1);
    const arg = prisma.sanitizationReport.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ deviceId_jobId: { deviceId: DEVICE_ID, jobId: 'job-xyz' } });
    expect(arg.update).toEqual({});
    expect(arg.create.actionType).toBe('commission');
    expect(arg.create.result).toBe('fail');
  });

  it('a passing retry supersedes an earlier fail row under the same jobId', async () => {
    prisma.device.findUnique.mockResolvedValue({ id: DEVICE_ID });
    await service.createFromStepResult(DEVICE_ID, 'commission', makeReport({ job_id: 'job-xyz', overall_result: 'pass' }));
    const arg = prisma.sanitizationReport.upsert.mock.calls[0][0];
    expect(arg.update.result).toBe('pass');
    expect(arg.update).toEqual(arg.create);
  });

  it('coerces string timestamps to Date and preserves fractional duration', async () => {
    prisma.device.findUnique.mockResolvedValue({ id: DEVICE_ID });
    await service.createFromStepResult(DEVICE_ID, 'provision', makeReport({ duration_seconds: 12.5 }));
    const create = prisma.sanitizationReport.upsert.mock.calls[0][0].create;
    expect(create.startedAt).toBeInstanceOf(Date);
    expect(create.completedAt).toBeInstanceOf(Date);
    expect(create.duration).toBe(12.5);
  });

  it('persists with a synthesized capture time when timestamps are unparseable (audit must not drop)', async () => {
    prisma.device.findUnique.mockResolvedValue({ id: DEVICE_ID });
    await service.createFromStepResult(DEVICE_ID, 'provision', makeReport({ started_at: 'not-a-date' }));
    expect(prisma.sanitizationReport.upsert).toHaveBeenCalledTimes(1);
    const create = prisma.sanitizationReport.upsert.mock.calls[0][0].create;
    expect(create.startedAt).toBeInstanceOf(Date);
    expect(Number.isNaN(create.startedAt.getTime())).toBe(false);
  });

  it('persists the bridge tolerant failure shape with fail-closed fallbacks', async () => {
    prisma.device.findUnique.mockResolvedValue({ id: DEVICE_ID });
    await service.createFromStepResult(
      DEVICE_ID,
      'deprovision',
      { mode: 'full', overall_result: 'fail' } as SanitizationReport,
      'plan-77',
    );
    expect(prisma.sanitizationReport.upsert).toHaveBeenCalledTimes(1);
    const arg = prisma.sanitizationReport.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ deviceId_jobId: { deviceId: DEVICE_ID, jobId: 'plan-77' } });
    expect(arg.create.result).toBe('fail');
    expect(arg.create.mode).toBe('full');
    expect(arg.create.duration).toBe(0);
    expect(arg.create.startedAt).toBeInstanceOf(Date);
    expect(arg.update).toEqual({});
  });

  it('synthesizes overall_result=fail when the verdict is missing entirely', async () => {
    prisma.device.findUnique.mockResolvedValue({ id: DEVICE_ID });
    await service.createFromStepResult(DEVICE_ID, 'provision', { job_id: 'only' } as SanitizationReport);
    const create = prisma.sanitizationReport.upsert.mock.calls[0][0].create;
    expect(create.result).toBe('fail');
    expect(create.jobId).toBe('only');
  });
});
