import { ConflictException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IpamRoleRepository } from '../ipam-role.repository';

describe('IpamRoleRepository', () => {
  let mockPrisma: {
    ipamPrefixVlanRole: {
      findMany: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };
  };
  let repo: IpamRoleRepository;

  beforeEach(() => {
    mockPrisma = {
      ipamPrefixVlanRole: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
    };
    repo = new IpamRoleRepository(mockPrisma as any);
  });

  it('creates an IPAM role with default weight', async () => {
    mockPrisma.ipamPrefixVlanRole.findFirst.mockResolvedValue(null);
    const created = { id: 'ir-1', name: 'Production', slug: 'production', weight: 1000, description: 'Prod subnets' };
    mockPrisma.ipamPrefixVlanRole.create.mockResolvedValue(created);

    const result = await repo.create({ name: 'Production', slug: 'production', description: 'Prod subnets' });

    expect(result).toEqual(created);
    expect(mockPrisma.ipamPrefixVlanRole.create).toHaveBeenCalledWith({
      data: { name: 'Production', slug: 'production', weight: 1000, description: 'Prod subnets' },
    });
  });

  it('rejects duplicate slug', async () => {
    mockPrisma.ipamPrefixVlanRole.findFirst.mockResolvedValue({ id: 'existing', slug: 'production' });

    await expect(repo.create({ name: 'Production', slug: 'production' })).rejects.toThrow(ConflictException);
    await expect(repo.create({ name: 'Production', slug: 'production' })).rejects.toThrow(
      'IPAM role slug must be unique',
    );
  });

  it('updates an IPAM role', async () => {
    mockPrisma.ipamPrefixVlanRole.findUnique.mockResolvedValue({ id: 'ir-1', name: 'Production', slug: 'production' });
    mockPrisma.ipamPrefixVlanRole.findFirst.mockResolvedValue(null);
    const updated = { id: 'ir-1', name: 'Management', slug: 'management', weight: 500 };
    mockPrisma.ipamPrefixVlanRole.update.mockResolvedValue(updated);

    const result = await repo.update('ir-1', { name: 'Management', slug: 'management', weight: 500 });

    expect(result).toEqual(updated);
    expect(mockPrisma.ipamPrefixVlanRole.update).toHaveBeenCalledWith({
      where: { id: 'ir-1' },
      data: { name: 'Management', slug: 'management', weight: 500 },
    });
  });

  it('rejects duplicate slug on update', async () => {
    mockPrisma.ipamPrefixVlanRole.findUnique.mockResolvedValue({ id: 'ir-1', name: 'Production', slug: 'production' });
    mockPrisma.ipamPrefixVlanRole.findFirst.mockResolvedValue({ id: 'ir-2', slug: 'management' });

    await expect(repo.update('ir-1', { slug: 'management' })).rejects.toThrow(ConflictException);
    await expect(repo.update('ir-1', { slug: 'management' })).rejects.toThrow('IPAM role slug must be unique');
  });

  it('deletes an IPAM role', async () => {
    mockPrisma.ipamPrefixVlanRole.findUnique.mockResolvedValue({ id: 'ir-1' });

    await repo.delete('ir-1');

    expect(mockPrisma.ipamPrefixVlanRole.delete).toHaveBeenCalledWith({ where: { id: 'ir-1' } });
  });

  it('throws NotFoundException when updating non-existent record', async () => {
    mockPrisma.ipamPrefixVlanRole.findUnique.mockResolvedValue(null);

    await expect(repo.update('ir-missing', { name: 'Management' })).rejects.toThrow(NotFoundException);
    await expect(repo.update('ir-missing', { name: 'Management' })).rejects.toThrow('IPAM role not found');
  });

  it('throws NotFoundException when deleting non-existent record', async () => {
    mockPrisma.ipamPrefixVlanRole.findUnique.mockResolvedValue(null);

    await expect(repo.delete('ir-missing')).rejects.toThrow(NotFoundException);
    await expect(repo.delete('ir-missing')).rejects.toThrow('IPAM role not found');
  });

  it('throws NotFoundException when finding by non-existent ID', async () => {
    mockPrisma.ipamPrefixVlanRole.findUnique.mockResolvedValue(null);

    await expect(repo.findById('ir-missing')).rejects.toThrow(NotFoundException);
    await expect(repo.findById('ir-missing')).rejects.toThrow('IPAM role not found');
  });
});
