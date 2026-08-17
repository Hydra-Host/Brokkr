import { ConflictException, NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry } from '@repo/active-record';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderRecord } from '../provider.record';

describe('ProviderRecord', () => {
  const mockDelegate = {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };

  const fullProvider = {
    id: 'p-1',
    name: 'Cogent',
    slug: 'cogent',
    description: 'Cogent Communications',
    comments: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    ActiveRecordRegistry.configureForTest({ provider: mockDelegate }, () => ({
      organizationId: 'org-1',
      system: true,
    }));
  });

  afterEach(() => vi.clearAllMocks());

  it('lists with no filter', async () => {
    mockDelegate.findMany.mockResolvedValue([fullProvider]);
    const result = await ProviderRecord.list();
    expect(mockDelegate.findMany).toHaveBeenCalledWith({
      where: undefined,
      orderBy: { name: 'asc' },
    });
    expect(result).toHaveLength(1);
  });

  it('lists with case-insensitive search over name and slug', async () => {
    mockDelegate.findMany.mockResolvedValue([]);
    await ProviderRecord.list('cog');
    expect(mockDelegate.findMany).toHaveBeenCalledWith({
      where: {
        OR: [{ name: { contains: 'cog', mode: 'insensitive' } }, { slug: { contains: 'cog', mode: 'insensitive' } }],
      },
      orderBy: { name: 'asc' },
    });
  });

  it('finds by id or throws', async () => {
    mockDelegate.findFirst.mockResolvedValueOnce(fullProvider);
    const found = await ProviderRecord.findByIdOrThrow('p-1');
    expect(found.data.id).toBe('p-1');

    mockDelegate.findFirst.mockResolvedValueOnce(null);
    await expect(ProviderRecord.findByIdOrThrow('missing')).rejects.toThrow(NotFoundException);
  });

  it('creates with unique slug', async () => {
    mockDelegate.findFirst.mockResolvedValue(null);
    mockDelegate.create.mockResolvedValue(fullProvider);

    const result = await ProviderRecord.createOne({ name: 'Cogent', slug: 'cogent' });

    expect(mockDelegate.create).toHaveBeenCalledWith({
      data: { name: 'Cogent', slug: 'cogent' },
    });
    expect(result.data.id).toBe('p-1');
  });

  it('rejects duplicate slug on create', async () => {
    mockDelegate.findFirst.mockResolvedValue({ id: 'existing' });
    await expect(ProviderRecord.createOne({ name: 'Cogent', slug: 'cogent' })).rejects.toThrow(ConflictException);
    expect(mockDelegate.create).not.toHaveBeenCalled();
  });

  it('updates a provider', async () => {
    mockDelegate.findUnique.mockResolvedValue(fullProvider);
    mockDelegate.findFirst.mockResolvedValue(null);
    mockDelegate.update.mockResolvedValue({ ...fullProvider, name: 'Cogent Renamed' });

    const result = await ProviderRecord.updateById('p-1', { name: 'Cogent Renamed' });
    expect(result.data.name).toBe('Cogent Renamed');
  });

  it('rejects update when slug collides with a different record', async () => {
    mockDelegate.findUnique.mockResolvedValue(fullProvider);
    mockDelegate.findFirst.mockResolvedValue({ id: 'other' });

    await expect(ProviderRecord.updateById('p-1', { slug: 'cogent' })).rejects.toThrow(ConflictException);
  });

  it('throws NotFoundException updating missing record', async () => {
    mockDelegate.findUnique.mockResolvedValue(null);
    await expect(ProviderRecord.updateById('missing', { name: 'x' })).rejects.toThrow(NotFoundException);
  });

  it('deletes a provider', async () => {
    mockDelegate.findUnique.mockResolvedValue(fullProvider);
    await ProviderRecord.deleteById('p-1');
    expect(mockDelegate.delete).toHaveBeenCalledWith({ where: { id: 'p-1' } });
  });

  it('throws NotFoundException deleting missing record', async () => {
    mockDelegate.findUnique.mockResolvedValue(null);
    await expect(ProviderRecord.deleteById('missing')).rejects.toThrow(NotFoundException);
  });
});
