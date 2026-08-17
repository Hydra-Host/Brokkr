import { NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry } from '@repo/active-record';
import { DeviceRole, DeviceStatus, SwitchPowerStatus } from '@repo/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SwitchRecord } from '../switch.record';

describe('SwitchRecord', () => {
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
  const deviceId = 'dev-switch-1';
  const devicePerms = new Set(['device:read', 'device:create', 'device:update', 'device:delete']);

  const fullSwitch = {
    id: deviceId,
    name: 'PHX1-SW-1',
    nickname: null,
    systemSerial: null,
    chassisSerial: null,
    serial: null,
    baseboardSerial: null,
    systemUuid: null,
    productSku: null,
    assetTag: null,
    role: DeviceRole.Switch,
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
    switch: {
      id: 'switch-1',
      switchRole: 'leaf',
      fabric: 'east-west',
      portCount: 48,
      powerStatus: SwitchPowerStatus.On,
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
    it('pins the query to role=Switch + the caller supplierId', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullSwitch);
      const record = await SwitchRecord.findByDeviceIdOrThrow(deviceId);

      expect(record.data.id).toBe(deviceId);
      const call = mockDelegate.findFirst.mock.calls[0][0];
      expect(call.where).toMatchObject({ id: deviceId, supplierId: orgId, role: DeviceRole.Switch });
    });

    it('throws NotFoundException when nothing matches the scope', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      await expect(SwitchRecord.findByDeviceIdOrThrow('missing')).rejects.toThrow(NotFoundException);
    });

    it('cross-tenant isolation: a foreign-supplier switch is invisible', async () => {
      mockDelegate.findFirst.mockImplementation((args: { where: { supplierId?: unknown } }) =>
        Promise.resolve(
          args.where.supplierId === 'other-tenant' ? { ...fullSwitch, supplierId: 'other-tenant' } : null,
        ),
      );
      await expect(SwitchRecord.findByDeviceIdOrThrow(deviceId)).rejects.toThrow(NotFoundException);
    });

    it('rejects when the caller lacks device:read', async () => {
      configure(new Set());
      await expect(SwitchRecord.findByDeviceIdOrThrow(deviceId)).rejects.toThrow();
      expect(mockDelegate.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('decommissionByDeviceId', () => {
    it('soft-deletes (deletedAt + MAINTENANCE) scoped to role=Switch + supplier', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullSwitch);
      mockDelegate.update.mockResolvedValue({ ...fullSwitch, deletedAt: new Date(), status: DeviceStatus.MAINTENANCE });

      await SwitchRecord.decommissionByDeviceId(deviceId);

      const call = mockDelegate.update.mock.calls[0][0];
      expect(call.data.status).toBe(DeviceStatus.MAINTENANCE);
      expect(call.data.deletedAt).toBeInstanceOf(Date);
      expect(call.where).toMatchObject({ id: deviceId, supplierId: orgId, role: DeviceRole.Switch });
    });

    it('rejects when the caller lacks device:delete', async () => {
      configure(new Set(['device:read']));
      await expect(SwitchRecord.decommissionByDeviceId(deviceId)).rejects.toThrow();
      expect(mockDelegate.update).not.toHaveBeenCalled();
    });
  });

  describe('listPaginated', () => {
    it('restricts the live listing to ACTIVE-status devices', async () => {
      mockDelegate.findMany.mockResolvedValue([]);
      mockDelegate.count.mockResolvedValue(0);

      await SwitchRecord.listPaginated({ page: 1 });

      const call = mockDelegate.findMany.mock.calls[0][0];
      expect(call.where).toMatchObject({ role: DeviceRole.Switch, status: DeviceStatus.ACTIVE, deletedAt: null });
    });

    it('decommissioned listing shows tombstoned rows regardless of status', async () => {
      mockDelegate.findMany.mockResolvedValue([]);
      mockDelegate.count.mockResolvedValue(0);

      await SwitchRecord.listPaginated({ page: 1, decommissioned: true });

      const call = mockDelegate.findMany.mock.calls[0][0];
      expect(call.where).toMatchObject({ role: DeviceRole.Switch, deletedAt: { not: null } });
      expect(call.where).not.toHaveProperty('status');
    });
  });

  describe('updateByDeviceId', () => {
    it('sanitizes nickname and writes Switch fields through the extension', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullSwitch);
      mockDelegate.update.mockResolvedValue({
        ...fullSwitch,
        nickname: 'scriptxscript',
        switch: { ...fullSwitch.switch, portCount: 32, fabric: 'north-south' },
      });

      await SwitchRecord.updateByDeviceId(deviceId, {
        nickname: '<script>x</script>',
        portCount: 32,
        fabric: 'north-south',
      });

      const call = mockDelegate.update.mock.calls[0][0];
      expect(call.data.nickname).not.toMatch(/[<>]/);
      expect(call.data.switch).toEqual({ update: { portCount: 32, fabric: 'north-south' } });
    });

    it('stores null when sanitization strips the nickname to empty', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullSwitch);
      mockDelegate.update.mockResolvedValue(fullSwitch);

      await SwitchRecord.updateByDeviceId(deviceId, { nickname: '<>' });

      const call = mockDelegate.update.mock.calls[0][0];
      expect(call.data.nickname).toBeNull();
    });

    it('rejects when the caller lacks device:update', async () => {
      configure(new Set(['device:read']));
      await expect(SwitchRecord.updateByDeviceId(deviceId, { portCount: 1 })).rejects.toThrow();
      expect(mockDelegate.update).not.toHaveBeenCalled();
    });
  });
});
