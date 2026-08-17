import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VlanGroupRepository } from '../vlan-group.repository';

async function expectBadRequest(promise: Promise<unknown>, message: string): Promise<void> {
  const error = await promise.catch((error: unknown) => error);

  expect(error).toBeInstanceOf(BadRequestException);
  if (!(error instanceof BadRequestException)) {
    return;
  }
  expect(error.getStatus()).toBe(400);
  expect(error.message).toBe(message);
}

describe('VlanGroupRepository', () => {
  let mockPrisma: {
    vlanGroup: {
      findMany: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };
    zone: { findUnique: ReturnType<typeof vi.fn> };
  };
  let repo: VlanGroupRepository;

  beforeEach(() => {
    mockPrisma = {
      vlanGroup: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
      zone: { findUnique: vi.fn() },
    };
    repo = new VlanGroupRepository(mockPrisma as any);
  });

  it('customer scope: requires zoneId', async () => {
    await expect(repo.create({ name: 'no-zone', minVid: 2, maxVid: 100 }, 'caller-org')).rejects.toThrow(
      BadRequestException,
    );
    expect(mockPrisma.vlanGroup.create).not.toHaveBeenCalled();
  });

  it('customer scope: rejects create when zone belongs to another tenant', async () => {
    mockPrisma.zone.findUnique.mockResolvedValue(null);

    await expect(
      repo.create({ name: 'vg', minVid: 2, maxVid: 100, zoneId: 'zone-foreign' }, 'caller-org'),
    ).rejects.toThrow(ForbiddenException);
    expect(mockPrisma.zone.findUnique).toHaveBeenCalledWith({
      where: { id: 'zone-foreign', organizationId: 'caller-org' },
      select: { id: true },
    });
    expect(mockPrisma.vlanGroup.create).not.toHaveBeenCalled();
  });

  it('customer scope: creates VlanGroup when zone belongs to caller', async () => {
    mockPrisma.zone.findUnique.mockResolvedValue({ id: 'zone-1' });
    const created = { id: 'vg-1', name: 'vg', zoneId: 'zone-1', minVid: 2, maxVid: 100 };
    mockPrisma.vlanGroup.create.mockResolvedValue(created);

    const result = await repo.create({ name: 'vg', minVid: 2, maxVid: 100, zoneId: 'zone-1' }, 'caller-org');

    expect(result).toEqual(created);
    expect(mockPrisma.vlanGroup.create).toHaveBeenCalledWith({
      data: { name: 'vg', description: undefined, minVid: 2, maxVid: 100, zoneId: 'zone-1' },
    });
  });

  it('admin scope: allows zoneless create', async () => {
    const created = { id: 'vg-global', name: 'global', zoneId: null };
    mockPrisma.vlanGroup.create.mockResolvedValue(created);

    await repo.create({ name: 'global', minVid: 2, maxVid: 100 }, null);

    expect(mockPrisma.zone.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.vlanGroup.create).toHaveBeenCalled();
  });

  it('rejects create with an out-of-range minVid', async () => {
    mockPrisma.zone.findUnique.mockResolvedValue({ id: 'zone-1' });

    await expectBadRequest(
      repo.create({ name: 'vg', minVid: 1, maxVid: 100, zoneId: 'zone-1' }, 'caller-org'),
      'minVid must be between 2 and 4094 (got 1)',
    );
    expect(mockPrisma.vlanGroup.create).not.toHaveBeenCalled();
  });

  it('rejects create with an out-of-range maxVid', async () => {
    mockPrisma.zone.findUnique.mockResolvedValue({ id: 'zone-1' });

    await expectBadRequest(
      repo.create({ name: 'vg', minVid: 2, maxVid: 4095, zoneId: 'zone-1' }, 'caller-org'),
      'maxVid must be between 2 and 4094 (got 4095)',
    );
    expect(mockPrisma.vlanGroup.create).not.toHaveBeenCalled();
  });

  it('denies foreign-zone create before validating vids', async () => {
    mockPrisma.zone.findUnique.mockResolvedValue(null);

    await expect(
      repo.create({ name: 'vg', minVid: 1, maxVid: 100, zoneId: 'zone-foreign' }, 'caller-org'),
    ).rejects.toThrow(ForbiddenException);
    expect(mockPrisma.vlanGroup.create).not.toHaveBeenCalled();
  });

  it('rejects create with inverted min/max bounds', async () => {
    mockPrisma.zone.findUnique.mockResolvedValue({ id: 'zone-1' });

    await expect(repo.create({ name: 'vg', minVid: 200, maxVid: 100, zoneId: 'zone-1' }, 'caller-org')).rejects.toThrow(
      BadRequestException,
    );
    expect(mockPrisma.vlanGroup.create).not.toHaveBeenCalled();
  });

  it('customer scope: rejects update of zoneless (global) group', async () => {
    mockPrisma.vlanGroup.findUnique.mockResolvedValue({ id: 'vg-global', zoneId: null });

    await expect(repo.update('vg-global', { name: 'hijack' }, 'caller-org')).rejects.toThrow(NotFoundException);
    expect(mockPrisma.vlanGroup.update).not.toHaveBeenCalled();
  });

  it('customer scope: rejects update of group in another tenant zone', async () => {
    mockPrisma.vlanGroup.findUnique.mockResolvedValue({ id: 'vg-1', zoneId: 'zone-foreign' });
    mockPrisma.zone.findUnique.mockResolvedValue(null);

    await expect(repo.update('vg-1', { name: 'hijack' }, 'caller-org')).rejects.toThrow(ForbiddenException);
    expect(mockPrisma.vlanGroup.update).not.toHaveBeenCalled();
  });

  it('customer scope: denies update of global group before validating vids', async () => {
    mockPrisma.vlanGroup.findUnique.mockResolvedValue({ id: 'vg-global', zoneId: null });

    await expect(repo.update('vg-global', { minVid: 1 }, 'caller-org')).rejects.toThrow(NotFoundException);
    expect(mockPrisma.vlanGroup.update).not.toHaveBeenCalled();
  });

  it('customer scope: denies cross-tenant update before validating vids', async () => {
    mockPrisma.vlanGroup.findUnique.mockResolvedValue({ id: 'vg-1', zoneId: 'zone-foreign' });
    mockPrisma.zone.findUnique.mockResolvedValue(null);

    await expect(repo.update('vg-1', { minVid: 1 }, 'caller-org')).rejects.toThrow(ForbiddenException);
    expect(mockPrisma.vlanGroup.update).not.toHaveBeenCalled();
  });


  it('customer scope: updates allowed fields', async () => {
    mockPrisma.vlanGroup.findUnique.mockResolvedValue({ id: 'vg-1', zoneId: 'zone-1' });
    mockPrisma.zone.findUnique.mockResolvedValue({ id: 'zone-1' });
    const updated = { id: 'vg-1', name: 'renamed', zoneId: 'zone-1' };
    mockPrisma.vlanGroup.update.mockResolvedValue(updated);

    await repo.update('vg-1', { name: 'renamed' }, 'caller-org');

    expect(mockPrisma.vlanGroup.update).toHaveBeenCalledWith({
      where: { id: 'vg-1' },
      data: { name: 'renamed' },
    });
  });

  it('rejects update whose new maxVid drops below the existing minVid', async () => {
    mockPrisma.vlanGroup.findUnique.mockResolvedValue({ id: 'vg-1', zoneId: 'zone-1', minVid: 100, maxVid: 200 });
    mockPrisma.zone.findUnique.mockResolvedValue({ id: 'zone-1' });

    await expect(repo.update('vg-1', { maxVid: 50 }, 'caller-org')).rejects.toThrow(BadRequestException);
    expect(mockPrisma.vlanGroup.update).not.toHaveBeenCalled();
  });

  it('admin scope: can move group between zones', async () => {
    mockPrisma.vlanGroup.findUnique.mockResolvedValue({ id: 'vg-1', zoneId: 'zone-1' });
    mockPrisma.vlanGroup.update.mockResolvedValue({ id: 'vg-1', zoneId: 'zone-2' });

    await repo.update('vg-1', { zoneId: 'zone-2' }, null);

    expect(mockPrisma.vlanGroup.update).toHaveBeenCalledWith({
      where: { id: 'vg-1' },
      data: { zoneId: 'zone-2' },
    });
  });

  it('customer scope: rejects delete of zoneless group', async () => {
    mockPrisma.vlanGroup.findUnique.mockResolvedValue({ id: 'vg-global', zoneId: null });

    await expect(repo.delete('vg-global', 'caller-org')).rejects.toThrow(NotFoundException);
    expect(mockPrisma.vlanGroup.delete).not.toHaveBeenCalled();
  });

  it('customer scope: rejects delete in another tenant zone', async () => {
    mockPrisma.vlanGroup.findUnique.mockResolvedValue({ id: 'vg-1', zoneId: 'zone-foreign' });
    mockPrisma.zone.findUnique.mockResolvedValue(null);

    await expect(repo.delete('vg-1', 'caller-org')).rejects.toThrow(ForbiddenException);
    expect(mockPrisma.vlanGroup.delete).not.toHaveBeenCalled();
  });

  it('customer scope: deletes own-zone group', async () => {
    mockPrisma.vlanGroup.findUnique.mockResolvedValue({ id: 'vg-1', zoneId: 'zone-1' });
    mockPrisma.zone.findUnique.mockResolvedValue({ id: 'zone-1' });

    await repo.delete('vg-1', 'caller-org');

    expect(mockPrisma.vlanGroup.delete).toHaveBeenCalledWith({ where: { id: 'vg-1' } });
  });

  it('customer findById uses OR-with-zoneless filter', async () => {
    mockPrisma.vlanGroup.findUnique.mockResolvedValue({ id: 'vg-1', zoneId: 'zone-1' });

    await repo.findById('vg-1', 'caller-org');

    expect(mockPrisma.vlanGroup.findUnique).toHaveBeenCalledWith({
      where: {
        id: 'vg-1',
        OR: [{ zone: { organizationId: 'caller-org' } }, { zoneId: null }],
      },
    });
  });

  it('customer findById throws NotFound for foreign-zone group', async () => {
    mockPrisma.vlanGroup.findUnique.mockResolvedValue(null);

    await expect(repo.findById('vg-foreign', 'caller-org')).rejects.toThrow(NotFoundException);
  });

  it('customer list includes own-zone + global vlan groups', async () => {
    mockPrisma.vlanGroup.findMany.mockResolvedValue([]);

    await repo.list({}, 'caller-org');

    expect(mockPrisma.vlanGroup.findMany).toHaveBeenCalledWith({
      where: { OR: [{ zone: { organizationId: 'caller-org' } }, { zoneId: null }] },
      orderBy: { name: 'asc' },
    });
  });

  it('admin list returns all groups', async () => {
    mockPrisma.vlanGroup.findMany.mockResolvedValue([]);

    await repo.list({}, null);

    expect(mockPrisma.vlanGroup.findMany).toHaveBeenCalledWith({
      where: undefined,
      orderBy: { name: 'asc' },
    });
  });

  it('throws NotFoundException when updating non-existent record', async () => {
    mockPrisma.vlanGroup.findUnique.mockResolvedValue(null);

    await expect(repo.update('vg-missing', { name: 'new' }, 'caller-org')).rejects.toThrow(NotFoundException);
  });

  it('throws NotFoundException when deleting non-existent record', async () => {
    mockPrisma.vlanGroup.findUnique.mockResolvedValue(null);

    await expect(repo.delete('vg-missing', 'caller-org')).rejects.toThrow(NotFoundException);
  });
});
