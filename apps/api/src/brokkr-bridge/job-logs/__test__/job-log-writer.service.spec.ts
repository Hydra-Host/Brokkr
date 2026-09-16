import { type Redis } from 'ioredis';
import { type LoggerService } from 'src/logger/logger.service';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JOB_LOG_MAX_STREAM_ENTRIES, JobLogWriterService } from '../job-log-writer.service';

describe('JobLogWriterService', () => {
  let xadd: ReturnType<typeof vi.fn>;
  let expire: ReturnType<typeof vi.fn>;
  let warn: ReturnType<typeof vi.fn>;
  let service: JobLogWriterService;

  beforeEach(() => {
    xadd = vi.fn().mockResolvedValue('1-1');
    expire = vi.fn().mockResolvedValue(1);
    warn = vi.fn();
    const redis = { xadd, expire } as unknown as Redis;
    const logger = { warn } as unknown as LoggerService;
    service = new JobLogWriterService(redis, logger);
  });

  it('writes a stream entry under the zone-prefixed job key with the full field tuple', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T12:00:00.000Z'));

    await service.write('zone-1', 'plan-1', 'info', 'Enqueued saga provision for device dev-1', 'BridgeQueueService');

    expect(xadd).toHaveBeenCalledWith(
      'zone-1:job:logs:plan-1',
      'MAXLEN',
      '~',
      JOB_LOG_MAX_STREAM_ENTRIES,
      '*',
      'timestamp',
      '2026-08-28T12:00:00.000Z',
      'log_level',
      'info',
      'message',
      'Enqueued saga provision for device dev-1',
      'app_name',
      'brokkr-hub',
      'app_class_name',
      'BridgeQueueService',
    );
    vi.useRealTimers();
  });

  it('sets the 30-day ttl after every write', async () => {
    await service.write('zone-1', 'plan-1', 'info', 'first', 'BridgeQueueService');
    await service.write('zone-1', 'plan-1', 'error', 'second', 'BridgeResultsConsumer');

    expect(expire).toHaveBeenCalledTimes(2);
    expect(expire).toHaveBeenNthCalledWith(1, 'zone-1:job:logs:plan-1', 2_592_000);
    expect(expire).toHaveBeenNthCalledWith(2, 'zone-1:job:logs:plan-1', 2_592_000);
  });

  it('swallows xadd failures and logs a warning', async () => {
    xadd.mockRejectedValue(new Error('redis down'));

    await expect(service.write('zone-1', 'plan-1', 'error', 'boom', 'BridgeResultsConsumer')).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('redis down');
    expect(warn.mock.calls[0][1]).toBe('plan-1');
    expect(expire).not.toHaveBeenCalled();
  });

  it('swallows expire failures and logs a warning', async () => {
    expire.mockRejectedValue(new Error('expire failed'));

    await expect(service.write('zone-1', 'plan-1', 'info', 'ok', 'PhoneHomeService')).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('skips writes for plan ids with no read path', async () => {
    await service.write('zone-1', 'health-cron-abc', 'info', 'suppressed', 'BridgeQueueService');
    await service.write('zone-1', 'heartbeat-abc', 'info', 'suppressed', 'BridgeResultsConsumer');

    expect(xadd).not.toHaveBeenCalled();
    expect(expire).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('skips writes for the inventory collection saga whatever the plan id spells', async () => {
    await service.write(
      'zone-1',
      '9f1c6d2e-0f4b-4a1d-9c5e-7b2a8d3e1f04',
      'info',
      'suppressed',
      'BridgeQueueService',
      'inventory_collection',
    );
    await service.write(
      'zone-1',
      'inventory-cron-abc',
      'info',
      'suppressed',
      'BridgeQueueService',
      'inventory_collection',
    );
    await service.write('zone-1', 'plan-1', 'error', 'suppressed', 'BridgeResultsConsumer', 'inventory_collection');

    expect(xadd).not.toHaveBeenCalled();
    expect(expire).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('writes for a benchmarks saga with a bare lifecycle plan id', async () => {
    await service.write(
      'zone-1',
      '9f1c6d2e-0f4b-4a1d-9c5e-7b2a8d3e1f04',
      'info',
      'Enqueued saga benchmarks for device dev-1',
      'BridgeQueueService',
      'benchmarks',
    );

    expect(xadd).toHaveBeenCalledOnce();
    expect(expire).toHaveBeenCalledExactlyOnceWith('zone-1:job:logs:9f1c6d2e-0f4b-4a1d-9c5e-7b2a8d3e1f04', 2_592_000);
  });
});
