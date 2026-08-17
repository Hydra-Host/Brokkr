import { BadRequestException, HttpException } from '@nestjs/common';
import { ActiveRecordRegistry } from '@repo/active-record';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InvalidExpirationDateException,
  ReservationInviteNotActiveException,
  ReservationInviteRecord,
} from '../reservation-invite.record';

describe('ReservationInviteRecord', () => {

  const mockDelegate = {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
  };

  const supplierOrgId = 'supplier-org-1';

  const baseInvite = {
    id: 'invite-1',
    inviteeEmail: 'buyer@example.com',
    inviterEmail: 'sales@supplier.com',
    inviteeOrganizationId: null,
    price: 100,
    billingFrequency: 'MONTHLY',
    manualBilling: false,
    interruptibleNoticePeriod: null,
    notes: null,
    dateAccepted: null,
    dateCreated: new Date('2026-01-01'),
    dateDeleted: null,
    dateExpires: new Date('2099-01-01'),
    dateUpdated: null,
    organizationId: supplierOrgId,
    reservationId: null,
  };

  beforeEach(() => {
    vi.resetAllMocks();
    ActiveRecordRegistry.configureForTest({ reservationInvite: mockDelegate }, () => ({
      organizationId: supplierOrgId,
      permissions: new Set<string>(['reservation-invite:read']),
    }));
  });

  afterEach(() => vi.resetAllMocks());

  describe('isActive', () => {
    it('is true when not accepted, not deleted, and not expired', () => {
      const record = ReservationInviteRecord.fromRow(baseInvite);
      expect(record.isActive).toBe(true);
    });

    it('is false when accepted', () => {
      const record = ReservationInviteRecord.fromRow({ ...baseInvite, dateAccepted: new Date() });
      expect(record.isActive).toBe(false);
    });

    it('is false when soft-deleted', () => {
      const record = ReservationInviteRecord.fromRow({ ...baseInvite, dateDeleted: new Date() });
      expect(record.isActive).toBe(false);
    });

    it('is false when expired', () => {
      const record = ReservationInviteRecord.fromRow({ ...baseInvite, dateExpires: new Date('2020-01-01') });
      expect(record.isActive).toBe(false);
    });
  });

  describe('accept (in-memory mutation)', () => {
    it('sets dateAccepted on an active invite', () => {
      const record = ReservationInviteRecord.fromRow(baseInvite);
      record.accept();
      expect(record.data.dateAccepted).toBeInstanceOf(Date);
      expect(record.isDirty).toBe(true);
    });

    it('throws ReservationInviteNotActiveException on an already-accepted invite', () => {
      const record = ReservationInviteRecord.fromRow({ ...baseInvite, dateAccepted: new Date() });
      expect(() => record.accept()).toThrow(ReservationInviteNotActiveException);
    });

    it('throws on a soft-deleted or expired invite', () => {
      const deleted = ReservationInviteRecord.fromRow({ ...baseInvite, dateDeleted: new Date() });
      expect(() => deleted.accept()).toThrow(ReservationInviteNotActiveException);

      const expired = ReservationInviteRecord.fromRow({ ...baseInvite, dateExpires: new Date('2020-01-01') });
      expect(() => expired.accept()).toThrow(ReservationInviteNotActiveException);
    });
  });

  describe('save() — _scopeWhere defense-in-depth', () => {
    it('threads organizationId from the record into the update where', async () => {
      mockDelegate.update.mockResolvedValue(baseInvite);
      const record = ReservationInviteRecord.fromRow(baseInvite);
      record.accept();
      await record.save();

      expect(mockDelegate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'invite-1', organizationId: supplierOrgId },
          data: expect.objectContaining({ dateAccepted: expect.any(Date) }),
        }),
      );
    });

    it('uses the record organizationId verbatim — does NOT inject from request context', async () => {
      ActiveRecordRegistry.configureForTest({ reservationInvite: mockDelegate }, () => ({
        organizationId: 'invitee-org',
        permissions: new Set<string>(['reservation-invite:read']),
      }));
      mockDelegate.update.mockResolvedValue(baseInvite);
      const record = ReservationInviteRecord.fromRow(baseInvite);
      record.accept();
      await record.save();

      expect(mockDelegate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'invite-1', organizationId: supplierOrgId },
        }),
      );
    });
  });

  describe('findActiveByIdOrThrowUnscoped', () => {
    it('returns an active record without applying the supplier-scope filter', async () => {
      mockDelegate.findUnique.mockResolvedValue(baseInvite);

      const record = await ReservationInviteRecord.findActiveByIdOrThrowUnscoped('invite-1');
      expect(record.data.id).toBe('invite-1');
      expect(mockDelegate.findUnique).toHaveBeenCalledWith({ where: { id: 'invite-1' } });
    });

    it('throws HttpException(404) when the invite does not exist', async () => {
      mockDelegate.findUnique.mockResolvedValue(null);
      await expect(ReservationInviteRecord.findActiveByIdOrThrowUnscoped('missing')).rejects.toThrow(HttpException);
    });

    it('throws BadRequestException when the invite exists but is not active', async () => {
      mockDelegate.findUnique.mockResolvedValue({ ...baseInvite, dateAccepted: new Date() });
      await expect(ReservationInviteRecord.findActiveByIdOrThrowUnscoped('invite-1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('softDeleteIfActiveUnscoped — atomic gate', () => {
    it('returns true when updateMany matched a currently-active row', async () => {
      mockDelegate.updateMany.mockResolvedValue({ count: 1 });
      const result = await ReservationInviteRecord.softDeleteIfActiveUnscoped('invite-1');
      expect(result).toBe(true);
    });

    it('returns false when updateMany matched no rows (race lost — already accepted/deleted/expired)', async () => {
      mockDelegate.updateMany.mockResolvedValue({ count: 0 });
      const result = await ReservationInviteRecord.softDeleteIfActiveUnscoped('invite-1');
      expect(result).toBe(false);
    });

    it('the update where guards on active predicate (dateAccepted/Deleted null, dateExpires future)', async () => {
      mockDelegate.updateMany.mockResolvedValue({ count: 1 });
      await ReservationInviteRecord.softDeleteIfActiveUnscoped('invite-1');

      expect(mockDelegate.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'invite-1',
            dateAccepted: null,
            dateDeleted: null,
            dateExpires: { gt: expect.any(Date) },
          }),
          data: expect.objectContaining({ dateDeleted: expect.any(Date) }),
        }),
      );
    });
  });

  describe('createInviteWithDeviceLinks', () => {
    it('throws InvalidExpirationDateException when dateExpires is in the past', async () => {
      await expect(
        ReservationInviteRecord.createInviteWithDeviceLinks({
          inviteeEmail: 'x@y.com',
          inviterEmail: 'a@b.com',
          dateExpires: new Date('2020-01-01'),
          price: 1,
          billingFrequency: 'MONTHLY',
          organizationId: supplierOrgId,
          deviceIds: ['device-1'],
        } as unknown as Parameters<typeof ReservationInviteRecord.createInviteWithDeviceLinks>[0]),
      ).rejects.toThrow(InvalidExpirationDateException);
    });
  });

  describe('applyEditWithDeviceLinks', () => {
    it('throws InvalidExpirationDateException when dateExpires is in the past', async () => {
      await expect(
        ReservationInviteRecord.applyEditWithDeviceLinks('invite-1', {
          dateExpires: new Date('2020-01-01'),
          price: 1,
          billingFrequency: 'MONTHLY',
          deviceIds: ['device-1'],
        } as unknown as Parameters<typeof ReservationInviteRecord.applyEditWithDeviceLinks>[1]),
      ).rejects.toThrow(InvalidExpirationDateException);
    });
  });

  describe('findActiveForInviteeAggregates (invitee-side multi-column OR)', () => {
    it('queries by inviteeEmail OR inviteeOrganizationId with the active predicate on each branch', async () => {
      mockDelegate.findMany.mockResolvedValue([baseInvite]);

      await ReservationInviteRecord.findActiveForInviteeAggregates('buyer@example.com', ['demand-org-1']);

      expect(mockDelegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [
              expect.objectContaining({
                inviteeEmail: 'buyer@example.com',
                dateAccepted: null,
                dateDeleted: null,
              }),
              expect.objectContaining({
                inviteeOrganizationId: { in: ['demand-org-1'] },
                dateAccepted: null,
                dateDeleted: null,
              }),
            ],
          }),
        }),
      );
    });

    it('de-duplicates results when both branches match the same invite', async () => {
      const sameRow = { ...baseInvite, id: 'invite-1' };
      mockDelegate.findMany.mockResolvedValue([sameRow, sameRow]);

      const result = await ReservationInviteRecord.findActiveForInviteeAggregates('buyer@example.com', [
        'demand-org-1',
      ]);
      expect(result).toHaveLength(1);
    });
  });

  describe('findActiveByDeviceForSupplierAggregates (supplier-side device scope)', () => {
    it('scopes by device.supplierId — NOT by invite.organizationId (admin invites visible to supplier)', async () => {
      mockDelegate.findMany.mockResolvedValue([]);

      await ReservationInviteRecord.findActiveByDeviceForSupplierAggregates('device-1', supplierOrgId);

      expect(mockDelegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            serversInReservationInvite: {
              some: { server: { deviceId: 'device-1', device: { supplierId: supplierOrgId } } },
            },
          }),
        }),
      );
    });
  });
});
