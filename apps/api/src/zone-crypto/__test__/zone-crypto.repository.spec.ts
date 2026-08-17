import { DeviceSecretActorType, DeviceSecretAuditEventType, DeviceSecretKind, DeviceSecretPurpose, Prisma } from '@repo/database';
import { Buffer } from 'node:buffer';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { PrismaClient } from '../../prisma/prisma.client';
import { ConsumeTokenAndEnrollInput, TokenConsumeRaceError, ZoneCryptoRepository } from '../zone-crypto.repository';

const INPUT: ConsumeTokenAndEnrollInput = {
  tokenId: 'token-row-uuid',
  zoneId: '00000000-0000-4000-8000-000000000001',
  zonePublicKey: Buffer.alloc(32, 0x33),
};

const ENROLLMENT = {
  id: 'enrollment-uuid',
  zoneId: INPUT.zoneId,
  zonePub: INPUT.zonePublicKey,
  generation: 2,
  enrolledAt: new Date(),
  consumedTokenId: INPUT.tokenId,
};

const STALE_SECRET = {
  id: 'secret-row-uuid',
  deviceId: 'device-uuid',
  purpose: DeviceSecretPurpose.BMC,
  kind: DeviceSecretKind.USER,
  version: 1,
  keyGen: 1,
};

function knownRequestError(code: string) {
  return new Prisma.PrismaClientKnownRequestError(`prisma error ${code}`, { code, clientVersion: 'test' });
}

describe('ZoneCryptoRepository', () => {
  let tx: {
    zoneRegistrationToken: { update: Mock };
    zoneEnrollment: { upsert: Mock };
    deviceSecret: { findMany: Mock; updateMany: Mock };
    deviceSecretAuditEvent: { createMany: Mock };
  };
  let prisma: { $transaction: Mock };
  let repo: ZoneCryptoRepository;

  beforeEach(() => {
    tx = {
      zoneRegistrationToken: { update: vi.fn().mockResolvedValue({}) },
      zoneEnrollment: { upsert: vi.fn().mockResolvedValue(ENROLLMENT) },
      deviceSecret: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      deviceSecretAuditEvent: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };
    prisma = { $transaction: vi.fn(async (callback) => callback(tx)) };
    repo = new ZoneCryptoRepository(prisma as unknown as PrismaClient);
  });

  describe('consumeTokenAndUpsertEnrollment', () => {
    it('returns the upserted enrollment and runs the invalidation step on the happy path', async () => {
      await expect(repo.consumeTokenAndUpsertEnrollment(INPUT)).resolves.toBe(ENROLLMENT);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.zoneRegistrationToken.update).toHaveBeenCalledTimes(1);
      expect(tx.zoneEnrollment.upsert).toHaveBeenCalledTimes(1);
      expect(tx.deviceSecret.findMany).toHaveBeenCalledWith({
        where: { zoneId: INPUT.zoneId, keyGen: { lt: ENROLLMENT.generation }, invalidatedAt: null },
        select: { id: true, deviceId: true, purpose: true, kind: true, version: true, keyGen: true },
      });
    });

    it('guards the token update with consumedAt: null so only an unconsumed token is consumed', async () => {
      await repo.consumeTokenAndUpsertEnrollment(INPUT);

      const updateArg = tx.zoneRegistrationToken.update.mock.calls[0]?.[0];
      expect(updateArg.where).toEqual({ id: INPUT.tokenId, consumedAt: null });
      expect(updateArg.data.consumedZonePub).toBe(INPUT.zonePublicKey);
      expect(updateArg.data.consumedAt).toBeInstanceOf(Date);
    });

    it('invalidates earlier-generation secrets and writes one INVALIDATED audit row per secret', async () => {
      tx.deviceSecret.findMany.mockResolvedValue([STALE_SECRET]);

      await repo.consumeTokenAndUpsertEnrollment(INPUT);

      expect(tx.zoneEnrollment.upsert).toHaveBeenCalledWith({
        where: { zoneId: INPUT.zoneId },
        update: {
          zonePub: INPUT.zonePublicKey,
          enrolledAt: expect.any(Date),
          consumedTokenId: INPUT.tokenId,
          generation: { increment: 1 },
        },
        create: {
          zoneId: INPUT.zoneId,
          zonePub: INPUT.zonePublicKey,
          consumedTokenId: INPUT.tokenId,
        },
      });
      expect(tx.deviceSecret.updateMany).toHaveBeenCalledWith({
        where: { id: { in: [STALE_SECRET.id] } },
        data: { invalidatedAt: expect.any(Date) },
      });
      expect(tx.deviceSecretAuditEvent.createMany).toHaveBeenCalledWith({
        data: [
          {
            deviceId: STALE_SECRET.deviceId,
            event: DeviceSecretAuditEventType.INVALIDATED,
            purpose: STALE_SECRET.purpose,
            kind: STALE_SECRET.kind,
            version: STALE_SECRET.version,
            actorType: DeviceSecretActorType.SYSTEM,
            payload: { cause: 'ZONE_REENROLLED', sealedKeyGen: STALE_SECRET.keyGen, currentKeyGen: ENROLLMENT.generation },
          },
        ],
      });
    });

    it('invalidates nothing and writes no audit rows when no earlier-generation secrets exist', async () => {
      tx.zoneEnrollment.upsert.mockResolvedValue({ ...ENROLLMENT, generation: 1 });

      await repo.consumeTokenAndUpsertEnrollment(INPUT);

      expect(tx.deviceSecret.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { zoneId: INPUT.zoneId, keyGen: { lt: 1 }, invalidatedAt: null } }),
      );
      expect(tx.deviceSecret.updateMany).not.toHaveBeenCalled();
      expect(tx.deviceSecretAuditEvent.createMany).not.toHaveBeenCalled();
    });

    it('maps a Prisma P2025 (conditional update matched zero rows) to TokenConsumeRaceError', async () => {
      tx.zoneRegistrationToken.update.mockRejectedValue(knownRequestError('P2025'));

      await expect(repo.consumeTokenAndUpsertEnrollment(INPUT)).rejects.toBeInstanceOf(TokenConsumeRaceError);
      expect(tx.zoneEnrollment.upsert).not.toHaveBeenCalled();
      expect(tx.deviceSecret.updateMany).not.toHaveBeenCalled();
      expect(tx.deviceSecretAuditEvent.createMany).not.toHaveBeenCalled();
    });

    it('propagates a non-P2025 Prisma error unchanged', async () => {
      const err = knownRequestError('P2002');
      tx.zoneEnrollment.upsert.mockRejectedValue(err);

      await expect(repo.consumeTokenAndUpsertEnrollment(INPUT)).rejects.toBe(err);
    });

    it('propagates a non-Prisma error unchanged', async () => {
      const err = new Error('database is on fire');
      prisma.$transaction.mockRejectedValue(err);

      await expect(repo.consumeTokenAndUpsertEnrollment(INPUT)).rejects.toBe(err);
    });
  });
});
