import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DeviceSecretActorType, DeviceSecretKind, DeviceSecretPurpose } from '@repo/database';
import { DeviceSecretService, type SealedSecretEnvelope } from 'src/device-secret/device-secret.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { DeviceContextRow, DeviceContextService, extractBmcIp } from '../device-context.service';

const DEVICE_UUID = 'device-uuid-42';

const SEALED_BMC: SealedSecretEnvelope = {
  zoneId: 'zone-abc',
  zoneKeyId: 'zone-key-1',
  deviceId: DEVICE_UUID,
  purpose: DeviceSecretPurpose.BMC,
  kind: DeviceSecretKind.USER,
  keyGen: 1,
  ephPub: 'ZXBo',
  ciphertext: 'Y2lwaGVy',
  tag: 'dGFn',
};

function ifaceWithIps(opts: {
  mgmtOnly: boolean;
  name: string;
  ips: string[];
}): DeviceContextRow['interfaces'][number] {
  return {
    id: `iface-${opts.name}`,
    name: opts.name,
    mgmtOnly: opts.mgmtOnly,
    macAddress: opts.mgmtOnly ? 'AA:BB:CC:DD:EE:FF' : '00:11:22:33:44:55',
    ipAddresses: opts.ips.map((address, i) => ({ id: `${opts.name}-ip-${i}`, address })),
  } as DeviceContextRow['interfaces'][number];
}

function makeDevice(overrides: Partial<DeviceContextRow> = {}): DeviceContextRow {
  return {
    id: DEVICE_UUID,
    zoneId: 'zone-abc',
    ipmiBootDeviceOverride: null,
    architecture: null,
    cpus: [],
    supplier: { id: 'supplier-1' },
    server: { teeEnabled: false },
    interfaces: [ifaceWithIps({ mgmtOnly: true, name: 'IPMI', ips: ['10.0.0.5/24'] })],
    ...overrides,
  } as DeviceContextRow;
}

describe('extractBmcIp', () => {
  it('returns plain IPv4 unchanged', () => {
    expect(extractBmcIp('10.0.0.5')).toBe('10.0.0.5');
  });

  it('strips CIDR suffix', () => {
    expect(extractBmcIp('10.0.0.5/24')).toBe('10.0.0.5');
  });

  it('picks the IPv4 from a comma-separated dual-stack string', () => {
    expect(extractBmcIp('2606:a5c0:0:50:e207:1bff:fefa:4d38/64,172.16.28.70/22')).toBe('172.16.28.70');
  });

  it('returns null when no valid IPv4 is present', () => {
    expect(extractBmcIp('2606:a5c0:0:50:e207:1bff:fefa:4d38/64')).toBeNull();
  });

  it('returns null on an empty string', () => {
    expect(extractBmcIp('')).toBeNull();
  });
});

describe('DeviceContextService', () => {
  let service: DeviceContextService;
  let prisma: { device: { findUnique: Mock } };
  let deviceSecretService: { getCurrentSealedByKind: Mock };

  beforeEach(async () => {
    prisma = {
      device: { findUnique: vi.fn() },
    };
    deviceSecretService = {
      getCurrentSealedByKind: vi.fn().mockResolvedValue(SEALED_BMC),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeviceContextService,
        { provide: PrismaClient, useValue: prisma },
        { provide: DeviceSecretService, useValue: deviceSecretService },
      ],
    }).compile();

    service = module.get(DeviceContextService);
  });

  describe('resolveFromDevice', () => {
    it('returns a fully resolved context with the sealed BMC secret on the happy path', async () => {
      const ctx = await service.resolveFromDevice(makeDevice());

      expect(ctx).toEqual({
        device: expect.objectContaining({ id: DEVICE_UUID }),
        zoneId: 'zone-abc',
        bmcIp: '10.0.0.5',
        bmcSecret: SEALED_BMC,
      });
      expect(deviceSecretService.getCurrentSealedByKind).toHaveBeenCalledWith(
        DEVICE_UUID,
        DeviceSecretPurpose.BMC,
        DeviceSecretKind.USER,
        { type: DeviceSecretActorType.SYSTEM, id: null },
      );
    });

    it('throws when zoneId is missing', async () => {
      const device = makeDevice({ zoneId: null });

      await expect(service.resolveFromDevice(device)).rejects.toThrow(/is not assigned to a zone/);
    });

    it('throws when the device has no management interface IP', async () => {
      const device = makeDevice({ interfaces: [] });

      await expect(service.resolveFromDevice(device)).rejects.toThrow(
        /no IPv4 IPMI address on its management interface/,
      );
    });

    it('throws when the management interface has no valid IPv4', async () => {
      const device = makeDevice({
        interfaces: [ifaceWithIps({ mgmtOnly: true, name: 'IPMI', ips: ['2606:a5c0:0:50:e207:1bff:fefa:4d38/64'] })],
      });

      await expect(service.resolveFromDevice(device)).rejects.toThrow(
        /no IPv4 IPMI address on its management interface/,
      );
    });

    it('fails closed when there is no usable sealed BMC secret (no Vault/sim fallback)', async () => {
      deviceSecretService.getCurrentSealedByKind.mockResolvedValue(null);

      await expect(service.resolveFromDevice(makeDevice())).rejects.toThrow(/no usable BMC credential/);
    });

    it('propagates store read failures unchanged', async () => {
      deviceSecretService.getCurrentSealedByKind.mockRejectedValue(new Error('db unavailable'));

      await expect(service.resolveFromDevice(makeDevice())).rejects.toThrow('db unavailable');
    });

    it('derives the BMC IPv4 from a dual-stack management interface', async () => {
      const device = makeDevice({
        interfaces: [
          ifaceWithIps({
            mgmtOnly: true,
            name: 'IPMI',
            ips: ['2606:a5c0:0:50:e207:1bff:fefa:4d38/64', '172.16.28.70/22'],
          }),
        ],
      });

      const ctx = await service.resolveFromDevice(device);

      expect(ctx.bmcIp).toBe('172.16.28.70');
    });
  });

  describe('resolve', () => {
    it('throws BadRequestException when the device is not found', async () => {
      prisma.device.findUnique.mockResolvedValue(null);

      await expect(service.resolve(DEVICE_UUID)).rejects.toThrow(BadRequestException);
    });

    it('queries Prisma with the canonical select and delegates to resolveFromDevice', async () => {
      prisma.device.findUnique.mockResolvedValue(makeDevice());

      const ctx = await service.resolve(DEVICE_UUID);

      expect(prisma.device.findUnique).toHaveBeenCalledWith({
        where: { id: DEVICE_UUID, deletedAt: null },
        select: expect.objectContaining({
          id: true,
          zoneId: true,
          interfaces: expect.objectContaining({
            include: expect.objectContaining({ ipAddresses: expect.anything() }),
          }),
          supplier: expect.objectContaining({
            select: expect.objectContaining({ id: true }),
          }),
        }),
      });
      expect(ctx.bmcIp).toBe('10.0.0.5');
      expect(ctx.bmcSecret).toEqual(SEALED_BMC);
    });
  });
});
