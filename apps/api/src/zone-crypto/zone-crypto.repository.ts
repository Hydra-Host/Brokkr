import { Injectable } from '@nestjs/common';
import { DeviceSecretActorType, DeviceSecretAuditEventType, Prisma } from '@repo/database';
import { PrismaClient } from 'src/prisma/prisma.client';

export type ConsumeTokenAndEnrollInput = {
  tokenId: string;
  zoneId: string;
  zonePublicKey: Buffer;
};

@Injectable()
export class ZoneCryptoRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findTokenByHash(tokenHash: string) {
    return this.prisma.zoneRegistrationToken.findUnique({
      where: { tokenHash },
    });
  }

  /** The `consumedAt: null` guard makes a concurrent consume surface as P2025 → TokenConsumeRaceError.
   * Re-enrollment rotates the zone key (generation++), so the tx also invalidates secrets sealed under earlier generations. */
  async consumeTokenAndUpsertEnrollment({ tokenId, zoneId, zonePublicKey }: ConsumeTokenAndEnrollInput) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const now = new Date();
        await tx.zoneRegistrationToken.update({
          where: { id: tokenId, consumedAt: null },
          data: { consumedAt: now, consumedZonePub: zonePublicKey },
        });
        const enrollment = await tx.zoneEnrollment.upsert({
          where: { zoneId },
          update: {
            zonePub: zonePublicKey,
            enrolledAt: now,
            consumedTokenId: tokenId,
            generation: { increment: 1 },
          },
          create: {
            zoneId,
            zonePub: zonePublicKey,
            consumedTokenId: tokenId,
          },
        });
        const stale = await tx.deviceSecret.findMany({
          where: { zoneId, keyGen: { lt: enrollment.generation }, invalidatedAt: null },
          select: { id: true, deviceId: true, purpose: true, kind: true, version: true, keyGen: true },
        });
        if (stale.length > 0) {
          await tx.deviceSecret.updateMany({
            where: { id: { in: stale.map((row) => row.id) } },
            data: { invalidatedAt: now },
          });
          // Invalidations are SECURITY records — one INVALIDATED audit row per secret, same tx.
          await tx.deviceSecretAuditEvent.createMany({
            data: stale.map((row) => ({
              deviceId: row.deviceId,
              event: DeviceSecretAuditEventType.INVALIDATED,
              purpose: row.purpose,
              kind: row.kind,
              version: row.version,
              actorType: DeviceSecretActorType.SYSTEM,
              payload: { cause: 'ZONE_REENROLLED', sealedKeyGen: row.keyGen, currentKeyGen: enrollment.generation },
            })),
          });
        }
        return enrollment;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new TokenConsumeRaceError();
      }
      throw error;
    }
  }

  async findEnrollmentByZoneId(zoneId: string, tx?: Prisma.TransactionClient) {
    return (tx ?? this.prisma).zoneEnrollment.findUnique({
      where: { zoneId },
    });
  }

  // Selects only audit-safe metadata — never tokenHash or consumedZonePub.
  async findRegistrationTokensByZoneId(zoneId: string) {
    return this.prisma.zoneRegistrationToken.findMany({
      where: { zoneId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        zoneId: true,
        expiresAt: true,
        consumedAt: true,
        createdAt: true,
        createdById: true,
        createdBy: { select: { id: true, email: true } },
      },
    });
  }
}

export class TokenConsumeRaceError extends Error {
  constructor() {
    super('zone registration token already consumed by a concurrent request');
    this.name = 'TokenConsumeRaceError';
  }
}
