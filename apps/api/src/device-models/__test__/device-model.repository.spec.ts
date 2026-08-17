import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceModelRepository } from '../device-model.repository';

describe('DeviceModelRepository', () => {
  let mockPrisma: {
    deviceModel: {
      findMany: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };
  };
  let repo: DeviceModelRepository;

  beforeEach(() => {
    mockPrisma = {
      deviceModel: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
    };
    repo = new DeviceModelRepository(mockPrisma as any);
  });

  it('lists all device models when no manufacturer filter is given', async () => {
    mockPrisma.deviceModel.findMany.mockResolvedValue([]);
    await repo.list();
    expect(mockPrisma.deviceModel.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: undefined }));
  });

  it('filters by manufacturer case-insensitively when provided', async () => {
    mockPrisma.deviceModel.findMany.mockResolvedValue([]);
    await repo.list('Dell');
    expect(mockPrisma.deviceModel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { manufacturer: { equals: 'Dell', mode: 'insensitive' } } }),
    );
  });

  it('creates a device model', async () => {
    const created = {
      id: 'dm-1',
      manufacturer: 'Dell',
      model: 'PowerEdge R750',
      formFactor: '1U',
      description: 'Dell 1U rack server',
      isFullDepth: true,
      heightU: 1,
      maxPowerW: 800,
    };
    mockPrisma.deviceModel.create.mockResolvedValue(created);

    const result = await repo.create({
      manufacturer: 'Dell',
      model: 'PowerEdge R750',
      formFactor: '1U',
      description: 'Dell 1U rack server',
      isFullDepth: true,
      heightU: 1,
      maxPowerW: 800,
    });

    expect(result).toEqual(created);
    expect(mockPrisma.deviceModel.create).toHaveBeenCalledWith({
      data: {
        manufacturer: 'Dell',
        model: 'PowerEdge R750',
        formFactor: '1U',
        description: 'Dell 1U rack server',
        isFullDepth: true,
        heightU: 1,
        maxPowerW: 800,
      },
    });
  });

  it('updates a device model', async () => {
    mockPrisma.deviceModel.findUnique.mockResolvedValue({
      id: 'dm-1',
      manufacturer: 'Dell',
      model: 'PowerEdge R750',
    });
    const updated = { id: 'dm-1', manufacturer: 'Dell', model: 'PowerEdge R760' };
    mockPrisma.deviceModel.update.mockResolvedValue(updated);

    const result = await repo.update('dm-1', { model: 'PowerEdge R760' });

    expect(result).toEqual(updated);
    expect(mockPrisma.deviceModel.update).toHaveBeenCalledWith({
      where: { id: 'dm-1' },
      data: { model: 'PowerEdge R760' },
    });
  });

  it('deletes a device model', async () => {
    mockPrisma.deviceModel.findUnique.mockResolvedValue({ id: 'dm-1' });

    await repo.delete('dm-1');

    expect(mockPrisma.deviceModel.delete).toHaveBeenCalledWith({ where: { id: 'dm-1' } });
  });

  it('throws NotFoundException when updating non-existent record', async () => {
    mockPrisma.deviceModel.findUnique.mockResolvedValue(null);

    await expect(repo.update('dm-missing', { model: 'new-model' })).rejects.toThrow(NotFoundException);
    await expect(repo.update('dm-missing', { model: 'new-model' })).rejects.toThrow('Device model not found');
  });

  it('throws NotFoundException when deleting non-existent record', async () => {
    mockPrisma.deviceModel.findUnique.mockResolvedValue(null);

    await expect(repo.delete('dm-missing')).rejects.toThrow(NotFoundException);
    await expect(repo.delete('dm-missing')).rejects.toThrow('Device model not found');
  });
});
