import { describe, expect, it, vi } from 'vitest';
import { EventLogRepository } from '../event-log.repository';
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

function buildRepository() {
  const ambientCreate = vi.fn().mockResolvedValue({ id: 'evt-1' });
  const prisma = { eventLog: { create: ambientCreate } };

  return { repository: new EventLogRepository(prisma as never), ambientCreate };
}

describe('EventLogRepository', () => {
  it('creates on the ambient client when no transaction is supplied', async () => {
    const { repository, ambientCreate } = buildRepository();

    await repository.insert(baseWrite);

    expect(ambientCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ actionKey: 'device.update' }) });
  });

  it('creates on the transaction client when one is supplied', async () => {
    const { repository, ambientCreate } = buildRepository();
    const txCreate = vi.fn().mockResolvedValue({ id: 'evt-2' });

    await repository.insert(baseWrite, { eventLog: { create: txCreate } } as never);

    expect(txCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ actionKey: 'device.update' }) });
    expect(ambientCreate).not.toHaveBeenCalled();
  });

  it('omits metadata rather than writing a JSON null', async () => {
    const { repository, ambientCreate } = buildRepository();

    await repository.insert(baseWrite);

    expect(ambientCreate.mock.calls[0][0].data).not.toHaveProperty('metadata');
  });
});
