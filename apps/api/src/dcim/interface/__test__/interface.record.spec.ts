import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry } from '@repo/active-record';
import { InterfaceType } from '@repo/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertValidInterfaceName, assertValidMacAddress, InterfaceRecord } from '../interface.record';

describe('InterfaceRecord', () => {
  const mockDelegate = {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  };
  const mockIpAddress = { updateMany: vi.fn() };
  const mockDevice = { findUnique: vi.fn() };
  const mockVlan = { findUnique: vi.fn() };

  const supplierOrgId = 'supplier-org-1';
  const deviceId = 'device-1';

  const fullIface = {
    id: 'if-1',
    deviceId,
    name: 'eth0',
    type: InterfaceType.ETHERNET_25G,
    enabled: true,
    mtu: 1500,
    macAddress: null,
    speed: null,
    mgmtOnly: false,
    markConnected: false,
    mode: null,
    description: null,
    linkType: null,
    guid: null,
    portState: null,
    maxSpeedGbps: null,
    pciDeviceId: null,
    lldpNeighborName: null,
    lldpNeighborPort: null,
    lldpNeighborDescr: null,
    lldpNeighborMgmtIp: null,
    lagId: null,
    parentId: null,
    untaggedVlanId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    vi.resetAllMocks();
    ActiveRecordRegistry.configureForTest(
      {
        interface: mockDelegate,
        device: mockDevice,
        vlan: mockVlan,
        $transaction: vi.fn(async (cb: (tx: unknown) => unknown) =>
          cb({ interface: mockDelegate, ipAddress: mockIpAddress }),
        ),
      },
      () => ({
        organizationId: supplierOrgId,
        permissions: new Set(['dcim:read', 'dcim:create', 'dcim:update', 'dcim:delete']),
      }),
    );
  });

  afterEach(() => vi.resetAllMocks());

  describe('listPaginated', () => {
    beforeEach(() => {
      (mockDelegate as { count?: ReturnType<typeof vi.fn> }).count = vi.fn().mockResolvedValue(0);
    });

    it('applies default sort + page size + scoped where to both findMany and count', async () => {
      mockDelegate.findMany.mockResolvedValue([fullIface]);
      const countSpy = mockDelegate as unknown as { count: ReturnType<typeof vi.fn> };
      countSpy.count.mockResolvedValue(1);

      const result = await InterfaceRecord.listPaginated({});

      expect(mockDelegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { device: { supplierId: supplierOrgId } },
          orderBy: [{ name: 'asc' }],
          skip: 0,
          take: 50,
        }),
      );
      expect(countSpy.count).toHaveBeenCalledWith({
        where: { device: { supplierId: supplierOrgId } },
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].data.id).toBe('if-1');
      expect(result.meta).toEqual({ page: 1, pageSize: 50, totalItems: 1, totalPages: 1 });
    });

    it('merges discrete filter params (deviceId, type, enabled, linkType) into the scoped where', async () => {
      mockDelegate.findMany.mockResolvedValue([]);

      await InterfaceRecord.listPaginated({
        deviceId,
        type: InterfaceType.ETHERNET_25G,
        enabled: true,
        linkType: 'ETHERNET',
      });

      expect(mockDelegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            device: { supplierId: supplierOrgId },
            AND: [{ deviceId }, { type: InterfaceType.ETHERNET_25G }, { enabled: true }, { linkType: 'ETHERNET' }],
          },
        }),
      );
    });

    it('translates `search` into OR across searchable fields with case-insensitive contains', async () => {
      mockDelegate.findMany.mockResolvedValue([]);

      await InterfaceRecord.listPaginated({ search: 'eth0' });

      expect(mockDelegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            device: { supplierId: supplierOrgId },
            AND: [
              {
                OR: [
                  { name: { contains: 'eth0', mode: 'insensitive' } },
                  { macAddress: { contains: 'eth0', mode: 'insensitive' } },
                  { description: { contains: 'eth0', mode: 'insensitive' } },
                  { guid: { contains: 'eth0', mode: 'insensitive' } },
                  { lldpNeighborName: { contains: 'eth0', mode: 'insensitive' } },
                  { lldpNeighborMgmtIp: { contains: 'eth0', mode: 'insensitive' } },
                ],
              },
            ],
          }),
        }),
      );
    });

    it('honors page + pageSize and reports the right meta', async () => {
      const countSpy = mockDelegate as unknown as { count: ReturnType<typeof vi.fn> };
      mockDelegate.findMany.mockResolvedValue([]);
      countSpy.count.mockResolvedValue(127);

      const result = await InterfaceRecord.listPaginated({ page: 3, pageSize: 25 });

      expect(mockDelegate.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 50, take: 25 }));
      expect(result.meta).toEqual({ page: 3, pageSize: 25, totalItems: 127, totalPages: 6 });
    });

    it('parses sort and applies the requested direction, appending the default tie-breaker', async () => {
      mockDelegate.findMany.mockResolvedValue([]);

      await InterfaceRecord.listPaginated({ sort: 'createdAt:desc' });

      expect(mockDelegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: [{ createdAt: 'desc' }, { name: 'asc' }] }),
      );
    });

    it('falls back to default sort when the sort param references an unknown field', async () => {
      mockDelegate.findMany.mockResolvedValue([]);

      await InterfaceRecord.listPaginated({ sort: 'macAddress:asc' });

      expect(mockDelegate.findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: [{ name: 'asc' }] }));
    });
  });

  describe('findByIdOrThrow', () => {
    it('auto-scopes via parent device', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullIface);
      const found = await InterfaceRecord.findByIdOrThrow('if-1');
      expect(found.data.id).toBe('if-1');
      expect(mockDelegate.findFirst).toHaveBeenCalledWith({
        where: { id: 'if-1', device: { supplierId: supplierOrgId } },
      });
    });

    it('throws NotFoundException for a foreign-supplier interface', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      await expect(InterfaceRecord.findByIdOrThrow('missing')).rejects.toThrow(NotFoundException);
    });

    it('cross-tenant isolation: an interface on a foreign-supplier device is invisible to the caller', async () => {
      mockDelegate.findFirst.mockImplementation((args: { where: { device?: { supplierId?: string } } }) =>
        Promise.resolve(args.where.device?.supplierId === 'other-supplier' ? fullIface : null),
      );

      await expect(InterfaceRecord.findByIdOrThrow('if-1')).rejects.toThrow(NotFoundException);
      expect(mockDelegate.findFirst).toHaveBeenCalledWith({
        where: { id: 'if-1', device: { supplierId: supplierOrgId } },
      });
    });
  });

  describe('createForDevice', () => {
    it('creates when the parent device is owned, name is unique, and MTU valid', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findFirst.mockResolvedValue(null);
      mockDelegate.create.mockResolvedValue(fullIface);

      await InterfaceRecord.createForDevice(deviceId, {
        name: 'eth0',
        type: InterfaceType.ETHERNET_25G,
        mtu: 1500,
      });

      expect(mockDevice.findUnique).toHaveBeenCalledWith({
        where: { id: deviceId, supplierId: supplierOrgId },
        select: { id: true },
      });
      expect(mockDelegate.create).toHaveBeenCalled();
    });

    it('rejects create when device is not owned by the caller', async () => {
      mockDevice.findUnique.mockResolvedValue(null);

      await expect(InterfaceRecord.createForDevice(deviceId, { name: 'eth0' })).rejects.toThrow(NotFoundException);
      expect(mockDelegate.create).not.toHaveBeenCalled();
    });

    it('rejects duplicate name on the same device', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findFirst.mockResolvedValue({ id: 'existing' });

      await expect(InterfaceRecord.createForDevice(deviceId, { name: 'eth0' })).rejects.toThrow(ConflictException);
    });

    it('rejects a second interface carrying a mac the device already has', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findFirst.mockImplementation(async (args: { where: { macAddress?: unknown } }) =>
        args.where.macAddress ? { ...fullIface, id: 'if-2', name: 'eth1', macAddress: 'aa:bb:cc:dd:ee:ff' } : null,
      );

      await expect(
        InterfaceRecord.createForDevice(deviceId, { name: 'eth0', macAddress: 'AA-BB-CC-DD-EE-FF' }),
      ).rejects.toThrow(new ConflictException('another interface on this device already carries aa:bb:cc:dd:ee:ff'));

      expect(mockDelegate.findFirst).toHaveBeenCalledWith({
        where: { deviceId, deletedAt: null, macAddress: { equals: 'aa:bb:cc:dd:ee:ff', mode: 'insensitive' } },
      });
      expect(mockDelegate.create).not.toHaveBeenCalled();
    });

    it('creates when the mac is carried by no other live interface on the device', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findFirst.mockResolvedValue(null);
      mockDelegate.create.mockResolvedValue({ ...fullIface, macAddress: 'aa:bb:cc:dd:ee:ff' });

      await InterfaceRecord.createForDevice(deviceId, { name: 'eth0', macAddress: 'aa:bb:cc:dd:ee:ff' });

      expect(mockDelegate.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ macAddress: 'aa:bb:cc:dd:ee:ff' }) }),
      );
    });

    it('rejects MTU below 68', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findFirst.mockResolvedValue(null);

      await expect(InterfaceRecord.createForDevice(deviceId, { name: 'eth0', mtu: 67 })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects MTU above 65536', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findFirst.mockResolvedValue(null);

      await expect(InterfaceRecord.createForDevice(deviceId, { name: 'eth0', mtu: 65537 })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects parent when type is not VIRTUAL or BOND', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findFirst.mockResolvedValue(null);

      await expect(
        InterfaceRecord.createForDevice(deviceId, {
          name: 'eth0.100',
          type: InterfaceType.ETHERNET_1G,
          parentId: 'parent-1',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('allows parent on VIRTUAL interfaces (referenced parent on same device)', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      const parentIface = { ...fullIface, id: 'bond0', type: InterfaceType.BOND, name: 'bond0' };
      mockDelegate.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(parentIface);
      mockDelegate.create.mockResolvedValue(fullIface);

      await InterfaceRecord.createForDevice(deviceId, {
        name: 'bond0.100',
        type: InterfaceType.VIRTUAL,
        parentId: 'bond0',
      });

      expect(mockDelegate.create).toHaveBeenCalled();
    });

    it('rejects lagId when type is VIRTUAL', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findFirst.mockResolvedValue(null);

      await expect(
        InterfaceRecord.createForDevice(deviceId, {
          name: 'v0',
          type: InterfaceType.VIRTUAL,
          lagId: 'bond-1',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects lagId when type is BOND (bond cannot have a parent LAG)', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findFirst.mockResolvedValue(null);

      await expect(
        InterfaceRecord.createForDevice(deviceId, {
          name: 'bond1',
          type: InterfaceType.BOND,
          lagId: 'bond-parent',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects when LAG reference is invisible to the caller (foreign-supplier or missing)', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

      await expect(
        InterfaceRecord.createForDevice(deviceId, {
          name: 'eth0',
          type: InterfaceType.ETHERNET_25G,
          lagId: 'foreign-iface',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('asserts the LAG lookup carries the parent supplier filter', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

      await expect(
        InterfaceRecord.createForDevice(deviceId, {
          name: 'eth0',
          type: InterfaceType.ETHERNET_25G,
          lagId: 'foreign-iface',
        }),
      ).rejects.toThrow(BadRequestException);

      expect(mockDelegate.findFirst).toHaveBeenNthCalledWith(2, {
        where: { id: 'foreign-iface', device: { supplierId: supplierOrgId } },
      });
    });

    it('rejects when LAG reference is on a different device', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      const crossDeviceIface = { ...fullIface, id: 'other-iface', deviceId: 'other-device' };
      mockDelegate.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(crossDeviceIface);

      await expect(
        InterfaceRecord.createForDevice(deviceId, {
          name: 'eth0',
          type: InterfaceType.ETHERNET_25G,
          lagId: 'other-iface',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('updateById', () => {
    it('updates name + MTU and lands the relation filter in the update WHERE', async () => {
      mockDelegate.findFirst.mockResolvedValueOnce(fullIface).mockResolvedValueOnce(null);
      mockDelegate.update.mockResolvedValue({ ...fullIface, name: 'eth1', mtu: 9000 });

      const result = await InterfaceRecord.updateById('if-1', { name: 'eth1', mtu: 9000 });

      expect(mockDelegate.findFirst).toHaveBeenNthCalledWith(1, {
        where: { id: 'if-1', device: { supplierId: supplierOrgId } },
      });
      expect(mockDelegate.update).toHaveBeenCalledWith({
        where: { id: 'if-1', device: { supplierId: supplierOrgId } },
        data: { name: 'eth1', mtu: 9000 },
      });
      expect(result.data.mtu).toBe(9000);
    });

    it('rejects a mac change onto a mac another interface on the device carries', async () => {
      mockDelegate.findFirst
        .mockResolvedValueOnce(fullIface)
        .mockResolvedValueOnce({ ...fullIface, id: 'if-2', name: 'eth1', macAddress: 'aa:bb:cc:dd:ee:ff' });

      await expect(InterfaceRecord.updateById('if-1', { macAddress: 'aa:bb:cc:dd:ee:ff' })).rejects.toThrow(
        new ConflictException('another interface on this device already carries aa:bb:cc:dd:ee:ff'),
      );

      expect(mockDelegate.update).not.toHaveBeenCalled();
    });

    it('excludes the interface itself from the mac uniqueness check', async () => {
      mockDelegate.findFirst.mockResolvedValueOnce(fullIface).mockResolvedValueOnce(null);
      mockDelegate.update.mockResolvedValue({ ...fullIface, macAddress: 'aa:bb:cc:dd:ee:ff' });

      await InterfaceRecord.updateById('if-1', { macAddress: 'aa:bb:cc:dd:ee:ff' });

      expect(mockDelegate.findFirst).toHaveBeenNthCalledWith(2, {
        where: {
          deviceId,
          deletedAt: null,
          macAddress: { equals: 'aa:bb:cc:dd:ee:ff', mode: 'insensitive' },
          id: { not: 'if-1' },
        },
      });
      expect(mockDelegate.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ macAddress: 'aa:bb:cc:dd:ee:ff' }) }),
      );
    });

    it('does not run the mac uniqueness check when the mac is cleared or untouched', async () => {
      mockDelegate.findFirst.mockResolvedValueOnce(fullIface);
      mockDelegate.update.mockResolvedValue({ ...fullIface, macAddress: null });

      await InterfaceRecord.updateById('if-1', { macAddress: '  ', mtu: 1500 });

      expect(mockDelegate.findFirst).toHaveBeenCalledTimes(1);
    });

    it('throws NotFoundException when the interface is not visible to the caller', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      await expect(InterfaceRecord.updateById('if-1', { name: 'eth1' })).rejects.toThrow(NotFoundException);
    });

    it('rejects self-reference as LAG on update', async () => {
      mockDelegate.findFirst.mockResolvedValueOnce(fullIface);
      await expect(InterfaceRecord.updateById('if-1', { lagId: 'if-1' })).rejects.toThrow(BadRequestException);
    });

    it('rejects self-reference as parent on update', async () => {
      mockDelegate.findFirst.mockResolvedValueOnce(fullIface);
      await expect(InterfaceRecord.updateById('if-1', { parentId: 'if-1' })).rejects.toThrow(BadRequestException);
    });

    it('rejects update when new MTU is out of range', async () => {
      mockDelegate.findFirst.mockResolvedValueOnce(fullIface);
      await expect(InterfaceRecord.updateById('if-1', { mtu: 67 })).rejects.toThrow(BadRequestException);
      expect(mockDelegate.update).not.toHaveBeenCalled();
    });

    it('rejects update when new lagId points to a different device', async () => {
      const crossDeviceIface = { ...fullIface, id: 'other-iface', deviceId: 'other-device' };
      mockDelegate.findFirst.mockResolvedValueOnce(fullIface).mockResolvedValueOnce(crossDeviceIface);

      await expect(InterfaceRecord.updateById('if-1', { lagId: 'other-iface' })).rejects.toThrow(BadRequestException);
      expect(mockDelegate.update).not.toHaveBeenCalled();
    });

    it('does NOT re-run the same-device check when lagId/parentId are unchanged', async () => {
      mockDelegate.findFirst.mockResolvedValueOnce(fullIface).mockResolvedValueOnce(null);
      mockDelegate.update.mockResolvedValue({ ...fullIface, name: 'eth1' });

      await InterfaceRecord.updateById('if-1', { name: 'eth1' });

      expect(mockDelegate.findFirst).toHaveBeenCalledTimes(2);
    });

    it('refreshes DB-bumped fields (e.g. updatedAt) on the record after save', async () => {
      const beforeUpdatedAt = new Date('2026-01-01T00:00:00Z');
      const afterUpdatedAt = new Date('2026-01-01T00:00:05Z');
      const before = { ...fullIface, updatedAt: beforeUpdatedAt };
      const after = { ...fullIface, name: 'eth1', updatedAt: afterUpdatedAt };

      mockDelegate.findFirst.mockResolvedValueOnce(before).mockResolvedValueOnce(null);
      mockDelegate.update.mockResolvedValue(after);

      const result = await InterfaceRecord.updateById('if-1', { name: 'eth1' });

      expect(result.data.updatedAt).toEqual(afterUpdatedAt);
      expect(result.data.name).toBe('eth1');
    });
  });

  describe('untaggedVlan FK validation (tenant, org-scoped)', () => {
    it('createForDevice accepts a reachable untagged VLAN (org + deletedAt scoped) and creates', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findFirst.mockResolvedValue(null);
      mockVlan.findUnique.mockResolvedValue({ id: 'vlan-1' });
      mockDelegate.create.mockResolvedValue(fullIface);

      await InterfaceRecord.createForDevice(deviceId, { name: 'eth0', untaggedVlanId: 'vlan-1' });

      expect(mockVlan.findUnique).toHaveBeenCalledWith({
        where: { id: 'vlan-1', organizationId: supplierOrgId, deletedAt: null },
        select: { id: true },
      });
      expect(mockDelegate.create).toHaveBeenCalled();
    });

    it('createForDevice rejects a missing/foreign untagged VLAN with 404 and does not create', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findFirst.mockResolvedValue(null);
      mockVlan.findUnique.mockResolvedValue(null);

      await expect(
        InterfaceRecord.createForDevice(deviceId, { name: 'eth0', untaggedVlanId: 'missing' }),
      ).rejects.toThrow(NotFoundException);
      expect(mockDelegate.create).not.toHaveBeenCalled();
    });

    it('createForDevice treats a soft-deleted VLAN as 404 (deletedAt:null filter excludes it)', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findFirst.mockResolvedValue(null);
      mockVlan.findUnique.mockResolvedValue(null);

      await expect(
        InterfaceRecord.createForDevice(deviceId, { name: 'eth0', untaggedVlanId: 'soft-deleted' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('createForDevice does not query the VLAN when untaggedVlanId is omitted', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findFirst.mockResolvedValue(null);
      mockDelegate.create.mockResolvedValue(fullIface);

      await InterfaceRecord.createForDevice(deviceId, { name: 'eth0' });
      expect(mockVlan.findUnique).not.toHaveBeenCalled();
    });

    it('updateById validates a changed untagged VLAN and rejects a bad id with 404 (no update)', async () => {
      mockDelegate.findFirst.mockResolvedValueOnce(fullIface);
      mockVlan.findUnique.mockResolvedValue(null);

      await expect(InterfaceRecord.updateById('if-1', { untaggedVlanId: 'missing' })).rejects.toThrow(
        NotFoundException,
      );
      expect(mockDelegate.update).not.toHaveBeenCalled();
    });

    it('updateById accepts a changed untagged VLAN that is reachable', async () => {
      mockDelegate.findFirst.mockResolvedValueOnce(fullIface);
      mockVlan.findUnique.mockResolvedValue({ id: 'vlan-9' });
      mockDelegate.update.mockResolvedValue({ ...fullIface, untaggedVlanId: 'vlan-9' });

      await InterfaceRecord.updateById('if-1', { untaggedVlanId: 'vlan-9' });

      expect(mockVlan.findUnique).toHaveBeenCalledWith({
        where: { id: 'vlan-9', organizationId: supplierOrgId, deletedAt: null },
        select: { id: true },
      });
      expect(mockDelegate.update).toHaveBeenCalled();
    });

    it('updateById does not query the VLAN for an unrelated (mtu-only) patch', async () => {
      mockDelegate.findFirst.mockResolvedValueOnce(fullIface);
      mockDelegate.update.mockResolvedValue({ ...fullIface, mtu: 9000 });

      await InterfaceRecord.updateById('if-1', { mtu: 9000 });
      expect(mockVlan.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('deleteById', () => {
    it('deletes when the interface is visible to the caller (relation filter lands in delete WHERE)', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullIface);
      const result = await InterfaceRecord.deleteById('if-1');
      expect(result).toEqual({ deviceId });
      expect(mockDelegate.delete).toHaveBeenCalledWith({
        where: { id: 'if-1', device: { supplierId: supplierOrgId } },
      });
    });

    it('retires assigned IPs before deleting the interface (atomically, IPs first)', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullIface);
      await InterfaceRecord.deleteById('if-1');
      expect(mockIpAddress.updateMany).toHaveBeenCalledWith({
        where: { interfaceId: 'if-1', deletedAt: null },
        data: { deletedAt: expect.any(Date) },
      });
      expect(mockIpAddress.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
        mockDelegate.delete.mock.invocationCallOrder[0],
      );
    });

    it('throws NotFoundException when the interface is not visible to the caller', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      await expect(InterfaceRecord.deleteById('missing')).rejects.toThrow(NotFoundException);
    });
  });

  describe('listForDeviceWithIps', () => {
    it('returns the device interfaces with their assigned IPs (by-device, non-deleted, name-ordered)', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      const rows = [{ ...fullIface, id: 'if-1', ipAddresses: [{ id: 'ip-1', address: '10.0.0.5', status: 'ACTIVE' }] }];
      mockDelegate.findMany.mockResolvedValue(rows);

      const result = await InterfaceRecord.listForDeviceWithIps(deviceId);

      expect(result).toEqual(rows);
      expect(mockDelegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { deviceId, deletedAt: null }, orderBy: { name: 'asc' } }),
      );
    });

    it('throws when the device is not owned or supplied by the caller', async () => {
      mockDevice.findUnique.mockResolvedValue(null);
      await expect(InterfaceRecord.listForDeviceWithIps(deviceId)).rejects.toThrow();
      expect(mockDelegate.findMany).not.toHaveBeenCalled();
    });
  });

  describe('bulkApplyForDevice', () => {
    it('rejects an id that appears in both deletes and updates with a 400', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findMany.mockResolvedValue([{ ...fullIface, id: 'if-1' }]);
      await expect(
        InterfaceRecord.bulkApplyForDevice(deviceId, {
          creates: [],
          updates: [{ id: 'if-1', data: { name: 'eth1' } }],
          deletes: ['if-1'],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a create whose lagId is also being deleted with a 400', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findMany.mockResolvedValue([{ ...fullIface, id: 'lag-1' }]);
      await expect(
        InterfaceRecord.bulkApplyForDevice(deviceId, {
          creates: [{ name: 'eth1', lagId: 'lag-1' }],
          updates: [],
          deletes: ['lag-1'],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a create whose lagId is not an interface on this device', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findMany.mockResolvedValue([{ ...fullIface, id: 'if-1' }]);
      await expect(
        InterfaceRecord.bulkApplyForDevice(deviceId, {
          creates: [{ name: 'eth1', lagId: 'not-on-device' }],
          updates: [],
          deletes: [],
        }),
      ).rejects.toThrow(/must belong to the same device/);
    });

    it('accepts an owner-scoped (bridge) create whose lagId is an on-device interface', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findMany.mockResolvedValue([{ ...fullIface, id: 'lag-1', type: InterfaceType.BOND }]);
      mockDelegate.create.mockResolvedValue({ id: 'new-1' });

      await InterfaceRecord.bulkApplyForDevice(deviceId, {
        creates: [{ name: 'eth1', lagId: 'lag-1' }],
        updates: [],
        deletes: [],
      });

      expect(mockDelegate.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ name: 'eth1', lagId: 'lag-1', markConnected: expect.any(Boolean) }),
        }),
      );
    });

    it('retires the assigned IPs before hard-deleting on the delete path', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findMany.mockResolvedValue([{ ...fullIface, id: 'if-gone' }]);

      await InterfaceRecord.bulkApplyForDevice(deviceId, { creates: [], updates: [], deletes: ['if-gone'] });

      expect(mockIpAddress.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { interfaceId: { in: ['if-gone'] }, deletedAt: null },
          data: expect.objectContaining({ deletedAt: expect.any(Date) }),
        }),
      );
      expect(mockDelegate.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['if-gone'] }, deviceId } });
      expect(mockIpAddress.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
        mockDelegate.deleteMany.mock.invocationCallOrder[0],
      );
    });

    it('stages renames to a temp name so a name swap applies without a unique-name collision', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findMany.mockResolvedValue([
        { ...fullIface, id: 'if-a', name: 'eth0' },
        { ...fullIface, id: 'if-b', name: 'eth1' },
      ]);

      await InterfaceRecord.bulkApplyForDevice(deviceId, {
        creates: [],
        updates: [
          { id: 'if-a', data: { name: 'eth1' } },
          { id: 'if-b', data: { name: 'eth0' } },
        ],
        deletes: [],
      });

      expect(mockDelegate.update).toHaveBeenCalledWith({ where: { id: 'if-a' }, data: { name: '__tmp__if-a' } });
      expect(mockDelegate.update).toHaveBeenCalledWith({ where: { id: 'if-b' }, data: { name: '__tmp__if-b' } });
      expect(mockDelegate.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'if-a' }, data: expect.objectContaining({ name: 'eth1' }) }),
      );
      expect(mockDelegate.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'if-b' }, data: expect.objectContaining({ name: 'eth0' }) }),
      );

      const calls = mockDelegate.update.mock.calls;
      const orders = mockDelegate.update.mock.invocationCallOrder;
      const tempRenameOrder = orders[calls.findIndex((c) => c[0].data.name === '__tmp__if-a')]!;
      const finalRenameOrder = orders[calls.findIndex((c) => c[0].where?.id === 'if-a' && c[0].data.name === 'eth1')]!;
      expect(tempRenameOrder).toBeLessThan(finalRenameOrder);
    });

    it('rejects a delete that would cascade SET NULL onto a non-batch interface lagId', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findMany.mockResolvedValue([
        { ...fullIface, id: 'lag-1', name: 'bond0', lagId: null, parentId: null },
        { ...fullIface, id: 'eth-1', name: 'eth0', lagId: 'lag-1', parentId: null },
      ]);

      await expect(
        InterfaceRecord.bulkApplyForDevice(deviceId, {
          creates: [],
          updates: [],
          deletes: ['lag-1'],
        }),
      ).rejects.toThrow(BadRequestException);

      expect(mockDelegate.deleteMany).not.toHaveBeenCalled();
    });

    it('allows a delete when the member is also updated to clear its lagId', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findMany.mockResolvedValue([
        { ...fullIface, id: 'lag-1', name: 'bond0', lagId: null, parentId: null },
        { ...fullIface, id: 'eth-1', name: 'eth0', lagId: 'lag-1', parentId: null },
      ]);
      mockDelegate.update.mockResolvedValue({ id: 'eth-1' });

      await expect(
        InterfaceRecord.bulkApplyForDevice(deviceId, {
          creates: [],
          updates: [{ id: 'eth-1', data: { lagId: null } }],
          deletes: ['lag-1'],
        }),
      ).resolves.toBeUndefined();
    });

    it('stores a create MAC trimmed, matching the value assertValidMacAddress validated', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findMany.mockResolvedValue([]);
      mockDelegate.create.mockResolvedValue({ id: 'new-1' });

      await InterfaceRecord.bulkApplyForDevice(deviceId, {
        creates: [{ name: 'eth9', macAddress: '  aa:bb:cc:dd:ee:ff  ' }],
        updates: [],
        deletes: [],
      });

      expect(mockDelegate.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ macAddress: 'aa:bb:cc:dd:ee:ff', markConnected: expect.any(Boolean) }),
        }),
      );
    });

    it('omits a blank create MAC rather than persisting an empty string', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findMany.mockResolvedValue([]);
      mockDelegate.create.mockResolvedValue({ id: 'new-1' });

      await InterfaceRecord.bulkApplyForDevice(deviceId, {
        creates: [{ name: 'eth9', macAddress: '   ' }],
        updates: [],
        deletes: [],
      });

      const created = mockDelegate.create.mock.calls[0]?.[0]?.data;
      expect(created.macAddress).toBeUndefined();
    });

    it('clears the MAC (null) on a blank update rather than persisting an empty string', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findMany.mockResolvedValue([{ id: 'if-1', name: 'eth9', macAddress: 'aa:bb:cc:dd:ee:ff' }]);
      mockDelegate.update.mockResolvedValue({ id: 'if-1' });

      await InterfaceRecord.bulkApplyForDevice(deviceId, {
        creates: [],
        updates: [{ id: 'if-1', data: { macAddress: '   ' } }],
        deletes: [],
      });

      expect(mockDelegate.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'if-1' }, data: expect.objectContaining({ macAddress: null }) }),
      );
    });

    it('rejects a create carrying a mac a surviving interface on the device already has', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findMany.mockResolvedValue([
        { ...fullIface, id: 'if-a', name: 'eth0', macAddress: 'aa:bb:cc:dd:ee:ff' },
      ]);

      await expect(
        InterfaceRecord.bulkApplyForDevice(deviceId, {
          creates: [{ name: 'eth9', macAddress: 'AA:BB:CC:DD:EE:FF' }],
          updates: [],
          deletes: [],
        }),
      ).rejects.toThrow(new ConflictException('another interface on this device already carries aa:bb:cc:dd:ee:ff'));

      expect(mockDelegate.create).not.toHaveBeenCalled();
    });

    it('rejects two creates in one batch that carry the same mac', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findMany.mockResolvedValue([]);

      await expect(
        InterfaceRecord.bulkApplyForDevice(deviceId, {
          creates: [
            { name: 'eth8', macAddress: 'aa:bb:cc:dd:ee:ff' },
            { name: 'eth9', macAddress: 'aa-bb-cc-dd-ee-ff' },
          ],
          updates: [],
          deletes: [],
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('lets a create take the mac of an interface deleted in the same batch', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findMany.mockResolvedValue([
        { ...fullIface, id: 'if-a', name: 'eth0', macAddress: 'aa:bb:cc:dd:ee:ff' },
      ]);
      mockDelegate.create.mockResolvedValue({ id: 'new-1' });

      await InterfaceRecord.bulkApplyForDevice(deviceId, {
        creates: [{ name: 'eth9', macAddress: 'aa:bb:cc:dd:ee:ff' }],
        updates: [],
        deletes: ['if-a'],
      });

      expect(mockDelegate.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ macAddress: 'aa:bb:cc:dd:ee:ff' }) }),
      );
    });

    it('clears changed macs first so a mac swap applies without a unique-mac collision', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findMany.mockResolvedValue([
        { ...fullIface, id: 'if-a', name: 'eth0', macAddress: 'aa:aa:aa:aa:aa:aa' },
        { ...fullIface, id: 'if-b', name: 'eth1', macAddress: 'bb:bb:bb:bb:bb:bb' },
      ]);

      await InterfaceRecord.bulkApplyForDevice(deviceId, {
        creates: [],
        updates: [
          { id: 'if-a', data: { macAddress: 'bb:bb:bb:bb:bb:bb' } },
          { id: 'if-b', data: { macAddress: 'aa:aa:aa:aa:aa:aa' } },
        ],
        deletes: [],
      });

      expect(mockDelegate.update).toHaveBeenCalledWith({ where: { id: 'if-a' }, data: { macAddress: null } });
      expect(mockDelegate.update).toHaveBeenCalledWith({ where: { id: 'if-b' }, data: { macAddress: null } });

      const calls = mockDelegate.update.mock.calls;
      const orders = mockDelegate.update.mock.invocationCallOrder;
      const clearOrder = orders[calls.findIndex((c) => c[0].where.id === 'if-a' && c[0].data.macAddress === null)]!;
      const finalOrder =
        orders[calls.findIndex((c) => c[0].where.id === 'if-a' && c[0].data.macAddress === 'bb:bb:bb:bb:bb:bb')]!;
      expect(clearOrder).toBeLessThan(finalOrder);

      expect(mockDelegate.update).toHaveBeenCalledWith({
        where: { id: 'if-a' },
        data: { macAddress: 'bb:bb:bb:bb:bb:bb' },
      });
      expect(mockDelegate.update).toHaveBeenCalledWith({
        where: { id: 'if-b' },
        data: { macAddress: 'aa:aa:aa:aa:aa:aa' },
      });
    });

    it('stages a mac that another update in the batch adopts, so the transfer is order-independent', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findMany.mockResolvedValue([
        { ...fullIface, id: 'if-a', name: 'eth0', macAddress: 'aa:aa:aa:aa:aa:aa' },
        { ...fullIface, id: 'if-b', name: 'eth1', macAddress: null },
      ]);

      await InterfaceRecord.bulkApplyForDevice(deviceId, {
        creates: [],
        updates: [
          { id: 'if-b', data: { macAddress: 'aa:aa:aa:aa:aa:aa' } },
          { id: 'if-a', data: { macAddress: null } },
        ],
        deletes: [],
      });

      expect(mockDelegate.update).toHaveBeenCalledWith({ where: { id: 'if-a' }, data: { macAddress: null } });

      const calls = mockDelegate.update.mock.calls;
      const orders = mockDelegate.update.mock.invocationCallOrder;
      const clearOrder = orders[calls.findIndex((c) => c[0].where.id === 'if-a' && c[0].data.macAddress === null)]!;
      const adoptOrder =
        orders[calls.findIndex((c) => c[0].where.id === 'if-b' && c[0].data.macAddress === 'aa:aa:aa:aa:aa:aa')]!;
      expect(clearOrder).toBeLessThan(adoptOrder);
    });
  });

  it('createForDevice fails closed when no request context is bound', async () => {
    ActiveRecordRegistry.configureForTest({ interface: mockDelegate, device: mockDevice }, null);
    await expect(InterfaceRecord.createForDevice(deviceId, { name: 'eth0' })).rejects.toThrow(
      /Permission context required/,
    );
  });
});

