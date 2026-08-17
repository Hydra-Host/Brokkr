import { ConflictException, NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry } from '@repo/active-record';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderNetworkRecord } from '../provider-network.record';

describe('ProviderNetworkRecord', () => {
  const mockDelegate = {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };

  const mockProviderDelegate = {
    findFirst: vi.fn(),
  };

  const fullNetwork = {
    id: 'pn-1',
    name: 'Cogent MPLS Backbone',
    description: null,
    comments: null,
    providerId: 'provider-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const fullProvider = {
    id: 'provider-1',
    name: 'Cogent',
    slug: 'cogent',
    description: null,
    comments: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    ActiveRecordRegistry.configureForTest({ providerNetwork: mockDelegate, provider: mockProviderDelegate }, () => ({
      organizationId: 'org-1',
      system: true,
    }));
  });

  afterEach(() => vi.clearAllMocks());

  it('lists all networks with no providerId filter', async () => {
    mockDelegate.findMany.mockResolvedValue([fullNetwork]);
    const result = await ProviderNetworkRecord.list();
    expect(mockDelegate.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: { name: 'asc' },
    });
    expect(result).toHaveLength(1);
  });

  it('lists networks filtered by providerId', async () => {
    mockDelegate.findMany.mockResolvedValue([]);
    await ProviderNetworkRecord.list({ providerId: 'provider-1' });
    expect(mockDelegate.findMany).toHaveBeenCalledWith({
      where: { providerId: 'provider-1' },
      orderBy: { name: 'asc' },
    });
  });

  it('filters by name case-insensitively when search is given', async () => {
    mockDelegate.findMany.mockResolvedValue([]);
    await ProviderNetworkRecord.list({ search: 'core' });
    expect(mockDelegate.findMany).toHaveBeenCalledWith({
      where: { name: { contains: 'core', mode: 'insensitive' } },
      orderBy: { name: 'asc' },
    });
  });

  it('finds by id or throws', async () => {
    mockDelegate.findFirst.mockResolvedValueOnce(fullNetwork);
    const found = await ProviderNetworkRecord.findByIdOrThrow('pn-1');
    expect(found.data.id).toBe('pn-1');

    mockDelegate.findFirst.mockResolvedValueOnce(null);
    await expect(ProviderNetworkRecord.findByIdOrThrow('missing')).rejects.toThrow(NotFoundException);
  });

  it('creates a network when provider exists and name is unique', async () => {
    mockProviderDelegate.findFirst.mockResolvedValue(fullProvider);
    mockDelegate.findFirst.mockResolvedValue(null);
    mockDelegate.create.mockResolvedValue(fullNetwork);

    const result = await ProviderNetworkRecord.createOne({
      name: 'Cogent MPLS Backbone',
      providerId: 'provider-1',
    });

    expect(mockDelegate.create).toHaveBeenCalledWith({
      data: { name: 'Cogent MPLS Backbone', providerId: 'provider-1' },
    });
    expect(result.data.id).toBe('pn-1');
  });

  it('rejects create when the referenced provider is missing', async () => {
    mockProviderDelegate.findFirst.mockResolvedValue(null);
    await expect(ProviderNetworkRecord.createOne({ name: 'n', providerId: 'nope' })).rejects.toThrow(NotFoundException);
    expect(mockDelegate.create).not.toHaveBeenCalled();
  });

  it('rejects duplicate name within the same provider', async () => {
    mockProviderDelegate.findFirst.mockResolvedValue(fullProvider);
    mockDelegate.findFirst.mockResolvedValue({ id: 'existing' });

    await expect(ProviderNetworkRecord.createOne({ name: 'n', providerId: 'provider-1' })).rejects.toThrow(
      ConflictException,
    );
    expect(mockDelegate.create).not.toHaveBeenCalled();
  });

  it('updates a network', async () => {
    mockDelegate.findUnique.mockResolvedValue(fullNetwork);
    mockDelegate.findFirst.mockResolvedValue(null);
    mockDelegate.update.mockResolvedValue({ ...fullNetwork, name: 'Renamed' });

    const result = await ProviderNetworkRecord.updateById('pn-1', { name: 'Renamed' });
    expect(result.data.name).toBe('Renamed');
  });

  it('scopes the update name-uniqueness check to the existing providerId', async () => {
    mockDelegate.findUnique.mockResolvedValue(fullNetwork);
    mockDelegate.findFirst.mockResolvedValue(null);
    mockDelegate.update.mockResolvedValue(fullNetwork);

    await ProviderNetworkRecord.updateById('pn-1', { name: 'NewName' });

    expect(mockDelegate.findFirst).toHaveBeenCalledWith({
      where: { providerId: 'provider-1', name: 'NewName', id: { not: 'pn-1' } },
    });
  });

  it('rejects update when a sibling in the same provider has the new name', async () => {
    mockDelegate.findUnique.mockResolvedValue(fullNetwork);
    mockDelegate.findFirst.mockResolvedValue({ id: 'other' });

    await expect(ProviderNetworkRecord.updateById('pn-1', { name: 'NewName' })).rejects.toThrow(ConflictException);
  });

  it('throws NotFoundException updating missing record', async () => {
    mockDelegate.findUnique.mockResolvedValue(null);
    await expect(ProviderNetworkRecord.updateById('missing', { name: 'x' })).rejects.toThrow(NotFoundException);
  });

  it('deletes a network', async () => {
    mockDelegate.findUnique.mockResolvedValue(fullNetwork);
    await ProviderNetworkRecord.deleteById('pn-1');
    expect(mockDelegate.delete).toHaveBeenCalledWith({ where: { id: 'pn-1' } });
  });

  it('throws NotFoundException deleting missing record', async () => {
    mockDelegate.findUnique.mockResolvedValue(null);
    await expect(ProviderNetworkRecord.deleteById('missing')).rejects.toThrow(NotFoundException);
  });
});
