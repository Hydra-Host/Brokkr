import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayRepository } from '../gateway.repository';

const expectedInclude = {
  gatewayIp: { select: { id: true, address: true } },
  vrf: { select: { id: true, name: true } },
};

describe('GatewayRepository', () => {
  let mockPrisma: {
    gateway: {
      findMany: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };
    prefix: { findUnique: ReturnType<typeof vi.fn> };
    ipAddress: { findUnique: ReturnType<typeof vi.fn> };
    vrf: { findUnique: ReturnType<typeof vi.fn> };
    $queryRaw: ReturnType<typeof vi.fn>;
  };
  let repo: GatewayRepository;

  beforeEach(() => {
    mockPrisma = {
      gateway: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
      prefix: { findUnique: vi.fn() },
      ipAddress: { findUnique: vi.fn() },
      vrf: { findUnique: vi.fn() },
      $queryRaw: vi.fn().mockResolvedValue([]),
    };
    repo = new GatewayRepository(mockPrisma as any);
  });

  it('customer scope: rejects create when parent prefix belongs to another tenant', async () => {
    mockPrisma.prefix.findUnique.mockResolvedValue(null);

    await expect(repo.create({ gatewayIpId: 'ip-1', prefixId: 'pfx-foreign' }, 'caller-org')).rejects.toThrow(
      ForbiddenException,
    );

    expect(mockPrisma.prefix.findUnique).toHaveBeenCalledWith({
      where: { id: 'pfx-foreign', organizationId: 'caller-org' },
      select: { id: true },
    });
    expect(mockPrisma.gateway.create).not.toHaveBeenCalled();
  });

  it('customer scope: creates gateway when all parent FKs belong to caller', async () => {
    mockPrisma.prefix.findUnique.mockResolvedValue({ id: 'pfx-1' });
    mockPrisma.ipAddress.findUnique.mockResolvedValue({ id: 'ip-1' });
    mockPrisma.vrf.findUnique.mockResolvedValue({ id: 'vrf-1' });
    const created = {
      id: 'gw-1',
      gatewayIpId: 'ip-1',
      prefixId: 'pfx-1',
      vrfId: 'vrf-1',
      routingPriority: 100,
      gatewayIp: { id: 'ip-1', address: '10.0.1.2/24' },
      vrf: { id: 'vrf-1', name: 'vrf-blue' },
    };
    mockPrisma.gateway.create.mockResolvedValue(created);
    mockPrisma.$queryRaw.mockResolvedValue([{ id: 'pfx-1', prefix: '10.0.1.0/24' }]);

    const result = await repo.create(
      { gatewayIpId: 'ip-1', prefixId: 'pfx-1', vrfId: 'vrf-1', routingPriority: 100 },
      'caller-org',
    );

    expect(result).toEqual({ ...created, prefix: { id: 'pfx-1', prefix: '10.0.1.0/24' } });
    expect(mockPrisma.gateway.create).toHaveBeenCalledWith({
      data: { gatewayIpId: 'ip-1', prefixId: 'pfx-1', vrfId: 'vrf-1', routingPriority: 100 },
      include: expectedInclude,
    });
  });

  it('admin scope (null): skips parent-ownership validation', async () => {
    const created = { id: 'gw-1', gatewayIpId: 'ip-1', prefixId: 'pfx-1' };
    mockPrisma.gateway.create.mockResolvedValue(created);
    mockPrisma.$queryRaw.mockResolvedValue([{ id: 'pfx-1', prefix: '10.0.1.0/24' }]);

    await repo.create({ gatewayIpId: 'ip-1', prefixId: 'pfx-1' }, null);

    expect(mockPrisma.prefix.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.gateway.create).toHaveBeenCalled();
  });

  it('customer scope: rejects update when gateway is in another tenant', async () => {
    mockPrisma.gateway.findUnique.mockResolvedValue(null);

    await expect(repo.update('gw-foreign', { gatewayIpId: 'ip-2' }, 'caller-org')).rejects.toThrow(NotFoundException);
    expect(mockPrisma.gateway.update).not.toHaveBeenCalled();
  });

  it('customer scope: rejects update that re-points gateway to another tenant prefix', async () => {
    mockPrisma.gateway.findUnique.mockResolvedValue({ id: 'gw-1', prefixId: 'pfx-1' });
    mockPrisma.prefix.findUnique.mockResolvedValue(null);

    await expect(repo.update('gw-1', { prefixId: 'pfx-foreign' }, 'caller-org')).rejects.toThrow(ForbiddenException);
    expect(mockPrisma.gateway.update).not.toHaveBeenCalled();
  });

  it('customer scope: updates allowed fields', async () => {
    mockPrisma.gateway.findUnique.mockResolvedValue({ id: 'gw-1', prefixId: 'pfx-1' });
    const updated = {
      id: 'gw-1',
      gatewayIpId: 'ip-2',
      prefixId: 'pfx-1',
      gatewayIp: { id: 'ip-2', address: '10.0.1.3/24' },
      vrf: null,
    };
    mockPrisma.gateway.update.mockResolvedValue(updated);
    mockPrisma.ipAddress.findUnique.mockResolvedValue({ id: 'ip-2' });
    mockPrisma.$queryRaw.mockResolvedValue([{ id: 'pfx-1', prefix: '10.0.1.0/24' }]);

    const result = await repo.update('gw-1', { gatewayIpId: 'ip-2' }, 'caller-org');

    expect(result).toEqual({ ...updated, prefix: { id: 'pfx-1', prefix: '10.0.1.0/24' } });
    expect(mockPrisma.gateway.update).toHaveBeenCalledWith({
      where: { id: 'gw-1' },
      data: { gatewayIpId: 'ip-2' },
      include: expectedInclude,
    });
  });

  it('customer scope: rejects delete on foreign gateway', async () => {
    mockPrisma.gateway.findUnique.mockResolvedValue(null);

    await expect(repo.delete('gw-foreign', 'caller-org')).rejects.toThrow(NotFoundException);
    expect(mockPrisma.gateway.delete).not.toHaveBeenCalled();
  });

  it('customer scope: deletes gateway', async () => {
    mockPrisma.gateway.findUnique.mockResolvedValue({ id: 'gw-1' });

    await repo.delete('gw-1', 'caller-org');

    expect(mockPrisma.gateway.delete).toHaveBeenCalledWith({ where: { id: 'gw-1' } });
  });

  it('customer findById filters via parent prefix organizationId', async () => {
    mockPrisma.gateway.findUnique.mockResolvedValue({ id: 'gw-1', prefixId: 'pfx-1' });
    mockPrisma.$queryRaw.mockResolvedValue([{ id: 'pfx-1', prefix: '10.0.1.0/24' }]);

    await repo.findById('gw-1', 'caller-org');

    expect(mockPrisma.gateway.findUnique).toHaveBeenCalledWith({
      where: { id: 'gw-1', prefix: { organizationId: 'caller-org' } },
      include: expectedInclude,
    });
  });

  it('customer list filters via parent prefix organizationId', async () => {
    mockPrisma.gateway.findMany.mockResolvedValue([]);

    await repo.list({ prefixId: 'pfx-1' }, 'caller-org');

    expect(mockPrisma.gateway.findMany).toHaveBeenCalledWith({
      where: { prefixId: 'pfx-1', prefix: { organizationId: 'caller-org' } },
      orderBy: { createdAt: 'desc' },
      include: expectedInclude,
    });
  });

  it('admin list (null scope) does not apply tenant filter', async () => {
    mockPrisma.gateway.findMany.mockResolvedValue([]);

    await repo.list({}, null);

    expect(mockPrisma.gateway.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: { createdAt: 'desc' },
      include: expectedInclude,
    });
  });

  it('list resolves prefix summaries via a single raw query and skips it when empty', async () => {
    const rows = [
      { id: 'gw-1', prefixId: 'pfx-1', gatewayIp: { id: 'ip-1', address: '10.0.1.2/24' }, vrf: null },
      { id: 'gw-2', prefixId: 'pfx-1', gatewayIp: { id: 'ip-2', address: '10.0.1.3/24' }, vrf: null },
    ];
    mockPrisma.gateway.findMany.mockResolvedValue(rows);
    mockPrisma.$queryRaw.mockResolvedValue([{ id: 'pfx-1', prefix: '10.0.1.0/24' }]);

    const result = await repo.list({}, null);

    expect(result).toEqual(rows.map((row) => ({ ...row, prefix: { id: 'pfx-1', prefix: '10.0.1.0/24' } })));
    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);

    mockPrisma.$queryRaw.mockClear();
    mockPrisma.gateway.findMany.mockResolvedValue([]);
    await expect(repo.list({}, null)).resolves.toEqual([]);
    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
  });
});
