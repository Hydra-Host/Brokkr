import { NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry } from '@repo/active-record';
import { DeviceRole, DeviceStatus, PduPowerStatus } from '@repo/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PduRecord } from '../pdu.record';

describe('PduRecord', () => {
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
  const deviceId = 'dev-pdu-1';
  const devicePerms = new Set(['device:read', 'device:create', 'device:update', 'device:delete']);

  const fullPdu = {
    id: deviceId,
    name: 'PHX1-PDU-1',
    nickname: null,
    systemSerial: null,
    chassisSerial: null,
    serial: null,
    baseboardSerial: null,
    systemUuid: null,
    productSku: null,
    assetTag: null,
    role: DeviceRole.PDU,
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
    pdu: { id: 'pdu-1', outletCount: 24, ratedAmperage: 30, voltageType: '208V', powerStatus: PduPowerStatus.On },
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
    it('pins the query to role=PDU + the caller supplierId', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullPdu);
      const record = await PduRecord.findByDeviceIdOrThrow(deviceId);

      expect(record.data.id).toBe(deviceId);
      const call = mockDelegate.findFirst.mock.calls[0][0];
      expect(call.where).toMatchObject({ id: deviceId, supplierId: orgId, role: DeviceRole.PDU });
    });

    it('throws NotFoundException when nothing matches the scope', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      await expect(PduRecord.findByDeviceIdOrThrow('missing')).rejects.toThrow(NotFoundException);
    });

    it('cross-tenant isolation: a foreign-supplier PDU is invisible', async () => {
      mockDelegate.findFirst.mockImplementation((args: { where: { supplierId?: unknown } }) =>
        Promise.resolve(args.where.supplierId === 'other-tenant' ? { ...fullPdu, supplierId: 'other-tenant' } : null),
      );
      await expect(PduRecord.findByDeviceIdOrThrow(deviceId)).rejects.toThrow(NotFoundException);
    });

    it('rejects when the caller lacks device:read', async () => {
      configure(new Set());
      await expect(PduRecord.findByDeviceIdOrThrow(deviceId)).rejects.toThrow();
      expect(mockDelegate.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('decommissionByDeviceId', () => {
    it('soft-deletes (deletedAt + MAINTENANCE) scoped to role=PDU + supplier', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullPdu);
      mockDelegate.update.mockResolvedValue({ ...fullPdu, deletedAt: new Date(), status: DeviceStatus.MAINTENANCE });

      await PduRecord.decommissionByDeviceId(deviceId);

      const call = mockDelegate.update.mock.calls[0][0];
      expect(call.data.status).toBe(DeviceStatus.MAINTENANCE);
      expect(call.data.deletedAt).toBeInstanceOf(Date);
      expect(call.where).toMatchObject({ id: deviceId, supplierId: orgId, role: DeviceRole.PDU });
    });

    it('rejects when the caller lacks device:delete', async () => {
      configure(new Set(['device:read']));
      await expect(PduRecord.decommissionByDeviceId(deviceId)).rejects.toThrow();
      expect(mockDelegate.update).not.toHaveBeenCalled();
    });
  });

  describe('listPaginated', () => {
    it('restricts the live listing to ACTIVE-status devices', async () => {
      mockDelegate.findMany.mockResolvedValue([]);
      mockDelegate.count.mockResolvedValue(0);

      await PduRecord.listPaginated({ page: 1 });

      const call = mockDelegate.findMany.mock.calls[0][0];
      expect(call.where).toMatchObject({ status: DeviceStatus.ACTIVE, deletedAt: null });
    });

    it('decommissioned listing shows tombstoned rows regardless of status', async () => {
      mockDelegate.findMany.mockResolvedValue([]);
      mockDelegate.count.mockResolvedValue(0);

      await PduRecord.listPaginated({ page: 1, decommissioned: true });

      const call = mockDelegate.findMany.mock.calls[0][0];
      expect(call.where).toMatchObject({ deletedAt: { not: null } });
      expect(call.where).not.toHaveProperty('status');
    });
  });

  describe('updateByDeviceId', () => {
    it('sanitizes nickname and writes PDU fields through the extension', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullPdu);
      mockDelegate.update.mockResolvedValue({
        ...fullPdu,
        nickname: 'scriptxscript',
        pdu: { ...fullPdu.pdu, outletCount: 48 },
      });

      await PduRecord.updateByDeviceId(deviceId, { nickname: '<script>x</script>', outletCount: 48 });

      const call = mockDelegate.update.mock.calls[0][0];
      expect(call.data.nickname).not.toMatch(/[<>]/);
      expect(call.data.pdu).toEqual({ update: { outletCount: 48 } });
    });

    it('stores null when sanitization strips the nickname to empty', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullPdu);
      mockDelegate.update.mockResolvedValue(fullPdu);

      await PduRecord.updateByDeviceId(deviceId, { nickname: '<>' });

      const call = mockDelegate.update.mock.calls[0][0];
      expect(call.data.nickname).toBeNull();
    });

    it('rejects when the caller lacks device:update', async () => {
      configure(new Set(['device:read']));
      await expect(PduRecord.updateByDeviceId(deviceId, { outletCount: 1 })).rejects.toThrow();
      expect(mockDelegate.update).not.toHaveBeenCalled();
    });
  });
});
