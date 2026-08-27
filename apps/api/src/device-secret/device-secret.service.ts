import { Injectable } from '@nestjs/common';
import {
  DeviceSecretActorType,
  DeviceSecretAuditEventType,
  DeviceSecretKind,
  DeviceSecretPurpose,
  Prisma,
} from '@repo/database';
import { Buffer } from 'node:buffer';
import { Logger } from 'src/common/decorators/logger.decorator';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { ZoneCryptoConfig } from 'src/zone-crypto/zone-crypto.config';
import { ZoneCryptoRepository } from 'src/zone-crypto/zone-crypto.repository';
import { DeviceSecretActor, DeviceSecretAuditService } from './device-secret-audit.service';
import { sealDeviceSecret } from './device-secret.crypto';

export interface SealedSecretEnvelope {
  zoneId: string;
  zoneKeyId: string;
  deviceId: string;
  purpose: DeviceSecretPurpose;
  kind: DeviceSecretKind;
  keyGen: number;
  ephPub: string;
  ciphertext: string;
  tag: string;
}

export interface DeviceSecretVersionMeta {
  version: number;
  purpose: DeviceSecretPurpose;
  kind: DeviceSecretKind;
  createdAt: Date;
  createdById: string;
  invalidatedAt: Date | null;
}

export class SecretStorageUnavailableError extends Error {}

