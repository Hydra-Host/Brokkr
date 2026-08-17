import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ActiveRecordRegistry } from '../active-record.registry';
import { TenantContextRequiredError } from '../active-record.types';
import { createActiveRecord } from '../create-active-record';


const ServerSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  organizationId: z.string(),
  deletedAt: z.date().nullable(),
});

const mockDelegate = {
  findUnique: vi.fn(),
  findUniqueOrThrow: vi.fn(),
  findFirst: vi.fn(),
  findFirstOrThrow: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
  aggregate: vi.fn(),
  groupBy: vi.fn(),
  create: vi.fn(),
  createMany: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  delete: vi.fn(),
  deleteMany: vi.fn(),
  upsert: vi.fn(),
};

class ServerRecord extends createActiveRecord(ServerSchema, 'device', {
  tenantField: 'organizationId',
  discriminator: { role: 'Server' },
  softDeleteField: 'deletedAt',
}) {}

class NoTenantServerRecord extends createActiveRecord(ServerSchema, 'device', {
  discriminator: { role: 'Server' },
  softDeleteField: 'deletedAt',
}) {}

beforeEach(() => {
  vi.clearAllMocks();
  ActiveRecordRegistry.configureForTest({ device: mockDelegate }, () => ({
    organizationId: 'org-1',
    permissions: new Set<string>(),
  }));
});

describe('discriminator + softDelete — class-creation validation', () => {
  it('throws when a discriminator key is not declared on the schema', () => {
    expect(() =>
      createActiveRecord(
        z.object({ id: z.string(), name: z.string() }),
        'device',
        // @ts-expect-error — the type system rejects this too; runtime check is the safety net.
        { discriminator: { role: 'Server' } },
      ),
    ).toThrow(/discriminator key "role" is not declared on the schema/);
  });

  it('throws when softDeleteField is not declared on the schema', () => {
    expect(() =>
      createActiveRecord(
        z.object({ id: z.string(), name: z.string() }),
        'device',
        // @ts-expect-error — type system rejects; runtime guard is the safety net.
        { softDeleteField: 'deletedAt' },
      ),
    ).toThrow(/softDeleteField "deletedAt" is not declared/);
  });

  it('accepts a valid discriminator + softDeleteField pair', () => {
    expect(() =>
      createActiveRecord(ServerSchema, 'device', {
        discriminator: { role: 'Server' },
        softDeleteField: 'deletedAt',
      }),
    ).not.toThrow();
  });
});

describe('discriminator pins — read-side strict override', () => {
  it('injects role + deletedAt + tenantField on findById', async () => {
    mockDelegate.findFirst.mockResolvedValue(null);
    await ServerRecord.findById('rec-1');

    expect(mockDelegate.findFirst).toHaveBeenCalledWith({
      where: { id: 'rec-1', role: 'Server', deletedAt: null, organizationId: 'org-1' },
    });
  });

  it('injects role + deletedAt + tenantField on findMany', async () => {
    mockDelegate.findMany.mockResolvedValue([]);
    await ServerRecord.findMany({ where: { name: 'srv-1' } });

    expect(mockDelegate.findMany).toHaveBeenCalledWith({
      where: { name: 'srv-1', role: 'Server', deletedAt: null, organizationId: 'org-1' },
    });
  });

  it('overrides an explicit role in caller args with the policy value (strict lock)', async () => {
    mockDelegate.findMany.mockResolvedValue([]);
    await ServerRecord.findMany({ where: { role: 'Bridge' } });

    expect(mockDelegate.findMany).toHaveBeenCalledWith({
      where: { role: 'Server', deletedAt: null, organizationId: 'org-1' },
    });
  });

  it('default-applies deletedAt=null when the caller omits it', async () => {
    mockDelegate.findMany.mockResolvedValue([]);
    await ServerRecord.findMany();

    expect(mockDelegate.findMany).toHaveBeenCalledWith({
      where: { role: 'Server', deletedAt: null, organizationId: 'org-1' },
    });
  });

  it('honors a caller-supplied deletedAt filter (default-apply, not override)', async () => {
    mockDelegate.findMany.mockResolvedValue([]);
    await ServerRecord.findMany({ where: { deletedAt: { not: null } } });

    expect(mockDelegate.findMany).toHaveBeenCalledWith({
      where: { deletedAt: { not: null }, role: 'Server', organizationId: 'org-1' },
    });
  });

  it('opts out of the soft-delete pin when includeDeleted=true', async () => {
    mockDelegate.findMany.mockResolvedValue([]);
    await ServerRecord.findMany({ where: { name: 'srv-1' } }, { includeDeleted: true });

    expect(mockDelegate.findMany).toHaveBeenCalledWith({
      where: { name: 'srv-1', role: 'Server', organizationId: 'org-1' },
    });
  });

  it('opts out of the soft-delete pin on findById when includeDeleted=true', async () => {
    mockDelegate.findFirst.mockResolvedValue(null);
    await ServerRecord.findById('rec-1', { includeDeleted: true });

    expect(mockDelegate.findFirst).toHaveBeenCalledWith({
      where: { id: 'rec-1', role: 'Server', organizationId: 'org-1' },
    });
  });

  it('still pins role even with includeDeleted=true', async () => {
    mockDelegate.findMany.mockResolvedValue([]);
    await ServerRecord.findMany({ where: { role: 'Bridge' } }, { includeDeleted: true });

    expect(mockDelegate.findMany).toHaveBeenCalledWith({
      where: { role: 'Server', organizationId: 'org-1' },
    });
  });
});

