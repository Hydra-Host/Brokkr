import { ForbiddenException } from '@nestjs/common';
import { ActiveRecordRegistry } from '@repo/active-record';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZoneRecord } from '../zone.record';

describe('ZoneRecord', () => {
  const mockDelegate = {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };

  const orgId = 'org-1';

  const fullZone = {
    id: 'zone-1',
    name: 'phx-az1',
    uuidSuffix: 'zone1',
    internalName: null,
    organizationId: orgId,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  beforeEach(() => {
    vi.resetAllMocks();
    ActiveRecordRegistry.configureForTest({ zone: mockDelegate }, () => ({
      organizationId: orgId,
      permissions: new Set(['zone:read', 'zone:create', 'zone:update', 'zone:delete']),
    }));
  });

  afterEach(() => vi.resetAllMocks());

  describe('findAllActive', () => {
    it('auto-scopes by ctx.organizationId and filters soft-deletes', async () => {
      mockDelegate.findMany.mockResolvedValue([fullZone]);
      await ZoneRecord.findAllActive();

      expect(mockDelegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { deletedAt: null, organizationId: orgId },
          orderBy: { name: 'asc' },
        }),
      );
    });
  });

  describe('findActiveById', () => {
    it('auto-scopes by ctx.organizationId', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullZone);
      const r = await ZoneRecord.findActiveById('zone-1');

      expect(r?.data.id).toBe('zone-1');
      expect(mockDelegate.findFirst).toHaveBeenCalledWith({
        where: { id: 'zone-1', deletedAt: null, organizationId: orgId },
      });
    });

    it('returns null when not found in the caller org', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      const r = await ZoneRecord.findActiveById('zone-1');
      expect(r).toBeNull();
    });

    it('cross-tenant isolation: a zone owned by another tenant is invisible to the caller', async () => {
      const foreignZone = { ...fullZone, organizationId: 'other-tenant' };
      mockDelegate.findFirst.mockImplementation((args: { where: { organizationId?: string } }) =>
        Promise.resolve(args.where.organizationId === 'other-tenant' ? foreignZone : null),
      );

      const r = await ZoneRecord.findActiveById('zone-1');
      expect(r).toBeNull();
      expect(mockDelegate.findFirst).toHaveBeenCalledWith({
        where: { id: 'zone-1', deletedAt: null, organizationId: orgId },
      });
    });
  });

  describe('findFullActiveById', () => {
    it('auto-scopes and includes the relation graph', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullZone);
      await ZoneRecord.findFullActiveById('zone-1');

      expect(mockDelegate.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'zone-1', deletedAt: null, organizationId: orgId },
          include: expect.any(Object),
        }),
      );
    });
  });

  describe('fromCreateRequest / build (tenant stamping)', () => {
    it('stamps organizationId from ctx and derives uuidSuffix from the id', () => {
      const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeee54321';
      const record = ZoneRecord.fromCreateRequest(
        {
          name: 'phx-az2',
          primaryAddress: {
            addressLineOne: '123 Main St',
            city: 'Phoenix',
            countryCode: 'US',
            latitude: 33.45,
            longitude: -112.07,
            timezone: 'America/Phoenix',
          },
          contacts: [
            {
              name: 'Ops Lead',
              title: 'Operations',
              email: 'ops@example.com',
              phone: '+14155550123',
              contactType: 'Technical',
              isShippingContact: false,
            },
          ],
        },
        id,
      );
      expect(record.data.organizationId).toBe(orgId);
      expect(record.data.name).toBe('phx-az2');
      expect(record.data.id).toBe(id);
      expect(record.data.uuidSuffix).toBe('54321');
      expect(record.isNew).toBe(true);
    });

    it('rejects a caller without zone:create', () => {
      ActiveRecordRegistry.configureForTest({ zone: mockDelegate }, () => ({
        organizationId: orgId,
        permissions: new Set(['zone:read', 'zone:update', 'zone:delete']),
      }));

      expect(() =>
        ZoneRecord.fromCreateRequest({ name: 'phx-az2', primaryAddress: {}, contacts: [] } as never, 'id-54321'),
      ).toThrow(ForbiddenException);
    });
  });

  describe('soft delete (set deletedAt + save)', () => {
    it('save() on a soft-deleted record routes through update with the tenant-scoped where', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullZone);
      mockDelegate.update.mockResolvedValue({ ...fullZone, deletedAt: new Date() });

      const record = await ZoneRecord.findActiveById('zone-1');
      expect(record).not.toBeNull();
      await record!.delete();

      expect(mockDelegate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'zone-1', organizationId: orgId },
          data: expect.objectContaining({ deletedAt: expect.any(Date) }),
        }),
      );
    });
  });
});
