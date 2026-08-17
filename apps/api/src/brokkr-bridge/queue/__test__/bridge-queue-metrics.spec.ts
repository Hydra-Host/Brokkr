import { Test, TestingModule } from '@nestjs/testing';
import { REDIS_CONFIG } from 'src/common/redis';
import { SealedEnvelopeService } from 'src/crypto/sealed-envelope.service';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { BridgeQueueService } from '../bridge-queue.service';

const { gaugeCallbacks, getJobCounts } = vi.hoisted(() => ({
  gaugeCallbacks: new Map<string, (observable: { observe: Mock }) => Promise<unknown>>(),
  getJobCounts: vi.fn(),
}));
vi.mock('@repo/telemetry', () => ({
  getTelemetryMeter: () => ({
    createObservableGauge: (name: string) => ({
      addCallback: (callback: (observable: { observe: Mock }) => Promise<unknown>) =>
        gaugeCallbacks.set(name, callback),
      removeCallback: () => gaugeCallbacks.delete(name),
    }),
  }),
  getBullMqTelemetry: () => undefined,
}));
vi.mock('bullmq', () => ({
  Queue: class {
    getJobCounts = getJobCounts;
    close = vi.fn();
  },
  Job: class {},
}));

describe('BridgeQueueService — brokkr.queue.jobs gauge', () => {
  let service: BridgeQueueService;
  let loggerDebug: Mock;

  beforeEach(async () => {
    gaugeCallbacks.clear();
    getJobCounts.mockReset();
    loggerDebug = vi.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BridgeQueueService,
        { provide: REDIS_CONFIG, useValue: { host: 'localhost', port: 6379 } },
        { provide: SealedEnvelopeService, useValue: { isZoneEnrolled: vi.fn().mockResolvedValue(false) } },
        {
          provide: 'LoggerServiceBridgeQueueService',
          useValue: {
            log: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: loggerDebug,
            verbose: vi.fn(),
            setContext: vi.fn().mockReturnThis(),
          },
        },
      ],
    }).compile();

    service = module.get(BridgeQueueService);
  });

  const collect = async () => {
    const observe = vi.fn();
    await gaugeCallbacks.get('brokkr.queue.jobs')?.({ observe });
    return observe;
  };

  it('observes each known zone queue by state under queue=zone:<zoneUuid>', async () => {
    getJobCounts.mockResolvedValue({ waiting: 2, active: 1, failed: 0, delayed: 5 });
    service.getLifecycleQueue('zone-1');

    const observe = await collect();

    expect(getJobCounts).toHaveBeenCalledExactlyOnceWith('waiting', 'active', 'failed', 'delayed');
    expect(observe).toHaveBeenCalledWith(2, { queue: 'zone:zone-1', state: 'waiting' });
    expect(observe).toHaveBeenCalledWith(1, { queue: 'zone:zone-1', state: 'active' });
    expect(observe).toHaveBeenCalledWith(0, { queue: 'zone:zone-1', state: 'failed' });
    expect(observe).toHaveBeenCalledWith(5, { queue: 'zone:zone-1', state: 'delayed' });
  });

  it('observes nothing when no zone queues exist yet', async () => {
    const observe = await collect();
    expect(observe).not.toHaveBeenCalled();
    expect(getJobCounts).not.toHaveBeenCalled();
  });

  it('swallows a per-queue count failure without throwing out of the collection cycle', async () => {
    getJobCounts.mockRejectedValue(new Error('redis down'));
    service.getLifecycleQueue('zone-1');

    const observe = await collect();

    expect(observe).not.toHaveBeenCalled();
    expect(loggerDebug).toHaveBeenCalledOnce();
  });
});