describe('discriminator pins — Unscoped finders bypass tenant only', () => {
  it('findManyUnscoped still pins role and deletedAt (only tenant is bypassed)', async () => {
    mockDelegate.findMany.mockResolvedValue([]);
    await ServerRecord.findManyUnscoped({ where: { name: 'srv-1' } });

    expect(mockDelegate.findMany).toHaveBeenCalledWith({
      where: { name: 'srv-1', role: 'Server', deletedAt: null },
    });
  });

  it('findByIdUnscoped pins role and deletedAt and uses findUnique (no relation filter)', async () => {
    mockDelegate.findUnique.mockResolvedValue(null);
    await ServerRecord.findByIdUnscoped('rec-1');

    expect(mockDelegate.findUnique).toHaveBeenCalledWith({
      where: { id: 'rec-1', role: 'Server', deletedAt: null },
    });
  });

  it('findManyUnscoped + includeDeleted bypasses both tenant and soft-delete', async () => {
    mockDelegate.findMany.mockResolvedValue([]);
    await ServerRecord.findManyUnscoped({ where: { name: 'srv-1' } }, { includeDeleted: true });

    expect(mockDelegate.findMany).toHaveBeenCalledWith({
      where: { name: 'srv-1', role: 'Server' },
    });
  });
});

describe('discriminator pins — build() auto-fill', () => {
  it('auto-fills the discriminator column on a new record', () => {
    const record = ServerRecord.build({ name: 'srv-1' });
    expect(record.data.role).toBe('Server');
  });

  it('auto-fills tenant + discriminator together', () => {
    const record = ServerRecord.build({ name: 'srv-1' });
    expect(record.data.role).toBe('Server');
    expect(record.data.organizationId).toBe('org-1');
  });

  it('does not overwrite an explicit discriminator value in build input', () => {
    const record = ServerRecord.build({ name: 'srv-1', role: 'Bridge' });
    expect(record.data.role).toBe('Bridge');
  });

  it('save() on a built record emits the auto-filled discriminator into create', async () => {
    mockDelegate.create.mockResolvedValue({
      id: 'gen-id',
      name: 'srv-1',
      role: 'Server',
      organizationId: 'org-1',
      deletedAt: null,
    });

    const record = ServerRecord.build({ name: 'srv-1' });
    await record.save();

    expect(mockDelegate.create).toHaveBeenCalledWith({
      data: { name: 'srv-1', role: 'Server', organizationId: 'org-1' },
    });
  });

  it('does NOT auto-fill object-valued discriminators (Prisma filter shapes)', () => {
    class MultiRoleRecord extends createActiveRecord(ServerSchema, 'device', {
      tenantField: 'organizationId',
      discriminator: { role: { in: ['Server', 'Bridge'] } },
    }) {}

    const record = MultiRoleRecord.build({ name: 'srv-1' });
    expect(record.data.role).toBeUndefined();
  });
});

