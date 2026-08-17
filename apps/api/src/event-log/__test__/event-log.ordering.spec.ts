import { PrismaClient } from 'src/prisma/prisma.client';
import { describe, expect, it, vi } from 'vitest';
import { EventLogRepository } from '../event-log.repository';

function build() {
  const findMany = vi.fn().mockResolvedValue([]);
  const count = vi.fn().mockResolvedValue(0);
  const prisma = { eventLog: { findMany, count } } as unknown as PrismaClient;

  return { repository: new EventLogRepository(prisma), findMany };
}

const orderByFrom = (findMany: ReturnType<typeof vi.fn>): Array<Record<string, string>> =>
  findMany.mock.calls[0][0].orderBy;

describe('event-log ordering', () => {
  it('sorts newest first', async () => {
    const { repository, findMany } = build();

    await repository.list({}, { page: 1 });

    expect(orderByFrom(findMany)[0]).toEqual({ createdAt: 'desc' });
  });

  it('ends the sort on the unique id so offset pages cannot skip or repeat a tied timestamp', async () => {
    const { repository, findMany } = build();

    await repository.list({}, { page: 1 });

    expect(orderByFrom(findMany).at(-1)).toEqual({ id: 'desc' });
  });

  it('keeps the id tie-breaker when the caller supplies their own sort', async () => {
    const { repository, findMany } = build();

    await repository.list({}, { page: 1, sort: 'actionKey:asc' });

    const orderBy = orderByFrom(findMany);
    expect(orderBy[0]).toEqual({ actionKey: 'asc' });
    expect(orderBy.some((clause) => 'id' in clause)).toBe(true);
  });
});
