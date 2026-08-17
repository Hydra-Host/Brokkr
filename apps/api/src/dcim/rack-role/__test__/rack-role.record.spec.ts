import { ConflictException, NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry } from '@repo/active-record';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RackRoleRecord } from '../rack-role.record';

describe('RackRoleRecord', () => {
  const mockDelegate = {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };

  const fullRole = {
    id: 'rr-1',
    name: 'Compute',
    slug: 'compute',
    color: '#3b82f6',
    description: 'Compute rack',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    ActiveRecordRegistry.configureForTest({ dcimRackRole: mockDelegate }, () => ({
      organizationId: 'org-1',
      system: true,
    }));
  });

  afterEach(() => vi.clearAllMocks());

  it('lists with no filter', async () => {
    mockDelegate.findMany.mockResolvedValue([fullRole]);
    const result = await RackRoleRecord.list();
    expect(mockDelegate.findMany).toHaveBeenCalledWith({
      where: undefined,
      orderBy: { name: 'asc' },
    });
    expect(result).toHaveLength(1);
  });

  it('lists with case-insensitive search over name and slug', async () => {
    mockDelegate.findMany.mockResolvedValue([]);
    await RackRoleRecord.list('comp');
    expect(mockDelegate.findMany).toHaveBeenCalledWith({
      where: {
        OR: [{ name: { contains: 'comp', mode: 'insensitive' } }, { slug: { contains: 'comp', mode: 'insensitive' } }],
      },
      orderBy: { name: 'asc' },
    });
  });

  it('finds by id or throws', async () => {
    mockDelegate.findFirst.mockResolvedValueOnce(fullRole);
    const found = await RackRoleRecord.findByIdOrThrow('rr-1');
    expect(found.data.id).toBe('rr-1');

    mockDelegate.findFirst.mockResolvedValueOnce(null);
    await expect(RackRoleRecord.findByIdOrThrow('missing')).rejects.toThrow(NotFoundException);
  });

  it('creates with unique slug', async () => {
    mockDelegate.findFirst.mockResolvedValue(null);
    mockDelegate.create.mockResolvedValue(fullRole);

    const result = await RackRoleRecord.createRole({ name: 'Compute', slug: 'compute' });

    expect(mockDelegate.create).toHaveBeenCalledWith({
      data: { name: 'Compute', slug: 'compute' },
    });
    expect(result.data.id).toBe('rr-1');
  });

  it('rejects duplicate slug on create', async () => {
    mockDelegate.findFirst.mockResolvedValue({ id: 'existing' });
    await expect(RackRoleRecord.createRole({ name: 'Compute', slug: 'compute' })).rejects.toThrow(ConflictException);
    expect(mockDelegate.create).not.toHaveBeenCalled();
  });

  it('updates a rack role', async () => {
    mockDelegate.findUnique.mockResolvedValue(fullRole);
    mockDelegate.findFirst.mockResolvedValue(null);
    mockDelegate.update.mockResolvedValue({ ...fullRole, name: 'Compute (Renamed)' });

    const result = await RackRoleRecord.updateById('rr-1', { name: 'Compute (Renamed)' });
    expect(result.data.name).toBe('Compute (Renamed)');
  });

  it('rejects update when slug collides', async () => {
    mockDelegate.findUnique.mockResolvedValue(fullRole);
    mockDelegate.findFirst.mockResolvedValue({ id: 'other' });

    await expect(RackRoleRecord.updateById('rr-1', { slug: 'compute' })).rejects.toThrow(ConflictException);
  });

  it('throws NotFoundException updating missing record', async () => {
    mockDelegate.findUnique.mockResolvedValue(null);
    await expect(RackRoleRecord.updateById('missing', { name: 'x' })).rejects.toThrow(NotFoundException);
  });

  it('deletes a rack role', async () => {
    mockDelegate.findUnique.mockResolvedValue(fullRole);
    await RackRoleRecord.deleteById('rr-1');
    expect(mockDelegate.delete).toHaveBeenCalledWith({ where: { id: 'rr-1' } });
  });

  it('throws NotFoundException deleting missing record', async () => {
    mockDelegate.findUnique.mockResolvedValue(null);
    await expect(RackRoleRecord.deleteById('missing')).rejects.toThrow(NotFoundException);
  });
});
