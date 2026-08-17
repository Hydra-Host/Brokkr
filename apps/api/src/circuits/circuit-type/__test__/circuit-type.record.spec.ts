import { ConflictException, NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry } from '@repo/active-record';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CircuitTypeRecord } from '../circuit-type.record';

describe('CircuitTypeRecord', () => {
  const mockDelegate = {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };

  const fullType = {
    id: 'ct-1',
    name: 'Cross Connect',
    slug: 'cross-connect',
    color: '#22c55e',
    description: 'Meet-me-room cross connect',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockCircuitDelegate = {
    count: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    ActiveRecordRegistry.configureForTest({ circuitType: mockDelegate, circuit: mockCircuitDelegate }, () => ({
      organizationId: 'org-1',
      system: true,
    }));
  });

  afterEach(() => vi.clearAllMocks());

  it('lists with no filter', async () => {
    mockDelegate.findMany.mockResolvedValue([fullType]);
    const result = await CircuitTypeRecord.list();
    expect(mockDelegate.findMany).toHaveBeenCalledWith({
      where: undefined,
      orderBy: { name: 'asc' },
    });
    expect(result).toHaveLength(1);
  });

  it('lists with case-insensitive search over name and slug', async () => {
    mockDelegate.findMany.mockResolvedValue([]);
    await CircuitTypeRecord.list('cross');
    expect(mockDelegate.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { name: { contains: 'cross', mode: 'insensitive' } },
          { slug: { contains: 'cross', mode: 'insensitive' } },
        ],
      },
      orderBy: { name: 'asc' },
    });
  });

  it('finds by id or throws', async () => {
    mockDelegate.findFirst.mockResolvedValueOnce(fullType);
    const found = await CircuitTypeRecord.findByIdOrThrow('ct-1');
    expect(found.data.id).toBe('ct-1');

    mockDelegate.findFirst.mockResolvedValueOnce(null);
    await expect(CircuitTypeRecord.findByIdOrThrow('missing')).rejects.toThrow(NotFoundException);
  });

  it('creates with unique slug', async () => {
    mockDelegate.findFirst.mockResolvedValue(null);
    mockDelegate.create.mockResolvedValue(fullType);

    const result = await CircuitTypeRecord.createOne({ name: 'Cross Connect', slug: 'cross-connect' });

    expect(mockDelegate.create).toHaveBeenCalledWith({
      data: { name: 'Cross Connect', slug: 'cross-connect' },
    });
    expect(result.data.id).toBe('ct-1');
  });

  it('rejects duplicate slug on create', async () => {
    mockDelegate.findFirst.mockResolvedValue({ id: 'existing' });
    await expect(CircuitTypeRecord.createOne({ name: 'X', slug: 'cross-connect' })).rejects.toThrow(ConflictException);
    expect(mockDelegate.create).not.toHaveBeenCalled();
  });

  it('updates a circuit type', async () => {
    mockDelegate.findUnique.mockResolvedValue(fullType);
    mockDelegate.findFirst.mockResolvedValue(null);
    mockDelegate.update.mockResolvedValue({ ...fullType, name: 'Cross Connect (Renamed)' });

    const result = await CircuitTypeRecord.updateById('ct-1', { name: 'Cross Connect (Renamed)' });
    expect(result.data.name).toBe('Cross Connect (Renamed)');
  });

  it('rejects update when slug collides with a different record', async () => {
    mockDelegate.findUnique.mockResolvedValue(fullType);
    mockDelegate.findFirst.mockResolvedValue({ id: 'other' });

    await expect(CircuitTypeRecord.updateById('ct-1', { slug: 'cross-connect' })).rejects.toThrow(ConflictException);
  });

  it('throws NotFoundException updating missing record', async () => {
    mockDelegate.findUnique.mockResolvedValue(null);
    await expect(CircuitTypeRecord.updateById('missing', { name: 'x' })).rejects.toThrow(NotFoundException);
  });

  it('deletes a circuit type when no circuits reference it', async () => {
    mockDelegate.findUnique.mockResolvedValue(fullType);
    mockCircuitDelegate.count.mockResolvedValue(0);
    await CircuitTypeRecord.deleteById('ct-1');
    expect(mockDelegate.delete).toHaveBeenCalledWith({ where: { id: 'ct-1' } });
  });

  it('throws NotFoundException deleting missing record', async () => {
    mockDelegate.findUnique.mockResolvedValue(null);
    await expect(CircuitTypeRecord.deleteById('missing')).rejects.toThrow(NotFoundException);
  });

  it('rejects delete when circuits reference the type', async () => {
    mockDelegate.findUnique.mockResolvedValue(fullType);
    mockCircuitDelegate.count.mockResolvedValue(3);

    await expect(CircuitTypeRecord.deleteById('ct-1')).rejects.toThrow(ConflictException);
    await expect(CircuitTypeRecord.deleteById('ct-1')).rejects.toThrow(/in use by 3 circuits/);
    expect(mockDelegate.delete).not.toHaveBeenCalled();
  });
});
