import type { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEVICE_DATA_RECONCILE_JOB, DEVICE_DATA_RECONCILE_SCHEDULE } from '../device-data-reconcile.types';
import { DeviceRecordModule } from '../device-record.module';

function buildModule(enabled?: string) {
  const upsertJobScheduler = vi.fn().mockResolvedValue(undefined);
  const removeJobScheduler = vi.fn().mockResolvedValue(undefined);
  const queue = { upsertJobScheduler, removeJobScheduler } as unknown as Queue;
  const configService = { get: vi.fn().mockReturnValue(enabled) } as unknown as ConfigService;
  const module = new DeviceRecordModule(queue, configService);
  return { module, upsertJobScheduler, removeJobScheduler };
}

describe('DeviceRecordModule.onModuleInit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers the reconciler scheduler under the job name with the configured pattern', async () => {
    const { module, upsertJobScheduler, removeJobScheduler } = buildModule();

    await module.onModuleInit();

    expect(removeJobScheduler).not.toHaveBeenCalled();
    expect(upsertJobScheduler).toHaveBeenCalledWith(
      DEVICE_DATA_RECONCILE_JOB,
      { pattern: DEVICE_DATA_RECONCILE_SCHEDULE },
      expect.objectContaining({ name: DEVICE_DATA_RECONCILE_JOB }),
    );
  });

  it('configures retries so a tick failed during the startup race re-queues for an enabled instance', async () => {
    const { module, upsertJobScheduler } = buildModule();

    await module.onModuleInit();

    const [, , template] = upsertJobScheduler.mock.calls[0];
    expect(template.opts.attempts).toBeGreaterThan(1);
    expect(template.opts.backoff).toBeDefined();
  });

  it('skips scheduler registration entirely when disabled (never removes the shared scheduler)', async () => {
    const { module, upsertJobScheduler, removeJobScheduler } = buildModule('false');

    await module.onModuleInit();

    expect(removeJobScheduler).not.toHaveBeenCalled();
    expect(upsertJobScheduler).not.toHaveBeenCalled();
  });
});
