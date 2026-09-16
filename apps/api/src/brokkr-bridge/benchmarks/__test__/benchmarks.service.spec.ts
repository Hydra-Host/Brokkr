import { Test, TestingModule } from '@nestjs/testing';
import { JobType } from '@repo/database';
import { LifecycleService } from 'src/lifecycle/lifecycle.service';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { BridgeQueueService } from '../../queue/bridge-queue.service';
import { BenchmarksRepository } from '../benchmarks.repository';
import { BenchmarkService } from '../benchmarks.service';

const DEVICE_UUID = '550e8400-e29b-41d4-a716-446655440099';
const ZONE_ID = '1-1-1';
const LIFECYCLE_JOB_ID = 'lifecycle-job-1';

describe('BenchmarkService', () => {
  let service: BenchmarkService;
  let mockGetLatest: Mock;
  let mockCreateRun: Mock;
  let mockEnqueueSagaJob: Mock;
  let mockRunSystem: Mock;

  beforeEach(async () => {
    mockGetLatest = vi.fn().mockResolvedValue({
      id: null,
      deviceMetadataId: null,
      deviceId: DEVICE_UUID,
      type: null,
      status: null,
      deviceStatus: 'active',
      role: 'Server',
      zoneId: ZONE_ID,
      startTime: null,
      endTime: null,
      durationSeconds: null,
      testPassed: null,
      data: null,
      createdAt: null,
      updatedAt: null,
    });
    mockCreateRun = vi.fn().mockResolvedValueOnce({ id: 'gpu-burn-run-1' }).mockResolvedValueOnce({ id: 'nccl-run-1' });
    mockEnqueueSagaJob = vi.fn().mockResolvedValue({ id: 'bullmq-job-1' });
    mockRunSystem = vi.fn(async (params: { dispatch: (jobId: string) => Promise<void> }) => {
      await params.dispatch(LIFECYCLE_JOB_ID);
      return { data: { id: LIFECYCLE_JOB_ID } };
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BenchmarkService,
        {
          provide: BenchmarksRepository,
          useValue: {
            getLatestDeviceTestRunForDevice: mockGetLatest,
            createRunningDeviceTestRun: mockCreateRun,
          },
        },
        { provide: BridgeQueueService, useValue: { enqueueSagaJob: mockEnqueueSagaJob } },
        { provide: LifecycleService, useValue: { runSystem: mockRunSystem } },
        {
          provide: `LoggerService${BenchmarkService.name}`,
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

    service = module.get(BenchmarkService);
  });

  afterEach(() => vi.clearAllMocks());

  it('records a lifecycle job for auto benchmarks after discovery', async () => {
    const result = await service.runBenchmarks(DEVICE_UUID, 'discovery');

    expect(mockRunSystem).toHaveBeenCalledOnce();
    expect(mockRunSystem).toHaveBeenCalledWith(
      expect.objectContaining({
        jobType: JobType.Benchmarks,
        deviceId: DEVICE_UUID,
        zoneId: ZONE_ID,
        source: 'discovery',
      }),
    );
    const [, , planId] = mockEnqueueSagaJob.mock.calls[0];
    expect(planId).toBe(LIFECYCLE_JOB_ID);
    expect(result).toEqual({
      enqueued: true,
      plan_id: LIFECYCLE_JOB_ID,
      gpu_burn_run_id: 'gpu-burn-run-1',
      nccl_run_id: 'nccl-run-1',
    });
  });

  it('defaults the source to manual', async () => {
    await service.runBenchmarks(DEVICE_UUID);

    expect(mockRunSystem).toHaveBeenCalledWith(expect.objectContaining({ source: 'manual' }));
  });

  it('sends the Device UUID in payload.device_id and keys the bullmq job by the same UUID', async () => {
    const result = await service.runBenchmarks(DEVICE_UUID);

    expect(result).toEqual({
      enqueued: true,
      plan_id: LIFECYCLE_JOB_ID,
      gpu_burn_run_id: 'gpu-burn-run-1',
      nccl_run_id: 'nccl-run-1',
    });

    expect(mockEnqueueSagaJob).toHaveBeenCalledOnce();
    const [zoneId, sagaName, , payload, jobKey] = mockEnqueueSagaJob.mock.calls[0];
    expect(zoneId).toBe(ZONE_ID);
    expect(sagaName).toBe('benchmarks');
    expect(payload.device_id).toBe(DEVICE_UUID);
    expect(payload.gpu_burn_job_id).toBe('gpu-burn-run-1');
    expect(payload.nccl_job_id).toBe('nccl-run-1');
    expect(jobKey).toBe(DEVICE_UUID);
  });

  it('skips a device with no role without creating test runs that nothing would report back on', async () => {
    mockGetLatest.mockResolvedValue({
      id: null,
      deviceMetadataId: null,
      deviceId: DEVICE_UUID,
      type: null,
      status: null,
      deviceStatus: 'active',
      role: null,
      zoneId: ZONE_ID,
      startTime: null,
      endTime: null,
      durationSeconds: null,
      testPassed: null,
      data: null,
      createdAt: null,
      updatedAt: null,
    });

    await expect(service.runBenchmarks(DEVICE_UUID)).resolves.toEqual({ skipped: true });

    expect(mockCreateRun).not.toHaveBeenCalled();
    expect(mockRunSystem).not.toHaveBeenCalled();
    expect(mockEnqueueSagaJob).not.toHaveBeenCalled();
  });
});
