import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { contract } from '@repo/api-client';
import {
  DeviceSecretActorType,
  DeviceSecretAuditEventType,
  DeviceSecretKind,
  DeviceSecretPurpose,
  Prisma,
} from '@repo/database';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { AuthType } from 'src/auth/identity-context';
import { BridgeQueueService } from 'src/brokkr-bridge/queue/bridge-queue.service';
import { ContextService } from 'src/common/context/context.service';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { REDIS_CLIENT } from 'src/common/redis';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { ZoneCryptoConfig } from 'src/zone-crypto/zone-crypto.config';
import { z } from 'zod';
import { DeviceSecretAtomPublisher } from './device-secret-atom-publisher.service';
import { DeviceSecretAuditService } from './device-secret-audit.service';
import { DeviceSecretService, SecretStorageUnavailableError } from './device-secret.service';
import { decryptStash, deriveStashKey } from './reveal-stash.crypto';

const revealStashSchema = z.record(z.string());

type VersionMeta = z.infer<(typeof contract.listDeviceSecretVersions.responses)[200]>[number];
type RevealStatus = z.infer<(typeof contract.getDeviceSecretRevealStatus.responses)[200]>;

export function revealStashKey(deviceId: string, requestId: string): string {
  return `device-secret:reveal:${deviceId}:${requestId}`;
}
export function revealStashAad(deviceId: string, requestId: string): string {
  return `${deviceId}:${requestId}`;
}
export const REVEAL_STASH_TTL_SECONDS = 30;

@Injectable()
export class DeviceSecretAccessService {
  constructor(
    private readonly deviceSecretService: DeviceSecretService,
    private readonly contextService: ContextService,
    private readonly prisma: PrismaClient,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(forwardRef(() => BridgeQueueService)) private readonly bridgeQueue: BridgeQueueService,
    private readonly zoneCryptoConfig: ZoneCryptoConfig,
    private readonly audit: DeviceSecretAuditService,
    private readonly atomPublisher: DeviceSecretAtomPublisher,
    @Logger(DeviceSecretAccessService.name) private readonly logger: LoggerService,
  ) {}

  async listVersions(deviceId: string): Promise<VersionMeta[]> {
    this.assertInteractiveAdmin('Listing device secrets');
    await this.assertDeviceExists(deviceId);
    const rows = await this.deviceSecretService.listVersions(deviceId);
    const emails = await this.resolveEmails(rows.map((r) => r.createdById));
    return rows.map((r) => ({
      version: r.version,
      purpose: r.purpose,
      kind: r.kind,
      createdAt: r.createdAt.toISOString(),
      createdBy: emails.get(r.createdById) ?? r.createdById,
      invalidatedAt: r.invalidatedAt ? r.invalidatedAt.toISOString() : null,
    }));
  }

  async write(
    deviceId: string,
    input: { purpose: DeviceSecretPurpose; kind: DeviceSecretKind; secret: Record<string, string> },
  ): Promise<VersionMeta> {
    this.assertInteractiveAdmin('Writing a device secret');
    await this.assertDeviceExists(deviceId);
    const userId = this.contextService.userId;
    let meta;
    try {
      meta = await this.deviceSecretService.write(deviceId, input.purpose, input.kind, input.secret, userId);
    } catch (error) {
      if (error instanceof SecretStorageUnavailableError) {
        throw new ConflictException(`Cannot store secret: ${error.message}`);
      }
      throw error;
    }
    const audit = this.contextService.buildAuditPayload();
    this.logger.log(
      `Device secret WRITTEN: device=${deviceId} ${input.purpose}/${input.kind} v${meta.version} ` +
        `actor=${audit.triggeredByEmail} (${audit.triggeredBy})`,
    );

    // The secret is already committed, so a Redis/DB failure here must degrade to a warning rather
    // than a 500 that would read as a failed write and invite a retry.
    let unrefreshed: string | null = null;
    try {
      const published = await this.atomPublisher.publishCurrent(deviceId, input.purpose, input.kind, {
        type: DeviceSecretActorType.USER,
        id: userId,
      });
      if (!published.written) unrefreshed = published.reason ?? 'unknown';
    } catch (error) {
      unrefreshed = getErrorMessage(error);
    }
    if (unrefreshed !== null) {
      this.logger.warn(
        `Device secret v${meta.version} written but its Redis atom was not refreshed ` +
          `(${unrefreshed}): device=${deviceId} ${input.purpose}/${input.kind} — ` +
          `the bridge will keep using the previous credential until the atom updates`,
      );
    }

    return {
      version: meta.version,
      purpose: meta.purpose,
      kind: meta.kind,
      createdAt: meta.createdAt.toISOString(),
      createdBy: audit.triggeredByEmail,
      invalidatedAt: null,
    };
  }

