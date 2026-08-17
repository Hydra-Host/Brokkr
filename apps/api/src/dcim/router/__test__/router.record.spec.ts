import { NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry } from '@repo/active-record';
import { DeviceRole, DeviceStatus, RouterPowerStatus } from '@repo/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RouterRecord } from '../router.record';

describe('RouterRecord', () => {
  const mockDelegate = {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(),
  };

  const orgId = 'org-1';
  const deviceId = 'dev-router-1';
  const devicePerms = new Set(['device:read', 'device:create', 'device:update', 'device:delete']);

  const fullRouter = {
    id: deviceId,
    name: 'PHX1-RTR-1',
    nickname: null,
    systemSerial: null,
    chassisSerial: null,
    serial: null,
    baseboardSerial: null,
    systemUuid: null,
    productSku: null,
    assetTag: null,
    role: DeviceRole.Router,
    status: DeviceStatus.ACTIVE,
    deviceType: null,
    networkType: null,
    architecture: null,
    uefiBoot: null,
    secureBootEnabled: null,
    iommuEnabled: null,
    sriovEnabled: null,
    zoneId: 'zone-1',
    organizationId: null,
    supplierId: orgId,
    deviceModelId: null,
    deletedAt: null as Date | null,
    createdAt: new Date(),
    updatedAt: new Date(),
    router: {
      id: 'router-1',
      routerType: 'edge',
      bgpAsn: 64512,
      powerStatus: RouterPowerStatus.On,
    },
    supplier: { id: orgId, name: 'Acme Supply' },
    zone: { name: 'PHX1', region: null },
  };

  const configure = (permissions: Set<string>) =>
    ActiveRecordRegistry.configureForTest({ device: mockDelegate }, () => ({ organizationId: orgId, permissions }));

  beforeEach(() => {
    vi.resetAllMocks();
    configure(devicePerms);
  });

  afterEach(() => vi.resetAllMocks());

  describe('findByDeviceIdOrThrow', () => {
    it('pins the query to role=Router + the caller supplierId', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullRouter);
      const record = await RouterRecord.findByDeviceIdOrThrow(deviceId);

      expect(record.data.id).toBe(deviceId);
      const call = mockDelegate.findFirst.mock.calls[0][0];
      expect(call.where).toMatchObject({ id: deviceId, supplierId: orgId, role: DeviceRole.Router });
    });

    it('throws NotFoundException when nothing matches the scope', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      await expect(RouterRecord.findByDeviceIdOrThrow('missing')).rejects.toThrow(NotFoundException);
    });

    it('cross-tenant isolation: a foreign-supplier router is invisible', async () => {
      mockDelegate.findFirst.mockImplementation((args: { where: { supplierId?: unknown } }) =>
        Promise.resolve(
          args.where.supplierId === 'other-tenant' ? { ...fullRouter, supplierId: 'other-tenant' } : null,
        ),
      );
      await expect(RouterRecord.findByDeviceIdOrThrow(deviceId)).rejects.toThrow(NotFoundException);
    });

    it('rejects when the caller lacks device:read', async () => {
      configure(new Set());
      await expect(RouterRecord.findByDeviceIdOrThrow(deviceId)).rejects.toThrow();
      expect(mockDelegate.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('decommissionByDeviceId', () => {
    it('soft-deletes (deletedAt + MAINTENANCE) scoped to role=Router + supplier', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullRouter);
      mockDelegate.update.mockResolvedValue({ ...fullRouter, deletedAt: new Date(), status: DeviceStatus.MAINTENANCE });

      await RouterRecord.decommissionByDeviceId(deviceId);

      const call = mockDelegate.update.mock.calls[0][0];
      expect(call.data.status).toBe(DeviceStatus.MAINTENANCE);
      expect(call.data.deletedAt).toBeInstanceOf(Date);
      expect(call.where).toMatchObject({ id: deviceId, supplierId: orgId, role: DeviceRole.Router });
    });

    it('rejects when the caller lacks device:delete', async () => {
      configure(new Set(['device:read']));
      await expect(RouterRecord.decommissionByDeviceId(deviceId)).rejects.toThrow();
      expect(mockDelegate.update).not.toHaveBeenCalled();
    });
  });

  describe('listPaginated', () => {
    it('restricts the live listing to ACTIVE-status devices', async () => {
      mockDelegate.findMany.mockResolvedValue([]);
      mockDelegate.count.mockResolvedValue(0);

      await RouterRecord.listPaginated({ page: 1 });

      const call = mockDelegate.findMany.mock.calls[0][0];
      expect(call.where).toMatchObject({ role: DeviceRole.Router, status: DeviceStatus.ACTIVE, deletedAt: null });
    });

    it('decommissioned listing shows tombstoned rows regardless of status', async () => {
      mockDelegate.findMany.mockResolvedValue([]);
      mockDelegate.count.mockResolvedValue(0);

      await RouterRecord.listPaginated({ page: 1, decommissioned: true });

      const call = mockDelegate.findMany.mock.calls[0][0];
      expect(call.where).toMatchObject({ role: DeviceRole.Router, deletedAt: { not: null } });
      expect(call.where).not.toHaveProperty('status');
    });
  });

  describe('updateByDeviceId', () => {
    it('sanitizes nickname and writes Router fields through the extension', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullRouter);
      mockDelegate.update.mockResolvedValue({
        ...fullRouter,
        nickname: 'scriptxscript',
        router: { ...fullRouter.router, bgpAsn: 65001, routerType: 'core' },
      });

      await RouterRecord.updateByDeviceId(deviceId, {
        nickname: '<script>x</script>',
        bgpAsn: 65001,
        routerType: 'core',
      });

      const call = mockDelegate.update.mock.calls[0][0];
      expect(call.data.nickname).not.toMatch(/[<>]/);
      expect(call.data.router).toEqual({ update: { bgpAsn: 65001, routerType: 'core' } });
    });

    it('stores null when sanitization strips the nickname to empty', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullRouter);
      mockDelegate.update.mockResolvedValue(fullRouter);

      await RouterRecord.updateByDeviceId(deviceId, { nickname: '<>' });

      const call = mockDelegate.update.mock.calls[0][0];
      expect(call.data.nickname).toBeNull();
    });

    it('rejects when the caller lacks device:update', async () => {
      configure(new Set(['device:read']));
      await expect(RouterRecord.updateByDeviceId(deviceId, { bgpAsn: 1 })).rejects.toThrow();
      expect(mockDelegate.update).not.toHaveBeenCalled();
    });
  });
});
