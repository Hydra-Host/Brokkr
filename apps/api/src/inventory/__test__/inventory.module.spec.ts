import type { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { INVENTORY_COLLECTION_JOB, INVENTORY_COLLECTION_SCHEDULE } from '../inventory-collection.types';
import { InventoryModule } from '../inventory.module';

function buildModule(enabled?: string) {
  const upsertJobScheduler = vi.fn().mockResolvedValue(undefined);
  const removeJobScheduler = vi.fn().mockResolvedValue(undefined);
  const queue = { upsertJobScheduler, removeJobScheduler } as unknown as Queue;
  const configService = { get: vi.fn().mockReturnValue(enabled) } as unknown as ConfigService;
  const module = new InventoryModule(queue, configService);
  return { module, upsertJobScheduler, removeJobScheduler };
}

describe('InventoryModule.onModuleInit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers the repeatable scheduler under the job name with the configured pattern', async () => {
    const { module, upsertJobScheduler, removeJobScheduler } = buildModule();

    await module.onModuleInit();

    expect(removeJobScheduler).not.toHaveBeenCalled();
    expect(upsertJobScheduler).toHaveBeenCalledWith(
      INVENTORY_COLLECTION_JOB,
      { pattern: INVENTORY_COLLECTION_SCHEDULE },
      expect.objectContaining({ name: INVENTORY_COLLECTION_JOB }),
    );
  });

  it('configures retries so a tick failed during the startup race re-queues for an enabled instance', async () => {
    const { module, upsertJobScheduler } = buildModule();

    await module.onModuleInit();

    const [, , template] = upsertJobScheduler.mock.calls[0];
    expect(template.opts.attempts).toBeGreaterThan(1);
    expect(template.opts.backoff).toBeDefined();
  });

  it('skips scheduler registration entirely when disabled', async () => {
    const { module, upsertJobScheduler, removeJobScheduler } = buildModule('false');

    await module.onModuleInit();

    expect(removeJobScheduler).not.toHaveBeenCalled();
    expect(upsertJobScheduler).not.toHaveBeenCalled();
  });
});
