import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { ContextService } from 'src/common/context/context.service';
import { EventLogRepository } from '../event-log.repository';
import { EventLogService } from '../event-log.service';
import type { EventLogWrite } from '../event-log.types';

const baseWrite: EventLogWrite = {
  organizationId: 'org-1',
  tier: 'ACTIVITY',
  durability: 'BEST_EFFORT',
  resource: 'device',
  action: 'update',
  actionKey: 'device.update',
  actorType: 'UI',
  outcome: 'SUCCEEDED',
};

async function buildService(repository: Partial<EventLogRepository>) {
  const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), verbose: vi.fn() };
  const moduleRef = await Test.createTestingModule({
    providers: [
      EventLogService,
      { provide: EventLogRepository, useValue: repository },
      { provide: `LoggerService${EventLogService.name}`, useValue: logger },
      { provide: ContextService, useValue: { requirePermission: vi.fn(), organizationId: 'org-1' } },
    ],
  }).compile();

  return { service: moduleRef.get(EventLogService), logger };
}

describe('EventLogService', () => {
  it('propagates a failure from record so the caller decides', async () => {
    const { service } = await buildService({ insert: vi.fn().mockRejectedValue(new Error('db down')) });

    await expect(service.record(baseWrite)).rejects.toThrow('db down');
  });

  it('swallows a failure from recordBestEffort', async () => {
    const insert = vi.fn().mockRejectedValue(new Error('db down'));
    const { service } = await buildService({ insert });

    await expect(service.recordBestEffort(baseWrite)).resolves.toBeUndefined();
    expect(insert).toHaveBeenCalledOnce();
  });

  it('logs the action key when a best-effort write fails', async () => {
    const { service, logger } = await buildService({ insert: vi.fn().mockRejectedValue(new Error('db down')) });

    await service.recordBestEffort(baseWrite);

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('device.update'));
  });

  it('logs the organization id when a best-effort write fails', async () => {
    const { service, logger } = await buildService({ insert: vi.fn().mockRejectedValue(new Error('db down')) });

    await service.recordBestEffort({ ...baseWrite, organizationId: 'org-42' });

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('org-42'));
  });

  it('writes through the supplied transaction client', async () => {
    const insert = vi.fn().mockResolvedValue(undefined);
    const { service } = await buildService({ insert });
    const tx = { eventLog: {} } as never;

    await service.recordInTransaction(tx, baseWrite);

    expect(insert).toHaveBeenCalledWith(baseWrite, tx);
  });

  it('propagates a transactional failure so the mutation rolls back', async () => {
    const { service } = await buildService({
      insert: vi.fn().mockRejectedValue(new Error('constraint violated')),
    });

    await expect(service.recordInTransaction({} as never, baseWrite)).rejects.toThrow('constraint violated');
  });

  it('leaves record on the ambient client with no transaction argument', async () => {
    const insert = vi.fn().mockResolvedValue(undefined);
    const { service } = await buildService({ insert });

    await service.record(baseWrite);

    expect(insert).toHaveBeenCalledWith(baseWrite);
  });

  it('leaves recordBestEffort on the ambient client with no transaction argument', async () => {
    const insert = vi.fn().mockResolvedValue(undefined);
    const { service } = await buildService({ insert });

    await service.recordBestEffort(baseWrite);

    expect(insert).toHaveBeenCalledWith(baseWrite);
  });
});
