import { Test, TestingModule } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { BridgeQueueService } from '../../queue/bridge-queue.service';
import { BridgeInventoryCollectionService, type InventoryCollectionSource } from '../inventory-collection.service';

const ZONE_ID = '550e8400-e29b-41d4-a716-446655440000';
const DEVICE_ID = 'device-abc-123';

describe('BridgeInventoryCollectionService', () => {
  let service: BridgeInventoryCollectionService;
  let mockEnqueueSagaJob: Mock;

  beforeEach(async () => {
    mockEnqueueSagaJob = vi.fn().mockResolvedValue({ id: 'bullmq-job-1' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BridgeInventoryCollectionService,
        { provide: BridgeQueueService, useValue: { enqueueSagaJob: mockEnqueueSagaJob } },
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

  it('enqueues inventory_collection for the device with a device_id payload', async () => {
    await service.startInventoryCollection(DEVICE_ID, ZONE_ID);

    expect(mockEnqueueSagaJob).toHaveBeenCalledOnce();
    const [zoneId, sagaName, planId, payload, bullmqDeviceKey] = mockEnqueueSagaJob.mock.calls[0];
    expect(zoneId).toBe(ZONE_ID);
    expect(sagaName).toBe('inventory_collection');
    expect(planId).toMatch(/^manual-collect-/);
    expect(payload).toEqual({ device_id: DEVICE_ID });
    expect(bullmqDeviceKey).toBe(DEVICE_ID);
  });

  it.each<[InventoryCollectionSource, string]>([
    ['manual', 'manual-collect-'],
    ['cron', 'inventory-cron-'],
    ['phone-home', 'phone-home-discovery-'],
  ])('uses the %s planId prefix', async (source, prefix) => {
    await service.startInventoryCollection(DEVICE_ID, ZONE_ID, source);
    const [, , planId] = mockEnqueueSagaJob.mock.calls[0];
    expect(planId.startsWith(prefix)).toBe(true);
  });

  it('coalesces per device so repeated Collect clicks never stack duplicate jobs', async () => {
    await service.startInventoryCollection(DEVICE_ID, ZONE_ID);

    const [, , , , , opts] = mockEnqueueSagaJob.mock.calls[0];
    expect(opts.coalesceKey).toBe(`inventory-cron-${DEVICE_ID}`);
  });

  it('returns the stable coalesced job id, not the per-call planId', async () => {
    mockEnqueueSagaJob.mockResolvedValueOnce({ id: `inventory-cron-${DEVICE_ID}` });

    const result = await service.startInventoryCollection(DEVICE_ID, ZONE_ID);
    expect(result).toEqual({ jobId: `inventory-cron-${DEVICE_ID}` });
  });

  it('falls back to the coalesce key when enqueueSagaJob returns a job without an id', async () => {
    mockEnqueueSagaJob.mockResolvedValueOnce({});

    const result = await service.startInventoryCollection(DEVICE_ID, ZONE_ID);

    expect(result).toEqual({ jobId: `inventory-cron-${DEVICE_ID}` });
  });
});
