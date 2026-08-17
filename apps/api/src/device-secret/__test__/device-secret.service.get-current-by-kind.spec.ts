import { Test, TestingModule } from '@nestjs/testing';
import { DeviceSecretActorType, DeviceSecretAuditEventType, DeviceSecretKind, DeviceSecretPurpose } from '@repo/database';
import { Buffer } from 'node:buffer';
import { PrismaClient } from 'src/prisma/prisma.client';
import { ZoneCryptoConfig } from 'src/zone-crypto/zone-crypto.config';
import { ZoneCryptoRepository } from 'src/zone-crypto/zone-crypto.repository';
import { Mock, vi } from 'vitest';
import { DeviceSecretAuditService } from '../device-secret-audit.service';
import { DeviceSecretService } from '../device-secret.service';

const DEVICE_UUID = '11111111-2222-3333-4444-555555555555';
const ZONE_UUID = '22222222-3333-4444-5555-666666666666';
const KEY_UUID = '33333333-4444-5555-6666-777777777777';
const BRIDGE_ACTOR = { type: DeviceSecretActorType.BRIDGE, id: 'bridge-a' };

function rowFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    deviceId: DEVICE_UUID,
    purpose: DeviceSecretPurpose.BMC,
    kind: DeviceSecretKind.USER,
    version: 2,
    zoneId: ZONE_UUID,
    zoneKeyId: KEY_UUID,
    keyGen: 5,
    invalidatedAt: null,
    ephPub: new Uint8Array(Buffer.from('eph')),
    ciphertext: new Uint8Array(Buffer.from('ct')),
    tag: new Uint8Array(Buffer.from('tag')),
    ...overrides,
  };
}

describe('DeviceSecretService.getCurrentSealedByKind', () => {
  let service: DeviceSecretService;
  let findFirst: Mock;
  let update: Mock;
  let findEnrollmentByZoneId: Mock;
  let auditRecord: Mock;

  beforeEach(async () => {
    findFirst = vi.fn();
    update = vi.fn().mockResolvedValue(undefined);
    findEnrollmentByZoneId = vi.fn();
    auditRecord = vi.fn().mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeviceSecretService,
        { provide: PrismaClient, useValue: { deviceSecret: { findFirst, update } } },
        { provide: ZoneCryptoConfig, useValue: { isAvailable: true, privateKey: Buffer.alloc(32) } },
        { provide: ZoneCryptoRepository, useValue: { findEnrollmentByZoneId } },
        { provide: DeviceSecretAuditService, useValue: { record: auditRecord } },
        {
          provide: `LoggerService${DeviceSecretService.name}`,
          useValue: {
            log: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
            verbose: vi.fn(),
            setContext: vi.fn().mockReturnThis(),
          },
        },
      ],
    }).compile();

    service = module.get(DeviceSecretService);
  });

  afterEach(() => vi.clearAllMocks());

  it('scopes the lookup to the narrowest (device, purpose, kind) live row, newest version first', async () => {
    findFirst.mockResolvedValueOnce(rowFixture());
    findEnrollmentByZoneId.mockResolvedValueOnce({ id: KEY_UUID, generation: 5, zonePub: new Uint8Array() });

    const result = await service.getCurrentSealedByKind(
      DEVICE_UUID,
      DeviceSecretPurpose.BMC,
      DeviceSecretKind.USER,
      BRIDGE_ACTOR,
    );

    expect(findFirst).toHaveBeenCalledWith({
      where: { deviceId: DEVICE_UUID, purpose: DeviceSecretPurpose.BMC, kind: DeviceSecretKind.USER, invalidatedAt: null },
      orderBy: { version: 'desc' },
    });
    expect(result).not.toBeNull();
    expect(result?.kind).toBe(DeviceSecretKind.USER);
    expect(result?.ciphertext).toBe(Buffer.from('ct').toString('base64'));
    expect(update).not.toHaveBeenCalled();
  });

  it('emits a DISPATCH audit event (with the bridge actor) on a successful resolve', async () => {
    findFirst.mockResolvedValueOnce(rowFixture());
    findEnrollmentByZoneId.mockResolvedValueOnce({ id: KEY_UUID, generation: 5, zonePub: new Uint8Array() });

    await service.getCurrentSealedByKind(DEVICE_UUID, DeviceSecretPurpose.BMC, DeviceSecretKind.USER, BRIDGE_ACTOR);

    expect(auditRecord).toHaveBeenCalledOnce();
    expect(auditRecord.mock.calls[0][0]).toMatchObject({
      deviceId: DEVICE_UUID,
      event: DeviceSecretAuditEventType.DISPATCH,
      purpose: DeviceSecretPurpose.BMC,
      kind: DeviceSecretKind.USER,
      version: 2,
      actor: BRIDGE_ACTOR,
      payload: { zoneId: ZONE_UUID, keyGen: 5 },
    });
  });

  it('returns null when there is no live version (none written / all invalidated)', async () => {
    findFirst.mockResolvedValueOnce(null);
    const result = await service.getCurrentSealedByKind(
      DEVICE_UUID,
      DeviceSecretPurpose.BMC,
      DeviceSecretKind.USER,
      BRIDGE_ACTOR,
    );
    expect(result).toBeNull();
    expect(findEnrollmentByZoneId).not.toHaveBeenCalled();
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it('invalidates, records a SYSTEM INVALIDATED event, and returns null on a superseded zone-key generation', async () => {
    findFirst.mockResolvedValueOnce(rowFixture({ keyGen: 4 }));
    findEnrollmentByZoneId.mockResolvedValueOnce({ id: KEY_UUID, generation: 5, zonePub: new Uint8Array() });

    const result = await service.getCurrentSealedByKind(
      DEVICE_UUID,
      DeviceSecretPurpose.BMC,
      DeviceSecretKind.USER,
      BRIDGE_ACTOR,
    );

    expect(result).toBeNull();
    expect(update).toHaveBeenCalledWith({ where: { id: 'row-1' }, data: { invalidatedAt: expect.any(Date) } });
    expect(auditRecord).toHaveBeenCalledOnce();
    expect(auditRecord.mock.calls[0][0]).toMatchObject({
      event: DeviceSecretAuditEventType.INVALIDATED,
      actor: { type: DeviceSecretActorType.SYSTEM, id: null },
      payload: { cause: 'STALE_ZONE_KEY', sealedKeyGen: 4, currentKeyGen: 5 },
    });
  });

  it('invalidates, records INVALIDATED, and returns null when the zone has no current enrollment', async () => {
    findFirst.mockResolvedValueOnce(rowFixture());
    findEnrollmentByZoneId.mockResolvedValueOnce(null);

    const result = await service.getCurrentSealedByKind(
      DEVICE_UUID,
      DeviceSecretPurpose.BMC,
      DeviceSecretKind.USER,
      BRIDGE_ACTOR,
    );

    expect(result).toBeNull();
    expect(update).toHaveBeenCalledWith({ where: { id: 'row-1' }, data: { invalidatedAt: expect.any(Date) } });
    expect(auditRecord).toHaveBeenCalledOnce();
    expect(auditRecord.mock.calls[0][0]).toMatchObject({
      event: DeviceSecretAuditEventType.INVALIDATED,
      payload: { cause: 'STALE_ZONE_KEY', sealedKeyGen: 5, currentKeyGen: null },
    });
  });
});