describe('discriminator pins — write-side _scopeWhere', () => {
  it('appends discriminator pins to update WHERE on save()', async () => {
    const row = {
      id: '1',
      name: 'Alice',
      role: 'Server',
      organizationId: 'org-1',
      deletedAt: null,
    };
    mockDelegate.findFirst.mockResolvedValue(row);
    mockDelegate.update.mockResolvedValue({ ...row, name: 'Bob' });

    const record = await ServerRecord.findById('1');
    record.set({ name: 'Bob' });
    await record.save();

    expect(mockDelegate.update).toHaveBeenCalledWith({
      where: { id: '1', organizationId: 'org-1', role: 'Server' },
      data: { name: 'Bob' },
    });
  });

  it('soft-deletes by default when softDeleteField is set (scoped UPDATE, not DELETE)', async () => {
    const row = {
      id: '1',
      name: 'Alice',
      role: 'Server',
      organizationId: 'org-1',
      deletedAt: null,
    };
    mockDelegate.findFirst.mockResolvedValue(row);
    mockDelegate.update.mockResolvedValue({ ...row, deletedAt: new Date('2026-06-02') });

    const record = await ServerRecord.findById('1');
    await record.delete();

    expect(mockDelegate.delete).not.toHaveBeenCalled();
    expect(mockDelegate.update).toHaveBeenCalledWith({
      where: { id: '1', organizationId: 'org-1', role: 'Server' },
      data: { deletedAt: expect.any(Date) },
    });
    expect(record.isDeleted).toBe(true);
    expect(record.data.deletedAt).toEqual(new Date('2026-06-02'));
  });

  it('does NOT append softDeleteField to write WHERE clauses', async () => {
    const row = {
      id: '1',
      name: 'Alice',
      role: 'Server',
      organizationId: 'org-1',
      deletedAt: new Date('2026-01-01'),
    };
    mockDelegate.update.mockResolvedValue({ ...row, name: 'Bob' });
    const record = ServerRecord.fromRow(row);
    record.set({ name: 'Bob' });
    await record.save();

    const call = mockDelegate.update.mock.calls[0][0];
    expect(call.where).not.toHaveProperty('deletedAt');
  });

  it('discriminator pin without tenantField still threads into _scopeWhere', async () => {
    ActiveRecordRegistry.configureForTest({ device: mockDelegate });
    const row = { id: '1', name: 'Alice', role: 'Server', organizationId: 'org-1', deletedAt: null };
    mockDelegate.update.mockResolvedValue({ ...row, name: 'Bob' });

    const record = NoTenantServerRecord.fromRow(row);
    record.set({ name: 'Bob' });
    await record.save();

    expect(mockDelegate.update).toHaveBeenCalledWith({
      where: { id: '1', role: 'Server' },
      data: { name: 'Bob' },
    });
  });
});

describe('discriminator + soft-delete — strict mode without ctx', () => {
  beforeEach(() => {
    ActiveRecordRegistry.configureForTest({ device: mockDelegate }, () => undefined);
  });

  it('still throws TenantContextRequiredError when tenantField has no ctx and no explicit value', async () => {
    await expect(ServerRecord.findMany()).rejects.toThrow(TenantContextRequiredError);
  });

  it('NoTenantServerRecord works without ctx (no tenant pin to enforce)', async () => {
    mockDelegate.findMany.mockResolvedValue([]);
    await NoTenantServerRecord.findMany();

    expect(mockDelegate.findMany).toHaveBeenCalledWith({
      where: { role: 'Server', deletedAt: null },
    });
  });

  it('NoTenantServerRecord build() does not require ctx', () => {
    expect(() => NoTenantServerRecord.build({ name: 'srv-1', organizationId: 'org-x' })).not.toThrow();
  });
});

describe('discriminator + soft-delete — aggregate readers via _delegate()', () => {
  it('count auto-applies all pins', async () => {
    mockDelegate.count.mockResolvedValue(0);
    await ServerRecord._delegate().count({ where: { name: 'srv-1' } });

    expect(mockDelegate.count).toHaveBeenCalledWith({
      where: { name: 'srv-1', role: 'Server', deletedAt: null, organizationId: 'org-1' },
    });
  });

  it('groupBy auto-applies all pins', async () => {
    mockDelegate.groupBy.mockResolvedValue([]);
    await ServerRecord._delegate().groupBy({ by: ['name'], where: { name: 'srv-1' } });

    expect(mockDelegate.groupBy).toHaveBeenCalledWith({
      by: ['name'],
      where: { name: 'srv-1', role: 'Server', deletedAt: null, organizationId: 'org-1' },
    });
  });

  it('_delegate({ includeDeleted: true }).count omits soft-delete pin', async () => {
    mockDelegate.count.mockResolvedValue(0);
    await ServerRecord._delegate(undefined, { includeDeleted: true }).count({ where: {} });

    expect(mockDelegate.count).toHaveBeenCalledWith({
      where: { role: 'Server', organizationId: 'org-1' },
    });
  });
});
