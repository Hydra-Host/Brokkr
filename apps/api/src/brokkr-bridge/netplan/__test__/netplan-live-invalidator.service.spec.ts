import { Test } from '@nestjs/testing';
import { PrismaClient } from 'src/prisma/prisma.client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NetplanLiveInvalidatorService } from '../netplan-live-invalidator.service';
import { NetplanRedisWriterService } from '../netplan-redis-writer.service';

const DEVICE_ID = 'device-1';
const IFACE_ID = 'if-1';
const ZONE_ID = 'zone-1';

describe('NetplanLiveInvalidatorService', () => {
  let service: NetplanLiveInvalidatorService;
  const deviceFindUnique = vi.fn();
  const interfaceFindUnique = vi.fn();
  const deleteLive = vi.fn();
  const warn = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    deviceFindUnique.mockResolvedValue({ zoneId: ZONE_ID });
    interfaceFindUnique.mockResolvedValue({ deviceId: DEVICE_ID, device: { zoneId: ZONE_ID } });
    deleteLive.mockResolvedValue(undefined);
    const module = await Test.createTestingModule({
      providers: [
        NetplanLiveInvalidatorService,
        {
          provide: PrismaClient,
          useValue: { device: { findUnique: deviceFindUnique }, interface: { findUnique: interfaceFindUnique } },
        },
        { provide: NetplanRedisWriterService, useValue: { deleteLive } },
        {
          provide: `LoggerService${NetplanLiveInvalidatorService.name}`,
          useValue: { log: vi.fn(), warn, error: vi.fn(), debug: vi.fn(), verbose: vi.fn() },
        },
      ],
    }).compile();
    service = module.get(NetplanLiveInvalidatorService);
  });

  describe('forDevice', () => {
    it('deletes the live atom for the device zone', async () => {
      await service.forDevice(DEVICE_ID);

      expect(deviceFindUnique).toHaveBeenCalledWith({ where: { id: DEVICE_ID }, select: { zoneId: true } });
      expect(deleteLive).toHaveBeenCalledWith(ZONE_ID, DEVICE_ID);
    });

    it('skips the delete when the device has no zone', async () => {
      deviceFindUnique.mockResolvedValue({ zoneId: null });

      await service.forDevice(DEVICE_ID);

      expect(deleteLive).not.toHaveBeenCalled();
    });

    it('skips the delete when the device is missing', async () => {
      deviceFindUnique.mockResolvedValue(null);

      await service.forDevice(DEVICE_ID);

      expect(deleteLive).not.toHaveBeenCalled();
    });

    it('logs a warning and resolves when the zone lookup rejects', async () => {
      deviceFindUnique.mockRejectedValue(new Error('db down'));

      await expect(service.forDevice(DEVICE_ID)).resolves.toBeUndefined();

      expect(deleteLive).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('db down'));
    });

    it('logs a warning and resolves when the atom delete rejects', async () => {
      deleteLive.mockRejectedValue(new Error('redis down'));

      await expect(service.forDevice(DEVICE_ID)).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('redis down'));
    });
  });

  describe('forInterface', () => {
    it('deletes the live atom for the owning device zone', async () => {
      await service.forInterface(IFACE_ID);

      expect(interfaceFindUnique).toHaveBeenCalledWith({
        where: { id: IFACE_ID },
        select: { deviceId: true, device: { select: { zoneId: true } } },
      });
      expect(deleteLive).toHaveBeenCalledWith(ZONE_ID, DEVICE_ID);
    });

    it('is a no-op for a null interface', async () => {
      await service.forInterface(null);

      expect(interfaceFindUnique).not.toHaveBeenCalled();
      expect(deleteLive).not.toHaveBeenCalled();
    });

    it('skips the delete when the interface is missing', async () => {
      interfaceFindUnique.mockResolvedValue(null);

      await service.forInterface(IFACE_ID);

      expect(deleteLive).not.toHaveBeenCalled();
    });

    it('skips the delete when the owning device has no zone', async () => {
      interfaceFindUnique.mockResolvedValue({ deviceId: DEVICE_ID, device: { zoneId: null } });

      await service.forInterface(IFACE_ID);

      expect(deleteLive).not.toHaveBeenCalled();
    });

    it('logs a warning and resolves when the zone lookup rejects', async () => {
      interfaceFindUnique.mockRejectedValue(new Error('db down'));

      await expect(service.forInterface(IFACE_ID)).resolves.toBeUndefined();

      expect(deleteLive).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('db down'));
    });

    it('logs a warning and resolves when the atom delete rejects', async () => {
      deleteLive.mockRejectedValue(new Error('redis down'));

      await expect(service.forInterface(IFACE_ID)).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('redis down'));
    });
  });
});
