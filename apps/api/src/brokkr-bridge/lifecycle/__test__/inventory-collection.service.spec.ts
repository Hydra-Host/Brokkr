import { Test, TestingModule } from '@nestjs/testing';
import { JobType } from '@repo/database';
import { LifecycleService } from 'src/lifecycle/lifecycle.service';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { BridgeQueueService } from '../../queue/bridge-queue.service';
import { BridgeInventoryCollectionService, InventoryCollectionCoalescedError } from '../inventory-collection.service';

const ZONE_ID = '550e8400-e29b-41d4-a716-446655440000';
const DEVICE_ID = 'device-abc-123';
const LIFECYCLE_JOB_ID = 'lifecycle-job-1';
const COALESCE_KEY = `inventory-cron-${DEVICE_ID}`;

describe('BridgeInventoryCollectionService', () => {
  let service: BridgeInventoryCollectionService;
  let mockEnqueueSagaJobOrCoalesce: Mock;
  let mockHasActiveSagaJob: Mock;
  let mockRunSystem: Mock;

  beforeEach(async () => {
    mockEnqueueSagaJobOrCoalesce = vi.fn().mockResolvedValue({ job: { id: 'bullmq-job-1' }, coalesced: false });
    mockHasActiveSagaJob = vi.fn().mockResolvedValue(false);
    mockRunSystem = vi.fn(async (params: { dispatch: (jobId: string) => Promise<void> }) => {
      await params.dispatch(LIFECYCLE_JOB_ID);
      return { data: { id: LIFECYCLE_JOB_ID } };
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BridgeInventoryCollectionService,
        {
          provide: BridgeQueueService,
          useValue: { enqueueSagaJobOrCoalesce: mockEnqueueSagaJobOrCoalesce, hasActiveSagaJob: mockHasActiveSagaJob },
        },
        { provide: LifecycleService, useValue: { runSystem: mockRunSystem } },
        {
          provide: `LoggerService${BridgeInventoryCollectionService.name}`,
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

    service = module.get(BridgeInventoryCollectionService);
  });

  afterEach(() => vi.clearAllMocks());

  it('records a lifecycle job for an inventory collection started by the cron', async () => {
    await service.startInventoryCollection(DEVICE_ID, ZONE_ID, 'cron');

    expect(mockRunSystem).toHaveBeenCalledOnce();
    expect(mockRunSystem).toHaveBeenCalledWith(
      expect.objectContaining({
        jobType: JobType.InventoryCollection,
        deviceId: DEVICE_ID,
        zoneId: ZONE_ID,
        source: 'cron',
      }),
    );
    expect(mockEnqueueSagaJobOrCoalesce).toHaveBeenCalledOnce();
    const [, , planId] = mockEnqueueSagaJobOrCoalesce.mock.calls[0];
    expect(planId).toBe(LIFECYCLE_JOB_ID);
  });

  it('enqueues inventory_collection for the device with a device_id payload keyed by the lifecycle job id', async () => {
    await service.startInventoryCollection(DEVICE_ID, ZONE_ID);

    expect(mockEnqueueSagaJobOrCoalesce).toHaveBeenCalledOnce();
    const [zoneId, sagaName, planId, payload, bullmqDeviceKey] = mockEnqueueSagaJobOrCoalesce.mock.calls[0];
    expect(zoneId).toBe(ZONE_ID);
    expect(sagaName).toBe('inventory_collection');
    expect(planId).toBe(LIFECYCLE_JOB_ID);
    expect(payload).toEqual({ device_id: DEVICE_ID });
    expect(bullmqDeviceKey).toBe(DEVICE_ID);
  });

  it('defaults the source to manual', async () => {
    await service.startInventoryCollection(DEVICE_ID, ZONE_ID);

    expect(mockRunSystem).toHaveBeenCalledWith(expect.objectContaining({ source: 'manual' }));
  });

  it('records the phone-home source', async () => {
    await service.startInventoryCollection(DEVICE_ID, ZONE_ID, 'phone-home');

    expect(mockRunSystem).toHaveBeenCalledWith(expect.objectContaining({ source: 'phone-home' }));
  });

  it('coalesces per device so repeated Collect clicks never stack duplicate jobs', async () => {
    await service.startInventoryCollection(DEVICE_ID, ZONE_ID);

    const [, , , , , opts] = mockEnqueueSagaJobOrCoalesce.mock.calls[0];
    expect(opts.coalesceKey).toBe(COALESCE_KEY);
  });

  it('returns the stable coalesced job id, not the per-call planId or the enqueued bullmq id', async () => {
    const result = await service.startInventoryCollection(DEVICE_ID, ZONE_ID);

    expect(result).toEqual({ jobId: COALESCE_KEY });
  });

  it('does not enqueue when the lifecycle job cannot be recorded', async () => {
    mockRunSystem.mockRejectedValueOnce(new Error('db down'));

    await expect(service.startInventoryCollection(DEVICE_ID, ZONE_ID, 'cron')).rejects.toThrow('db down');

    expect(mockEnqueueSagaJobOrCoalesce).not.toHaveBeenCalled();
  });

  it('records no lifecycle job when a collection is already active for the device', async () => {
    mockHasActiveSagaJob.mockResolvedValueOnce(true);

    const result = await service.startInventoryCollection(DEVICE_ID, ZONE_ID, 'cron');

    expect(mockHasActiveSagaJob).toHaveBeenCalledWith(ZONE_ID, COALESCE_KEY);
    expect(mockRunSystem).not.toHaveBeenCalled();
    expect(mockEnqueueSagaJobOrCoalesce).not.toHaveBeenCalled();
    expect(result).toEqual({ jobId: COALESCE_KEY });
  });

  it('fails the lifecycle row with the coalesce reason when the enqueue coalesces after the peek', async () => {
    mockEnqueueSagaJobOrCoalesce.mockResolvedValueOnce({ job: { id: COALESCE_KEY }, coalesced: true });
    let dispatchError: unknown;
    mockRunSystem.mockImplementationOnce(async (params: { dispatch: (jobId: string) => Promise<void> }) => {
      try {
        await params.dispatch(LIFECYCLE_JOB_ID);
      } catch (error) {
        dispatchError = error;
        throw error;
      }
    });

    const result = await service.startInventoryCollection(DEVICE_ID, ZONE_ID);

    expect(dispatchError).toBeInstanceOf(InventoryCollectionCoalescedError);
    expect(dispatchError).toMatchObject({ jobId: COALESCE_KEY, message: expect.stringContaining(COALESCE_KEY) });
    expect(result).toEqual({ jobId: COALESCE_KEY });
  });

  it('propagates a dispatch failure that is not a coalesce', async () => {
    mockEnqueueSagaJobOrCoalesce.mockRejectedValueOnce(new Error('redis down'));
    mockRunSystem.mockImplementationOnce(async (params: { dispatch: (jobId: string) => Promise<void> }) => {
      await params.dispatch(LIFECYCLE_JOB_ID);
    });

    await expect(service.startInventoryCollection(DEVICE_ID, ZONE_ID)).rejects.toThrow('redis down');
  });
});
