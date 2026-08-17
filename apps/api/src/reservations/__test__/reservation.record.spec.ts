import { NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry } from '@repo/active-record';
import type { Prisma } from '@repo/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReservationRecord } from '../reservation.record';

describe('ReservationRecord', () => {
  const mockServerDelegate = { findMany: vi.fn().mockResolvedValue([]) };

  const mockDelegate = {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
  };

  const mockClient: {
    reservation: typeof mockDelegate;
    server: typeof mockServerDelegate;
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
  } = {
    reservation: mockDelegate,
    server: mockServerDelegate,
    $transaction: (fn) => fn(mockClient),
  };

  const customerId = 'customer-org-1';

  const baseReservation = {
    id: 'res-1',
    openmeterSubscriptionId: null,
    internalProvision: false,
    startDate: new Date('2026-01-01'),
    endDate: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: null,
    notes: null,
    reserverId: 'reserver-1',
    customerId,
    price: null,
    billingFrequency: null,
    interruptibleNoticePeriod: null,
  };

  beforeEach(() => {
    vi.resetAllMocks();
    ActiveRecordRegistry.configureForTest(
      {
        reservation: mockDelegate,
        server: mockServerDelegate,
      },
      () => ({ organizationId: customerId, permissions: new Set<string>() }),
    );
    ActiveRecordRegistry.client.$transaction =
      mockClient.$transaction as unknown as typeof ActiveRecordRegistry.client.$transaction;
  });

  afterEach(() => vi.resetAllMocks());

  describe('findActiveByDeviceIdUnscoped (saga / billing)', () => {
    it('queries via Server.deviceId relational filter on the join + endDate=null WITHOUT the customerId scope', async () => {
      mockDelegate.findFirst.mockResolvedValue(baseReservation);
      await ReservationRecord.findActiveByDeviceIdUnscoped('device-1');

      expect(mockDelegate.findFirst).toHaveBeenCalledWith({
        where: {
          serversInReservation: { some: { server: { deviceId: 'device-1' } } },
          endDate: null,
        },
      });
      const call = mockDelegate.findFirst.mock.calls[0][0];
      expect(call.where).not.toHaveProperty('customerId');
    });
  });

  describe('createReservation (saga path)', () => {
    it('uses data.customerId verbatim via `customer: { connect: { id } }` — no injection from ctx', async () => {
      mockServerDelegate.findMany.mockResolvedValue([{ id: 'server-1', deviceId: 'device-1' }]);
      mockDelegate.create.mockResolvedValue({ id: 'new-res' });
      mockDelegate.findUnique.mockResolvedValue({
        ...baseReservation,
        id: 'new-res',
        customerId: 'other-buyer-org',
        serversInReservation: [{ server: { device: { id: 'device-1' } } }],
      });

      await ReservationRecord.createReservation({
        customerId: 'other-buyer-org',
        reserverId: 'reserver-1',
        internalProvision: false,
        notes: null,
        openmeterSubscriptionId: null,
        deviceIds: ['device-1'],
        price: 100,
        billingFrequency: 'MONTHLY',
      } as unknown as Parameters<typeof ReservationRecord.createReservation>[0]);

      expect(mockDelegate.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            customer: { connect: { id: 'other-buyer-org' } },
            price: 100,
            billingFrequency: 'MONTHLY',
          }),
        }),
      );
    });
  });

  describe('endByIdUnscoped (saga / billing)', () => {
    it('throws NotFoundException when the reservation does not exist', async () => {
      mockDelegate.findUnique.mockResolvedValue(null);
      await expect(ReservationRecord.endByIdUnscoped('missing')).rejects.toThrow(NotFoundException);
    });

    it('updates endDate without applying the customerId scope', async () => {
      mockDelegate.findUnique.mockResolvedValueOnce({ id: 'res-1' }).mockResolvedValueOnce({
        ...baseReservation,
        serversInReservation: [],
        endDate: new Date(),
      });
      mockDelegate.update.mockResolvedValue({ id: 'res-1', endDate: new Date() });

      await ReservationRecord.endByIdUnscoped('res-1');

      expect(mockDelegate.update).toHaveBeenCalledWith({
        where: { id: 'res-1' },
        data: { endDate: expect.any(Date) },
      });
    });
  });

  describe('endActiveByIdUnscoped (deprovision)', () => {
    it('ends an open reservation and returns true', async () => {
      mockDelegate.updateMany.mockResolvedValue({ count: 1 });

      await expect(ReservationRecord.endActiveByIdUnscoped('res-1')).resolves.toBe(true);

      expect(mockDelegate.updateMany).toHaveBeenCalledWith({
        where: { id: 'res-1', endDate: null },
        data: { endDate: expect.any(Date) },
      });
    });

    it('returns false when the reservation is already ended or missing', async () => {
      mockDelegate.updateMany.mockResolvedValue({ count: 0 });
      await expect(ReservationRecord.endActiveByIdUnscoped('res-1')).resolves.toBe(false);
    });

    it('routes through the transaction client when one is passed', async () => {
      const txDelegate = { updateMany: vi.fn().mockResolvedValue({ count: 1 }) };
      const tx = { reservation: txDelegate } as unknown as Prisma.TransactionClient;

      await expect(ReservationRecord.endActiveByIdUnscoped('res-1', tx)).resolves.toBe(true);

      expect(txDelegate.updateMany).toHaveBeenCalledWith({
        where: { id: 'res-1', endDate: null },
        data: { endDate: expect.any(Date) },
      });
      expect(mockDelegate.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('endByDeviceIdUnscoped (billing failed-payment handler)', () => {
    it('returns null when no active reservation covers the device', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      const result = await ReservationRecord.endByDeviceIdUnscoped('device-1');
      expect(result).toBeNull();
    });
  });

  describe('save() — _scopeWhere defense-in-depth (policy)', () => {
    it('uses the record customerId verbatim — does NOT inject from request context', async () => {
      ActiveRecordRegistry.configureForTest({ reservation: mockDelegate }, () => ({
        organizationId: 'a-different-org',
        permissions: new Set<string>(),
      }));
      mockDelegate.update.mockResolvedValue(baseReservation);

      const record = ReservationRecord.fromRow(baseReservation);
      record.set({ notes: 'updated note' });
      await record.save();

      expect(mockDelegate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'res-1', customerId },
          data: expect.objectContaining({ notes: 'updated note' }),
        }),
      );
    });
  });

  describe('findAggregateByIdUnscoped (post-write reload)', () => {
    it('returns null when the reservation is missing', async () => {
      mockDelegate.findUnique.mockResolvedValue(null);
      const result = await ReservationRecord.findAggregateByIdUnscoped('missing');
      expect(result).toBeNull();
    });

    it('returns the aggregate without applying the customerId scope (saga refetch)', async () => {
      mockDelegate.findUnique.mockResolvedValue({
        ...baseReservation,
        serversInReservation: [{ server: { device: { id: 'device-1' } } }],
      });

      const result = await ReservationRecord.findAggregateByIdUnscoped('res-1');

      expect(mockDelegate.findUnique).toHaveBeenCalledWith({
        where: { id: 'res-1' },
        include: expect.any(Object),
      });
      const call = mockDelegate.findUnique.mock.calls[0][0];
      expect(call.where).not.toHaveProperty('customerId');
      expect(result).not.toBeNull();
    });
  });
});