  async requestReveal(
    deviceId: string,
    purpose: DeviceSecretPurpose,
    version: number,
  ): Promise<{ requestId: string; status: 'pending' }> {
    this.assertInteractiveAdmin('Revealing a device secret');
    // Reject up front when hub crypto is dormant: the stash needs the hub key, so the reveal could never complete.
    if (this.zoneCryptoConfig.privateKey === null) {
      throw new ConflictException('Hub crypto is dormant (BROKKR_HUB_PRIVATE_KEY not set); cannot reveal a secret');
    }
    await this.assertDeviceExists(deviceId);
    const sealed = await this.deviceSecretService.getRevealableVersion(deviceId, purpose, version);
    if (sealed === 'missing') {
      throw new NotFoundException(`No ${purpose} secret version ${version} for device ${deviceId}`);
    }
    if (sealed === 'invalidated') {
      throw new ConflictException(
        `${purpose} secret version ${version} was sealed to a superseded zone key and cannot be revealed`,
      );
    }
    const requestId = randomUUID();
    const userId = this.contextService.userId;
    const audit = this.contextService.buildAuditPayload();
    this.logger.log(
      `Device secret REVEAL requested: device=${deviceId} ${purpose} v${version} request=${requestId} ` +
        `actor=${audit.triggeredByEmail} (${audit.triggeredBy}); sealed blob keyGen=${sealed.keyGen}`,
    );
    // Hard, not fail-soft: a reveal produces plaintext, so it must never proceed without a durable
    // request record. Mirrors sealEphemeral — a failed insert propagates and skips the enqueue.
    await this.prisma.$transaction((tx) =>
      this.audit.record(
        {
          deviceId,
          event: DeviceSecretAuditEventType.REVEAL_REQUESTED,
          purpose,
          kind: sealed.kind,
          version,
          requestId,
          actor: { type: DeviceSecretActorType.USER, id: userId },
          payload: { zoneId: sealed.zoneId, keyGen: sealed.keyGen },
        },
        tx,
      ),
    );
    await this.bridgeQueue.enqueueSagaJob(
      sealed.zoneId,
      'secret_reveal',
      requestId,
      { request_id: requestId, device_id: deviceId, secret: sealed },
      deviceId,
    );
    return { requestId, status: 'pending' };
  }

  async getRevealStatus(deviceId: string, requestId: string): Promise<RevealStatus> {
    this.assertInteractiveAdmin('Reading a device secret reveal');
    const hubPriv = this.zoneCryptoConfig.privateKey;
    if (hubPriv === null) {
      this.logger.error(`Cannot open reveal stash for ${requestId}: hub crypto dormant`);
      return { status: 'unavailable', secret: null };
    }
    const blob = await this.redis.getdel(revealStashKey(deviceId, requestId));
    if (blob === null) {
      return { status: 'pending', secret: null };
    }
    let secret: Record<string, string>;
    try {
      const plaintext = decryptStash(deriveStashKey(hubPriv), blob, revealStashAad(deviceId, requestId));
      secret = revealStashSchema.parse(JSON.parse(plaintext.toString('utf8')));
    } catch (error) {
      this.logger.error(`Unreadable reveal stash for ${deviceId}/${requestId}: ${getErrorMessage(error)}`);
      // getdel already consumed the stash; close out the REVEAL_REQUESTED so it isn't left orphaned.
      await this.recordRevealDelivered(deviceId, requestId, { stashUnreadable: true }).catch((auditError: unknown) =>
        this.logger.error(
          `Failed to record stash-unreadable REVEAL_DELIVERED for ${deviceId}/${requestId}: ${getErrorMessage(auditError)}`,
        ),
      );
      return { status: 'unavailable', secret: null };
    }
    // The stash is already getdel'd and successfully decrypted — audit correlation is bookkeeping
    // and must never drop the delivered secret, so it fails soft.
    await this.recordRevealDelivered(deviceId, requestId).catch((error: unknown) =>
      this.logger.error(`Failed to record REVEAL_DELIVERED for ${deviceId}/${requestId}: ${getErrorMessage(error)}`),
    );
    return { status: 'ready', secret };
  }

  private async recordRevealDelivered(
    deviceId: string,
    requestId: string,
    extraPayload?: Prisma.InputJsonObject,
  ): Promise<void> {
    const requested = await this.prisma.deviceSecretAuditEvent.findFirst({
      where: { deviceId, requestId, event: DeviceSecretAuditEventType.REVEAL_REQUESTED },
      orderBy: { createdAt: 'desc' },
      select: { purpose: true, kind: true, version: true },
    });
    if (!requested) {
      await this.audit.record({
        deviceId,
        event: DeviceSecretAuditEventType.REVEAL_DELIVERED,
        requestId,
        actor: { type: DeviceSecretActorType.USER, id: this.contextService.userId },
        payload: { correlationMissing: true, ...extraPayload },
      });
      return;
    }
    await this.audit.record({
      deviceId,
      event: DeviceSecretAuditEventType.REVEAL_DELIVERED,
      purpose: requested.purpose,
      kind: requested.kind,
      version: requested.version,
      requestId,
      actor: { type: DeviceSecretActorType.USER, id: this.contextService.userId },
      ...(extraPayload ? { payload: extraPayload } : {}),
    });
  }

  private async assertDeviceExists(deviceId: string): Promise<void> {
    const device = await this.prisma.device.findUnique({ where: { id: deviceId }, select: { id: true } });
    if (!device) throw new NotFoundException('Device not found');
  }

  private async resolveEmails(userIds: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) return new Map();
    const users = await this.prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, email: true } });
    return new Map(users.map((u) => [u.id, u.email]));
  }

  private assertInteractiveAdmin(operation: string): void {
    const identity = this.contextService.identity;
    if (identity === undefined) {
      throw new ForbiddenException(`${operation} requires an authenticated admin session`);
    }
    if (identity.authType === AuthType.ApiKey) {
      throw new ForbiddenException(`${operation} requires an interactive admin session`);
    }
    this.contextService.requirePermission('device-secret', 'access');
  }
}