describe('assertValidInterfaceName', () => {
  it('accepts real NIC names', () => {
    for (const name of ['eth0', 'eno1', 'enp1s0f0', 'bond0.100', 'wt0', 'br-mgmt']) {
      expect(() => assertValidInterfaceName(name)).not.toThrow();
    }
  });

  it('rejects names with shell metacharacters (iptables injection guard)', () => {
    for (const name of ['eth0; curl x | bash #', 'eth0 && rm -rf /', '$(reboot)', 'a`id`', 'a b', '']) {
      expect(() => assertValidInterfaceName(name)).toThrow(BadRequestException);
    }
  });

  it('accepts the maximum-length name (15 chars, IFNAMSIZ-1)', () => {
    expect(() => assertValidInterfaceName('e'.repeat(15))).not.toThrow();
  });

  it('rejects a name exceeding IFNAMSIZ-1 (16 chars)', () => {
    expect(() => assertValidInterfaceName('e'.repeat(16))).toThrow(BadRequestException);
  });
});

describe('assertValidMacAddress', () => {
  it('accepts colon- and hyphen-separated six-octet MACs (any case)', () => {
    for (const mac of ['00:1a:2b:3c:4d:5e', '00-1A-2B-3C-4D-5E', 'AA:BB:CC:DD:EE:FF']) {
      expect(() => assertValidMacAddress(mac)).not.toThrow();
    }
  });

  it('treats null, undefined, and blank as "no MAC"', () => {
    expect(() => assertValidMacAddress(null)).not.toThrow();
    expect(() => assertValidMacAddress(undefined)).not.toThrow();
    expect(() => assertValidMacAddress('   ')).not.toThrow();
  });

  it('rejects malformed MACs', () => {
    for (const mac of ['not-a-mac', '00:1a:2b:3c:4d', '00:1a:2b:3c:4d:5e:6f', 'zz:zz:zz:zz:zz:zz', '001a.2b3c.4d5e']) {
      expect(() => assertValidMacAddress(mac)).toThrow(BadRequestException);
    }
  });
});