// Seals on write and can never open (only the zone's bridge can). Append-only versions; current = MAX(version) not invalidated.
@Injectable()
export class DeviceSecretService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly zoneCryptoConfig: ZoneCryptoConfig,
    private readonly zoneCryptoRepository: ZoneCryptoRepository,
    private readonly audit: DeviceSecretAuditService,
    @Logger(DeviceSecretService.name) private readonly logger: LoggerService,
  ) {}

  private requireHubPrivateKey(): Buffer {
    const hubPriv = this.zoneCryptoConfig.privateKey;
    if (hubPriv === null) {
      throw new SecretStorageUnavailableError('hub crypto dormant (BROKKR_HUB_PRIVATE_KEY not set)');
    }
    return hubPriv;
  }

  // Serialised per (device, purpose) via advisory lock so versions are contiguous; `skipIfLivePresent` reuses a live current-generation same-kind version (a stale-key version doesn't count, so a re-keyed zone still gets a fresh seal).
  async write(
    deviceId: string,
    purpose: DeviceSecretPurpose,
    kind: DeviceSecretKind,
    plaintext: Record<string, string>,
    createdById: string,
    opts?: { skipIfLivePresent?: boolean; tx?: Prisma.TransactionClient },
  ): Promise<DeviceSecretVersionMeta> {
    const hubPriv = this.requireHubPrivateKey();
    const zoneId = await this.zoneIdFor(deviceId, opts?.tx);
    if (zoneId === null) {
      throw new SecretStorageUnavailableError(`device ${deviceId} has no zone`);
    }
    const enrollment = await this.zoneCryptoRepository.findEnrollmentByZoneId(zoneId, opts?.tx);
    if (!enrollment) {
      throw new SecretStorageUnavailableError(`zone ${zoneId} is not enrolled; cannot seal a secret to it`);
    }

    const seal = async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`device_secret:${deviceId}:${purpose}`}))`;
      // Re-read enrollment under the lock — the pre-lock read is only a fast-fail. A zone re-key
      // committing between that read and here would otherwise seal to the retired key/generation.
      const lockedEnrollment = await this.zoneCryptoRepository.findEnrollmentByZoneId(zoneId, tx);
      if (!lockedEnrollment) {
        throw new SecretStorageUnavailableError(`zone ${zoneId} is not enrolled; cannot seal a secret to it`);
      }
      if (opts?.skipIfLivePresent) {
        const live = await tx.deviceSecret.findFirst({
          where: { deviceId, purpose, kind, invalidatedAt: null, keyGen: lockedEnrollment.generation },
          orderBy: { version: 'desc' },
          select: { version: true, purpose: true, kind: true, createdAt: true, createdById: true, invalidatedAt: true },
        });
        if (live) return { row: live, reused: true };
      }
      const sealed = sealDeviceSecret(
        hubPriv,
        Buffer.from(lockedEnrollment.zonePub),
        Buffer.from(JSON.stringify(plaintext), 'utf8'),
        {
          zoneId,
          zoneKeyId: lockedEnrollment.id,
          deviceId,
          purpose,
          kind,
          keyGen: lockedEnrollment.generation,
        },
      );
      const latest = await tx.deviceSecret.findFirst({
        where: { deviceId, purpose },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const nextVersion = (latest?.version ?? 0) + 1;
      const row = await tx.deviceSecret.create({
        data: {
          deviceId,
          purpose,
          kind,
          version: nextVersion,
          ephPub: sealed.ephPub,
          ciphertext: sealed.ciphertext,
          tag: sealed.tag,
          zoneId,
          zoneKeyId: lockedEnrollment.id,
          keyGen: lockedEnrollment.generation,
          createdById,
        },
        select: { version: true, purpose: true, kind: true, createdAt: true, createdById: true, invalidatedAt: true },
      });
      await this.audit.record(
        {
          deviceId,
          event: latest ? DeviceSecretAuditEventType.UPDATE : DeviceSecretAuditEventType.WRITE,
          purpose,
          kind,
          version: nextVersion,
          actor: { type: DeviceSecretActorType.USER, id: createdById },
          payload: { zoneId, keyGen: lockedEnrollment.generation },
        },
        tx,
      );
      return { row, reused: false };
    };

    const result = opts?.tx ? await seal(opts.tx) : await this.prisma.$transaction(seal);

    this.logger.log(
      `${result.reused ? 'Reused live' : 'Sealed'} ${kind}/${purpose} secret v${result.row.version} for device ` +
        `${deviceId} to zone ${zoneId} (gen ${enrollment.generation})`,
    );
    return result.row;
  }

  async sealEphemeral(
    zoneId: string,
    deviceId: string,
    purpose: DeviceSecretPurpose,
    kind: DeviceSecretKind,
    plaintext: Record<string, string>,
    actor: DeviceSecretActor,
  ): Promise<SealedSecretEnvelope> {
    const hubPriv = this.requireHubPrivateKey();
    const enrollment = await this.zoneCryptoRepository.findEnrollmentByZoneId(zoneId);
    if (!enrollment) {
      throw new SecretStorageUnavailableError(`zone ${zoneId} is not enrolled; cannot seal a secret to it`);
    }
    const sealed = sealDeviceSecret(
      hubPriv,
      Buffer.from(enrollment.zonePub),
      Buffer.from(JSON.stringify(plaintext), 'utf8'),
      { zoneId, zoneKeyId: enrollment.id, deviceId, purpose, kind, keyGen: enrollment.generation },
    );

    // SYSTEM dispatch is log-only (material is sealed to the zone key; the insert is hot-path DB
    // load). Other actors keep the HARD, not fail-soft record — a failed insert aborts the seal.
    if (actor.type !== DeviceSecretActorType.SYSTEM) {
      await this.prisma.$transaction((tx) =>
        this.audit.record(
          {
            deviceId: null,
            zoneId,
            event: DeviceSecretAuditEventType.DISPATCH,
            purpose,
            kind,
            actor,
            requestId: deviceId,
            payload: { ephemeral: true, planId: deviceId, keyGen: enrollment.generation },
          },
          tx,
        ),
      );
    }

    this.logger.log(
      `Sealed ephemeral ${kind}/${purpose} secret for zone ${zoneId} (gen ${enrollment.generation}) under plan ${deviceId}`,
    );

    return this.toEnvelope({
      zoneId,
      zoneKeyId: enrollment.id,
      deviceId,
      purpose,
      kind,
      keyGen: enrollment.generation,
      ephPub: sealed.ephPub,
      ciphertext: sealed.ciphertext,
      tag: sealed.tag,
    });
  }

  // Proactively invalidates stale-key versions first, so the list reflects a re-keyed zone immediately.
  async listVersions(deviceId: string, purpose?: DeviceSecretPurpose): Promise<DeviceSecretVersionMeta[]> {
    await this.invalidateStaleVersions(deviceId);
    return this.prisma.deviceSecret.findMany({
      where: { deviceId, ...(purpose ? { purpose } : {}) },
      orderBy: [{ purpose: 'asc' }, { version: 'desc' }],
      select: { version: true, purpose: true, kind: true, createdAt: true, createdById: true, invalidatedAt: true },
    });
  }

  // Rows are marked, never deleted; pass `tx` so invalidation + audit commit atomically with the caller.
  async invalidateAll(
    deviceId: string,
    actor: DeviceSecretActor,
    cause: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = tx ?? this.prisma;
    // Snapshot the target ids BEFORE updating, then update by id — a timestamp-equality re-read would
    // wrongly sweep in rows a concurrent invalidation stamped with the same millisecond.
    const invalidated = await client.deviceSecret.findMany({
      where: { deviceId, invalidatedAt: null },
      select: { id: true, purpose: true, kind: true, version: true },
    });
    if (invalidated.length === 0) return 0;
    await client.deviceSecret.updateMany({
      where: { id: { in: invalidated.map((row) => row.id) } },
      data: { invalidatedAt: new Date() },
    });
    for (const row of invalidated) {
      await this.audit.record(
        {
          deviceId,
          event: DeviceSecretAuditEventType.INVALIDATED,
          purpose: row.purpose,
          kind: row.kind,
          version: row.version,
          actor,
          payload: { cause },
        },
        tx,
      );
    }
    this.logger.log(`Invalidated ${invalidated.length} secret version(s) for device ${deviceId} (${cause})`);
    return invalidated.length;
  }

  private async invalidateStaleVersions(deviceId: string): Promise<void> {
    const live = await this.prisma.deviceSecret.findMany({
      where: { deviceId, invalidatedAt: null },
      select: { id: true, zoneId: true, keyGen: true, purpose: true, kind: true, version: true },
    });
    if (live.length === 0) return;
    const genByZone = new Map<string, number | null>();
    for (const row of live) {
      if (!genByZone.has(row.zoneId)) {
        const enrollment = await this.zoneCryptoRepository.findEnrollmentByZoneId(row.zoneId);
        genByZone.set(row.zoneId, enrollment?.generation ?? null);
      }
    }
    const stale = live.filter((row) => genByZone.get(row.zoneId) !== row.keyGen);
    if (stale.length > 0) {
      // Atomic: never leave a row invalidated without its INVALIDATED audit event (a crash between
      // the updateMany and the audit loop would otherwise drop the trail).
      await this.prisma.$transaction(async (tx) => {
        await tx.deviceSecret.updateMany({
          where: { id: { in: stale.map((row) => row.id) } },
          data: { invalidatedAt: new Date() },
        });
        for (const row of stale) {
          await this.recordStaleInvalidation(deviceId, row, genByZone.get(row.zoneId) ?? null, tx);
        }
      });
      this.logger.warn(`Invalidated ${stale.length} stale-key secret(s) for device ${deviceId} (zone re-keyed)`);
    }
  }

  private async recordStaleInvalidation(
    deviceId: string,
    row: { purpose: DeviceSecretPurpose; kind: DeviceSecretKind; version: number; keyGen: number },
    currentGen: number | null,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    await this.audit.record(
      {
        deviceId,
        event: DeviceSecretAuditEventType.INVALIDATED,
        purpose: row.purpose,
        kind: row.kind,
        version: row.version,
        actor: { type: DeviceSecretActorType.SYSTEM, id: null },
        payload: { cause: 'STALE_ZONE_KEY', sealedKeyGen: row.keyGen, currentKeyGen: currentGen },
      },
      tx,
    );
  }

  async getCurrentSealedByKind(
    deviceId: string,
    purpose: DeviceSecretPurpose,
    kind: DeviceSecretKind,
    actor: DeviceSecretActor,
  ): Promise<SealedSecretEnvelope | null> {
    const row = await this.prisma.deviceSecret.findFirst({
      where: { deviceId, purpose, kind, invalidatedAt: null },
      orderBy: { version: 'desc' },
    });
    if (!row) return null;

    const enrollment = await this.zoneCryptoRepository.findEnrollmentByZoneId(row.zoneId);
    if (!enrollment || enrollment.generation !== row.keyGen) {
      await this.prisma.deviceSecret.update({ where: { id: row.id }, data: { invalidatedAt: new Date() } });
      this.logger.warn(
        `Device ${deviceId} ${purpose}/${kind} secret v${row.version} sealed to stale zone-key gen ${row.keyGen} ` +
          `(current ${enrollment?.generation ?? 'none'}); marked invalidated — needs re-entry`,
      );
      await this.recordStaleInvalidation(deviceId, row, enrollment?.generation ?? null);
      return null;
    }

    if (actor.type === DeviceSecretActorType.SYSTEM) {
      this.logger.log(
        `Dispatched sealed ${row.kind}/${purpose} secret v${row.version} for device ${deviceId} ` +
          `to zone ${row.zoneId} (gen ${row.keyGen})`,
      );
    } else {
      await this.audit.record({
        deviceId,
        event: DeviceSecretAuditEventType.DISPATCH,
        purpose,
        kind: row.kind,
        version: row.version,
        actor,
        payload: { zoneId: row.zoneId, keyGen: row.keyGen },
      });
    }
    return this.toEnvelope(row);
  }

  async getRevealableVersion(
    deviceId: string,
    purpose: DeviceSecretPurpose,
    version: number,
  ): Promise<SealedSecretEnvelope | 'missing' | 'invalidated'> {
    const row = await this.prisma.deviceSecret.findUnique({
      where: { deviceId_purpose_version: { deviceId, purpose, version } },
    });
    if (!row) return 'missing';
    if (row.invalidatedAt !== null) return 'invalidated';
    const enrollment = await this.zoneCryptoRepository.findEnrollmentByZoneId(row.zoneId);
    if (!enrollment || enrollment.generation !== row.keyGen) {
      await this.prisma.deviceSecret.update({ where: { id: row.id }, data: { invalidatedAt: new Date() } });
      this.logger.warn(
        `Device ${deviceId} ${purpose} secret v${row.version} sealed to stale zone-key gen ${row.keyGen} ` +
          `(current ${enrollment?.generation ?? 'none'}); marked invalidated — needs re-entry`,
      );
      await this.recordStaleInvalidation(deviceId, row, enrollment?.generation ?? null);
      return 'invalidated';
    }
    return this.toEnvelope(row);
  }

  private toEnvelope(row: {
    zoneId: string;
    zoneKeyId: string;
    deviceId: string;
    purpose: DeviceSecretPurpose;
    kind: DeviceSecretKind;
    keyGen: number;
    ephPub: Uint8Array;
    ciphertext: Uint8Array;
    tag: Uint8Array;
  }): SealedSecretEnvelope {
    return {
      zoneId: row.zoneId,
      zoneKeyId: row.zoneKeyId,
      deviceId: row.deviceId,
      purpose: row.purpose,
      kind: row.kind,
      keyGen: row.keyGen,
      ephPub: Buffer.from(row.ephPub).toString('base64'),
      ciphertext: Buffer.from(row.ciphertext).toString('base64'),
      tag: Buffer.from(row.tag).toString('base64'),
    };
  }

  private async zoneIdFor(
    deviceId: string,
    client: PrismaClient | Prisma.TransactionClient = this.prisma,
  ): Promise<string | null> {
    const device = await client.device.findUnique({ where: { id: deviceId }, select: { zoneId: true } });
    return device?.zoneId ?? null;
  }
}
