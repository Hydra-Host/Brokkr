import { Test, type TestingModule } from '@nestjs/testing';
import { PrismaClient } from 'src/prisma/prisma.client';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { DeviceResolverService } from '../device-resolver.service';

const MAC_INPUT = 'AA-BB-CC-DD-EE-FF';
const NORMALIZED_MAC = 'aa:bb:cc:dd:ee:ff';
const SYSTEM_UUID = '550e8400-e29b-41d4-a716-446655440000';
const SERIAL = 'SN-100';
const NEW_DEVICE_ID = '550e8400-e29b-41d4-a716-446655440011';
const OLD_DEVICE_ID = '550e8400-e29b-41d4-a716-446655440022';

function makeRow(id: string) {
  return { id };
}

describe('DeviceResolverService', () => {
  let resolver: DeviceResolverService;
  let prisma: { device: { findMany: Mock; findUnique: Mock } };
  let mockLogger: { log: Mock; warn: Mock; error: Mock; debug: Mock; verbose: Mock; setContext: Mock };

  beforeEach(async () => {
    prisma = { device: { findMany: vi.fn(), findUnique: vi.fn() } };
    mockLogger = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      verbose: vi.fn(),
      setContext: vi.fn().mockReturnThis(),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeviceResolverService,
        { provide: PrismaClient, useValue: prisma },
        { provide: `LoggerService${DeviceResolverService.name}`, useValue: mockLogger },
      ],
    }).compile();
    resolver = module.get(DeviceResolverService);
  });

  describe('mac match', () => {
    it('returns kind=pending when no row matches any identifier', async () => {
      prisma.device.findMany.mockResolvedValue([]);
      prisma.device.findUnique.mockResolvedValue(null);
      const result = await resolver.resolve({ mac: MAC_INPUT });
      expect(result).toEqual({ kind: 'pending' });
    });

    it('returns a known resolution with matchedOn=mac on a single hit', async () => {
      prisma.device.findMany.mockResolvedValueOnce([makeRow(NEW_DEVICE_ID)]);
      const result = await resolver.resolve({ mac: MAC_INPUT });
      expect(result.kind).toBe('known');
      if (result.kind !== 'known') throw new Error('expected known resolution');
      expect(result.device.id).toBe(NEW_DEVICE_ID);
      expect(result.matchedOn).toBe('mac');
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('warns and returns the most-recently-created row on duplicate hits', async () => {
      prisma.device.findMany.mockResolvedValueOnce([makeRow(NEW_DEVICE_ID), makeRow(OLD_DEVICE_ID)]);
      const result = await resolver.resolve({ mac: MAC_INPUT });
      expect(result.kind).toBe('known');
      if (result.kind !== 'known') throw new Error('expected known resolution');
      expect(result.device.id).toBe(NEW_DEVICE_ID);
      expect(mockLogger.warn).toHaveBeenCalledTimes(1);
      const warning = mockLogger.warn.mock.calls[0][0] as string;
      expect(warning).toContain(`mac=${NORMALIZED_MAC}`);
    });

    it('normalizes inbound MAC to colon-form lowercase and matches interface MACs case-insensitively', async () => {
      prisma.device.findMany.mockResolvedValueOnce([]);
      await resolver.resolve({ mac: 'AA-BB-CC-DD-EE-FF' });
      const where = prisma.device.findMany.mock.calls[0][0].where;
      expect(where.AND[1]).toEqual({
        interfaces: { some: { macAddress: { equals: NORMALIZED_MAC, mode: 'insensitive' }, deletedAt: null } },
      });
    });

    it('filters soft-deleted rows and orders by createdAt desc', async () => {
      prisma.device.findMany.mockResolvedValueOnce([]);
      await resolver.resolve({ mac: MAC_INPUT });
      const call = prisma.device.findMany.mock.calls[0][0];
      expect(call.orderBy).toEqual({ createdAt: 'desc' });
      expect(call.take).toBe(2);
      expect(call.where.AND[0]).toEqual({ deletedAt: null });
    });
  });

  describe('uuid match', () => {
    it('matches systemUuid through the active-status filter', async () => {
      prisma.device.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([makeRow(NEW_DEVICE_ID)]);
      const result = await resolver.resolve({ mac: MAC_INPUT, system_uuid: SYSTEM_UUID });
      expect(result.kind).toBe('known');
      const uuidCall = prisma.device.findMany.mock.calls[1][0];
      expect(uuidCall.where.AND[0]).toEqual({ deletedAt: null });
      expect(uuidCall.where.AND[1]).toEqual({ systemUuid: { equals: SYSTEM_UUID, mode: 'insensitive' } });
    });

    it('resolves a DEPROVISIONING device by system_uuid (status is not excluded)', async () => {
      prisma.device.findMany.mockResolvedValue([makeRow(NEW_DEVICE_ID)]);
      const result = await resolver.resolve({ system_uuid: SYSTEM_UUID });
      expect(result.kind).toBe('known');
    });
  });

  describe('serial match', () => {
    it('falls through to serial when mac/ipmi/uuid all miss', async () => {
      prisma.device.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([makeRow(NEW_DEVICE_ID)]);

      const result = await resolver.resolve({
        mac: MAC_INPUT,
        ipmi_mac: '11:22:33:44:55:66',
        system_uuid: SYSTEM_UUID,
        serial: SERIAL,
      });
      expect(result.kind).toBe('known');
      if (result.kind !== 'known') throw new Error('expected known resolution');
      expect(result.matchedOn).toBe('serial');
    });
  });

  describe('precedence', () => {
    it('mac wins over later identifiers', async () => {
      prisma.device.findMany.mockResolvedValueOnce([makeRow(NEW_DEVICE_ID)]);
      const result = await resolver.resolve({ mac: MAC_INPUT, serial: SERIAL });
      expect(result.kind).toBe('known');
      expect(prisma.device.findMany).toHaveBeenCalledTimes(1);
    });
  });
});
