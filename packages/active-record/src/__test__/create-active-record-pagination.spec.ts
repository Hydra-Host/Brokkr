import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ActiveRecordRegistry } from '../active-record.registry';
import { createActiveRecord } from '../create-active-record';


const PaginatedSchema = z.object({
  id: z.string(),
  name: z.string(),
  organizationId: z.string(),
  kind: z.string(),
  deletedAt: z.date().nullable(),
});

const mockDelegate = {
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
};

class PaginatedRecord extends createActiveRecord(PaginatedSchema, 'testModel', {
  tenantField: 'organizationId',
  softDeleteField: 'deletedAt',
  discriminator: { kind: 'server' },
}) {}

describe('_paginationDelegate — admin CQRS read seam', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ActiveRecordRegistry.configureForTest({ testModel: mockDelegate }, () => ({
      organizationId: 'org-1',
      permissions: new Set<string>(),
    }));
  });

  it('findMany injects the tenant, discriminator, and soft-delete pins into the WHERE', async () => {
    mockDelegate.findMany.mockResolvedValue([]);

    await PaginatedRecord._paginationDelegate().findMany({ where: { name: 'Alice' } });

    expect(mockDelegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { name: 'Alice', organizationId: 'org-1', kind: 'server', deletedAt: null },
      }),
    );
  });

  it('count rides the scoped proxy (tenant pin) and returns the numeric total', async () => {
    mockDelegate.count.mockResolvedValue(7);

    const total = await PaginatedRecord._paginationDelegate().count({ where: { name: 'Alice' } });

    expect(total).toBe(7);
    expect(mockDelegate.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { name: 'Alice', organizationId: 'org-1', kind: 'server', deletedAt: null },
      }),
    );
  });

  it('re-parses rows through a supplied opts.schema and strips fields outside it', async () => {
    const ProjectionSchema = z.object({ id: z.string(), label: z.string() });
    mockDelegate.findMany.mockResolvedValue([
      { id: '1', label: 'L1', secret: 'LEAK', organizationId: 'org-1', kind: 'server', deletedAt: null },
    ]);

    const rows = await PaginatedRecord._paginationDelegate({ schema: ProjectionSchema }).findMany({});

    expect(rows).toEqual([{ id: '1', label: 'L1' }]);
  });

  it('applies the soft-delete pin by default and omits it when includeDeleted is set', async () => {
    mockDelegate.findMany.mockResolvedValue([]);

    await PaginatedRecord._paginationDelegate().findMany({ where: {} });
    expect(mockDelegate.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ deletedAt: null }) }),
    );

    await PaginatedRecord._paginationDelegate({ includeDeleted: true }).findMany({ where: {} });
    const lastWhere = (mockDelegate.findMany.mock.calls.at(-1)?.[0] as { where: Record<string, unknown> }).where;
    expect(lastWhere).not.toHaveProperty('deletedAt');
    expect(lastWhere).toMatchObject({ organizationId: 'org-1', kind: 'server' });
  });
});
