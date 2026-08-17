import { createActiveRecord, type SaveOptions } from '@repo/active-record';
import { DeviceTokenContext, DeviceTokenRevocationReason, DeviceTokenStatus } from '@repo/database';
import { z } from 'zod';

const DeviceTokenPersistenceSchema = z.object({
  id: z.string(),
  deviceId: z.string(),
  deploymentId: z.string().nullable(),
  context: z.nativeEnum(DeviceTokenContext),
  tokenHash: z.string(),
  displayId: z.string(),
  status: z.nativeEnum(DeviceTokenStatus),
  rotationGeneration: z.number().int().nonnegative(),
  expiresAt: z.date().nullable(),
  lastUsedAt: z.date().nullable(),
  lastUsedIp: z.string().nullable(),
  revokedAt: z.date().nullable(),
  revokedReason: z.nativeEnum(DeviceTokenRevocationReason).nullable(),
  revokedNote: z.string().nullable(),
  issuedBy: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export class DeviceTokenRecord extends createActiveRecord(DeviceTokenPersistenceSchema, 'deviceToken') {
  get id(): string {
    return this.data.id;
  }

  static findTokenById(id: string, opts?: Pick<SaveOptions, 'tx'>): Promise<DeviceTokenRecord | null> {
    return this.findOneUnscoped({ where: { id } }, opts);
  }

  static findActiveByHash(tokenHash: string): Promise<DeviceTokenRecord | null> {
    return this.findOneUnscoped({ where: { tokenHash, status: DeviceTokenStatus.ACTIVE } });
  }

  static findActiveByContext(args: {
    deviceId: string;
    context: DeviceTokenContext;
    deploymentId?: string | null;
  }): Promise<DeviceTokenRecord | null> {
    return this.findOneUnscoped({
      where: {
        deviceId: args.deviceId,
        context: args.context,
        deploymentId: args.deploymentId ?? null,
        status: DeviceTokenStatus.ACTIVE,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  static findActiveByDeviceAndContext(
    deviceId: string,
    context: DeviceTokenContext,
    opts?: Pick<SaveOptions, 'tx'>,
  ): Promise<DeviceTokenRecord[]> {
    return this.findManyUnscoped(
      {
        where: {
          deviceId,
          context,
          status: DeviceTokenStatus.ACTIVE,
        },
      },
      opts,
    );
  }

  revoke(reason: DeviceTokenRevocationReason, note?: string | null): this {
    if (this.data.status === DeviceTokenStatus.REVOKED) {
      return this;
    }

    return this.set({
      status: DeviceTokenStatus.REVOKED,
      rotationGeneration: this.data.rotationGeneration + 1,
      revokedAt: new Date(),
      revokedReason: reason,
      revokedNote: note ?? null,
    });
  }

  markUsed(ip?: string | null): this {
    return this.set({
      lastUsedAt: new Date(),
      lastUsedIp: ip ?? null,
    });
  }
}
