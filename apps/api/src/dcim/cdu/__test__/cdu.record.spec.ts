import { NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry } from '@repo/active-record';
import { Airflow, CduPowerStatus, DeviceRole, DeviceStatus } from '@repo/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CduRecord } from '../cdu.record';

describe('CduRecord', () => {
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
  const deviceId = 'dev-cdu-1';
  const devicePerms = new Set(['device:read', 'device:create', 'device:update', 'device:delete']);

  const fullCdu = {
    id: deviceId,
    name: 'PHX1-CDU-1',
    nickname: null,
    systemSerial: null,
    chassisSerial: null,
    serial: null,
    baseboardSerial: null,
    systemUuid: null,
    productSku: null,
    assetTag: null,
    role: DeviceRole.CDU,
    status: DeviceStatus.ACTIVE,
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
    cdu: {
      id: 'cdu-1',
      coolantType: 'water',
      ratedFlowRateLpm: 120.5,
      ratedThermalCapacityKw: 300,
      airflow: Airflow.FrontToRear,
      powerStatus: CduPowerStatus.On,
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
    it('pins the query to role=CDU + the caller supplierId', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullCdu);
      const record = await CduRecord.findByDeviceIdOrThrow(deviceId);

      expect(record.data.id).toBe(deviceId);
      const call = mockDelegate.findFirst.mock.calls[0][0];
      expect(call.where).toMatchObject({ id: deviceId, supplierId: orgId, role: DeviceRole.CDU });
    });

    it('throws NotFoundException when nothing matches the scope', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      await expect(CduRecord.findByDeviceIdOrThrow('missing')).rejects.toThrow(NotFoundException);
    });

    it('cross-tenant isolation: a foreign-supplier CDU is invisible', async () => {
      mockDelegate.findFirst.mockImplementation((args: { where: { supplierId?: unknown } }) =>
        Promise.resolve(args.where.supplierId === 'other-tenant' ? { ...fullCdu, supplierId: 'other-tenant' } : null),
      );
      await expect(CduRecord.findByDeviceIdOrThrow(deviceId)).rejects.toThrow(NotFoundException);
    });

    it('rejects when the caller lacks device:read', async () => {
      configure(new Set());
      await expect(CduRecord.findByDeviceIdOrThrow(deviceId)).rejects.toThrow();
      expect(mockDelegate.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('decommissionByDeviceId', () => {
    it('soft-deletes (deletedAt + MAINTENANCE) scoped to role=CDU + supplier', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullCdu);
      mockDelegate.update.mockResolvedValue({ ...fullCdu, deletedAt: new Date(), status: DeviceStatus.MAINTENANCE });

      await CduRecord.decommissionByDeviceId(deviceId);

      const call = mockDelegate.update.mock.calls[0][0];
      expect(call.data.status).toBe(DeviceStatus.MAINTENANCE);
      expect(call.data.deletedAt).toBeInstanceOf(Date);
      expect(call.where).toMatchObject({ id: deviceId, supplierId: orgId, role: DeviceRole.CDU });
    });

    it('rejects when the caller lacks device:delete', async () => {
      configure(new Set(['device:read']));
      await expect(CduRecord.decommissionByDeviceId(deviceId)).rejects.toThrow();
      expect(mockDelegate.update).not.toHaveBeenCalled();
    });
  });

  describe('listPaginated', () => {
    it('restricts the live listing to ACTIVE-status devices', async () => {
      mockDelegate.findMany.mockResolvedValue([]);
      mockDelegate.count.mockResolvedValue(0);

      await CduRecord.listPaginated({ page: 1 });

      const call = mockDelegate.findMany.mock.calls[0][0];
      expect(call.where).toMatchObject({ status: DeviceStatus.ACTIVE, deletedAt: null });
    });

    it('decommissioned listing shows tombstoned rows regardless of status', async () => {
      mockDelegate.findMany.mockResolvedValue([]);
      mockDelegate.count.mockResolvedValue(0);

      await CduRecord.listPaginated({ page: 1, decommissioned: true });

      const call = mockDelegate.findMany.mock.calls[0][0];
      expect(call.where).toMatchObject({ deletedAt: { not: null } });
      expect(call.where).not.toHaveProperty('status');
    });
  });

  describe('updateByDeviceId', () => {
    it('sanitizes nickname and writes CDU fields through the extension', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullCdu);
      mockDelegate.update.mockResolvedValue({
        ...fullCdu,
        nickname: 'scriptxscript',
        cdu: { ...fullCdu.cdu, ratedThermalCapacityKw: 500, airflow: Airflow.RearToFront },
      });

      await CduRecord.updateByDeviceId(deviceId, {
        nickname: '<script>x</script>',
        ratedThermalCapacityKw: 500,
        airflow: 'RearToFront',
      });

      const call = mockDelegate.update.mock.calls[0][0];
      expect(call.data.nickname).not.toMatch(/[<>]/);
      expect(call.data.cdu).toEqual({ update: { ratedThermalCapacityKw: 500, airflow: 'RearToFront' } });
    });

    it('stores null when sanitization strips the nickname to empty', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullCdu);
      mockDelegate.update.mockResolvedValue(fullCdu);

      await CduRecord.updateByDeviceId(deviceId, { nickname: '<>' });

      const call = mockDelegate.update.mock.calls[0][0];
      expect(call.data.nickname).toBeNull();
    });

    it('rejects when the caller lacks device:update', async () => {
      configure(new Set(['device:read']));
      await expect(CduRecord.updateByDeviceId(deviceId, { ratedThermalCapacityKw: 1 })).rejects.toThrow();
      expect(mockDelegate.update).not.toHaveBeenCalled();
    });
  });
});
