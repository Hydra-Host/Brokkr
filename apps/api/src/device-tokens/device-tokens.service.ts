import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { API_PREFIX } from '@repo/api-client';
import {
  DeviceTokenAuditEventType,
  DeviceTokenContext,
  DeviceTokenRevocationReason,
  DeviceTokenStatus,
  Prisma,
} from '@repo/database';
import type Redis from 'ioredis';
import { ContextService } from 'src/common/context/context.service';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { ConfigAtomWriter, REDIS_CLIENT, serverToken } from 'src/common/redis';
import { REDIS_KEYS } from 'src/common/redis/redis-keys';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { z } from 'zod';
import { displayIdFromHash, generateDeviceTokenPlaintext, hashDeviceToken } from './device-token.crypto';
import { DeviceTokenRecord } from './device-token.record';
import type {
  BrokkrLiveTokenMaterial,
  DeploymentOsTokenMaterial,
  DeviceIdentityContext,
  IssuedDeviceToken,
} from './device-tokens.types';

const DEFAULT_BROKKR_LIVE_TTL_SECONDS = 24 * 60 * 60;
const SERVER_TOKEN_ATOM_TTL_SECONDS = 24 * 60 * 60;
const LAST_USED_THROTTLE_SECONDS = 60;
const BrokkrLiveServerTokenSchema = z
  .object({
    brokkr_live_token: z.string().min(1),
    endpoint: z.string().min(1),
    exp: z.number().int(),
  })
  .strict();

const verifiedTokenInclude = {
  device: {
    select: {
      id: true,
      supplierId: true,
      zoneId: true,
      systemUuid: true,
    },
  },
} satisfies Prisma.DeviceTokenInclude;

type VerifiedDeviceToken = Prisma.DeviceTokenGetPayload<{ include: typeof verifiedTokenInclude }>;
type DeploymentOsIssueArgs = {
  context: typeof DeviceTokenContext.DEPLOYMENT_OS;
  deviceId: string;
  deploymentId: string | null;
  expiresAt: null;
  issuedBy: string | null;
  revokeExistingReason: DeviceTokenRevocationReason;
};
type BrokkrLiveIssueArgs = {
  context: typeof DeviceTokenContext.BROKKR_LIVE;
  deviceId: string;
  deploymentId: null;
  expiresAt: Date;
  issuedBy: string | null;
  revokeExistingReason: DeviceTokenRevocationReason;
};
type IssueTokenArgs = DeploymentOsIssueArgs | BrokkrLiveIssueArgs;
type RevokedPublishedAuthMaterial = {
  deviceId: string;
  context: DeviceTokenContext;
};

@Injectable()
export class DeviceTokensService {
  private readonly pepper: string;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly configService: ConfigService,
    private readonly contextService: ContextService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly atomWriter: ConfigAtomWriter,
    @Logger(DeviceTokensService.name) private readonly logger: LoggerService,
  ) {
    // Dedicated pepper only — no BETTER_AUTH_SECRET fallback; fail closed at init if unset/blank.
    const pepper = this.configService.getOrThrow<string>('DEVICE_TOKEN_PEPPER');
    if (pepper.trim().length === 0) {
      throw new Error('DEVICE_TOKEN_PEPPER must be a non-empty secret');
    }
    this.pepper = pepper;
  }

  async issueDeploymentOsToken(args: {
    deviceId: string;
    deploymentId?: string | null;
    issuedBy?: string | null;
  }): Promise<IssuedDeviceToken<DeploymentOsTokenMaterial>> {
    return this.issueToken({
      context: DeviceTokenContext.DEPLOYMENT_OS,
      deviceId: args.deviceId,
      deploymentId: args.deploymentId ?? null,
      expiresAt: null,
      issuedBy: args.issuedBy ?? this.currentActor(),
      revokeExistingReason: DeviceTokenRevocationReason.REPROVISION,
    });
  }

  async issueBrokkrLiveToken(args: {
    deviceId: string;
    issuedBy?: string | null;
    revokeExistingReason?: DeviceTokenRevocationReason;
  }): Promise<IssuedDeviceToken<BrokkrLiveTokenMaterial>> {
    return this.issueToken({
      context: DeviceTokenContext.BROKKR_LIVE,
      deviceId: args.deviceId,
      deploymentId: null,
      expiresAt: this.expiresIn(this.getBrokkrLiveTtlSeconds()),
      issuedBy: args.issuedBy ?? this.currentActor(),
      revokeExistingReason: args.revokeExistingReason ?? DeviceTokenRevocationReason.ROTATION,
    });
  }

  async ensureLiveToken(deviceId: string): Promise<IssuedDeviceToken<BrokkrLiveTokenMaterial>> {
    const existing = await DeviceTokenRecord.findActiveByContext({
      deviceId,
      context: DeviceTokenContext.BROKKR_LIVE,
      deploymentId: null,
    });
    if (existing) {
      return {
        tokenId: existing.id,
        displayId: existing.data.displayId,
        plaintext: null,
        material: null,
        reused: true,
      };
    }

    const issued = await this.issueBrokkrLiveToken({ deviceId, issuedBy: 'system' });
    return { ...issued, reused: false };
  }

  async rotateBrokkrLiveToken(deviceId: string): Promise<IssuedDeviceToken<BrokkrLiveTokenMaterial>> {
    const issued = await this.issueBrokkrLiveToken({
      deviceId,
      issuedBy: `device:${deviceId}`,
      revokeExistingReason: DeviceTokenRevocationReason.ROTATION,
    });
    return { ...issued, reused: false };
  }

  async publishBrokkrLiveTokenMaterial(args: {
    deviceId: string;
    material: BrokkrLiveTokenMaterial;
    requestId?: string | null;
  }): Promise<void> {
    const device = await this.prisma.device.findUnique({
      where: { id: args.deviceId },
      select: { zoneId: true },
    });
    if (!device?.zoneId) {
      return;
    }

    await this.atomWriter.writeAtomJson(
      device.zoneId,
      serverToken(args.deviceId),
      args.material,
      BrokkrLiveServerTokenSchema,
      SERVER_TOKEN_ATOM_TTL_SECONDS,
      { request_id: args.requestId ?? null },
    );
  }

  async revokeToken(args: {
    tokenId: string;
    reason: DeviceTokenRevocationReason;
    note?: string | null;
    actor?: string | null;
  }): Promise<void> {
    const revokedMaterials = await this.prisma.$transaction(async (tx) => {
      const record = await DeviceTokenRecord.findTokenById(args.tokenId, { tx });
      if (!record) {
        return [];
      }
      const revokedMaterial = await this.revokeRecord(
        tx,
        record,
        args.reason,
        args.note ?? null,
        args.actor ?? this.currentActor(),
      );
      return revokedMaterial ? [revokedMaterial] : [];
    });
    await this.clearPublishedAuthMaterialForRevokedTokens(revokedMaterials);
  }

  async revokeDeploymentTokensForDevice(
    deviceId: string,
    reason: DeviceTokenRevocationReason,
    note?: string | null,
  ): Promise<void> {
    await this.revokeActiveTokensForDeviceContext(deviceId, DeviceTokenContext.DEPLOYMENT_OS, reason, note);
  }

  async revokeBrokkrLiveTokensForDevice(
    deviceId: string,
    reason: DeviceTokenRevocationReason,
    note?: string | null,
  ): Promise<void> {
    await this.revokeActiveTokensForDeviceContext(deviceId, DeviceTokenContext.BROKKR_LIVE, reason, note);
  }

  private async revokeActiveTokensForDeviceContext(
    deviceId: string,
    context: DeviceTokenContext,
    reason: DeviceTokenRevocationReason,
    note?: string | null,
  ): Promise<void> {
    const revokedMaterials = await this.prisma.$transaction(async (tx) =>
      this.revokeActiveTokensForDeviceContextTx(tx, deviceId, context, reason, note ?? null, this.currentActor()),
    );
    await this.clearPublishedAuthMaterialForRevokedTokens(revokedMaterials);
  }

  async runWithDeploymentTokenRevocation<T>(
    args: {
      deviceId: string;
      reason: DeviceTokenRevocationReason;
      note?: string | null;
    },
    action: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const result = await this.prisma.$transaction(async (tx) => {
      const actionResult = await action(tx);
      const revokedMaterials = await this.revokeActiveTokensForDeviceContextTx(
        tx,
        args.deviceId,
        DeviceTokenContext.DEPLOYMENT_OS,
        args.reason,
        args.note ?? null,
        this.currentActor(),
      );
      return { actionResult, revokedMaterials };
    });
    await this.clearPublishedAuthMaterialForRevokedTokens(result.revokedMaterials);
    return result.actionResult;
  }

  async verifyPlaintextToken(args: {
    plaintext: string;
    allowedContexts: DeviceTokenContext[];
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<DeviceIdentityContext> {
    const tokenHash = hashDeviceToken(args.plaintext, this.pepper);
    const token = await this.prisma.deviceToken.findUnique({
      where: { tokenHash },
      include: verifiedTokenInclude,
    });

    if (!token) {
      throw new UnauthorizedException('Unknown device token');
    }

    if (!args.allowedContexts.includes(token.context)) {
      throw new UnauthorizedException('Device token context is not allowed for this route');
    }

    if (token.status === DeviceTokenStatus.REVOKED) {
      this.logger.warn(`revoked device token used context=${token.context}`);
      await this.createAuditEvent(this.prisma, token.id, DeviceTokenAuditEventType.USED_AFTER_REVOKE, {
        actor: this.currentActor(),
        ip: args.ip ?? null,
        userAgent: args.userAgent ?? null,
      });
      throw new UnauthorizedException('Device token has been revoked');
    }

    if (token.expiresAt && token.expiresAt.getTime() <= Date.now()) {
      this.logger.warn(`expired device token used context=${token.context}`);
      await this.createAuditEvent(this.prisma, token.id, DeviceTokenAuditEventType.USED_AFTER_EXPIRY, {
        actor: this.currentActor(),
        ip: args.ip ?? null,
        userAgent: args.userAgent ?? null,
      });
      throw new UnauthorizedException('Device token has expired');
    }

    await this.throttleLastUsedUpdate(token, args.ip ?? null);

    return this.toDeviceIdentity(token);
  }

  async listForDevice(deviceId: string) {
    return this.prisma.deviceToken.findMany({
      where: { deviceId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        deviceId: true,
        deploymentId: true,
        context: true,
        displayId: true,
        status: true,
        rotationGeneration: true,
        expiresAt: true,
        lastUsedAt: true,
        lastUsedIp: true,
        revokedAt: true,
        revokedReason: true,
        revokedNote: true,
        issuedBy: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  toDeploymentOsMaterial(plaintext: string): DeploymentOsTokenMaterial {
    return {
      deployment_os_token: plaintext,
      endpoint: this.getPhoneHomeEndpoint(),
    };
  }

  toBrokkrLiveMaterial(plaintext: string, expiresAt: Date): BrokkrLiveTokenMaterial {
    return {
      brokkr_live_token: plaintext,
      endpoint: this.getPhoneHomeEndpoint(),
      exp: Math.floor(expiresAt.getTime() / 1000),
    };
  }

  private issueToken(args: DeploymentOsIssueArgs): Promise<IssuedDeviceToken<DeploymentOsTokenMaterial>>;
  private issueToken(args: BrokkrLiveIssueArgs): Promise<IssuedDeviceToken<BrokkrLiveTokenMaterial>>;
  private async issueToken(
    args: IssueTokenArgs,
  ): Promise<IssuedDeviceToken<DeploymentOsTokenMaterial> | IssuedDeviceToken<BrokkrLiveTokenMaterial>> {
    const plaintext = generateDeviceTokenPlaintext();
    const tokenHash = hashDeviceToken(plaintext, this.pepper);
    const displayId = displayIdFromHash(tokenHash);

    const result = await this.prisma.$transaction(async (tx) => {
      const revokedMaterials = await this.revokeActiveTokensForDeviceContextTx(
        tx,
        args.deviceId,
        args.context,
        args.revokeExistingReason,
        null,
        args.issuedBy,
      );

      const record: DeviceTokenRecord = DeviceTokenRecord.build({
        deviceId: args.deviceId,
        deploymentId: args.deploymentId,
        context: args.context,
        tokenHash,
        displayId,
        status: DeviceTokenStatus.ACTIVE,
        expiresAt: args.expiresAt,
        lastUsedAt: null,
        lastUsedIp: null,
        revokedAt: null,
        revokedReason: null,
        revokedNote: null,
        issuedBy: args.issuedBy,
        rotationGeneration: 0,
      });
      await record.save({ tx });
      await this.createAuditEvent(tx, record.id, DeviceTokenAuditEventType.ISSUED, {
        actor: args.issuedBy,
      });

      if (args.context === DeviceTokenContext.DEPLOYMENT_OS) {
        return {
          revokedMaterials,
          issued: {
            tokenId: record.id,
            displayId,
            plaintext,
            material: this.toDeploymentOsMaterial(plaintext),
            reused: false,
          },
        };
      }

      return {
        revokedMaterials,
        issued: {
          tokenId: record.id,
          displayId,
          plaintext,
          material: this.toBrokkrLiveMaterial(plaintext, args.expiresAt),
          reused: false,
        },
      };
    });
    await this.clearPublishedAuthMaterialForRevokedTokens(result.revokedMaterials);
    this.logger.log(`device token issued context=${args.context}`);
    return result.issued;
  }

  private async revokeActiveTokensForDeviceContextTx(
    tx: Prisma.TransactionClient,
    deviceId: string,
    context: DeviceTokenContext,
    reason: DeviceTokenRevocationReason,
    note: string | null,
    actor: string | null,
  ): Promise<RevokedPublishedAuthMaterial[]> {
    const revoked: RevokedPublishedAuthMaterial[] = [];
    const records = await DeviceTokenRecord.findActiveByDeviceAndContext(deviceId, context, { tx });
    for (const record of records) {
      const revokedMaterial = await this.revokeRecord(tx, record, reason, note, actor);
      if (revokedMaterial) {
        revoked.push(revokedMaterial);
      }
    }
    return revoked;
  }

  private async revokeRecord(
    tx: Prisma.TransactionClient,
    record: DeviceTokenRecord,
    reason: DeviceTokenRevocationReason,
    note: string | null,
    actor: string | null,
  ): Promise<RevokedPublishedAuthMaterial | null> {
    const wasActive = record.data.status === DeviceTokenStatus.ACTIVE;
    record.revoke(reason, note);
    await record.save({ tx });
    if (wasActive) {
      const auditEvent =
        reason === DeviceTokenRevocationReason.ROTATION
          ? DeviceTokenAuditEventType.ROTATED
          : DeviceTokenAuditEventType.REVOKED;
      await this.createAuditEvent(tx, record.id, auditEvent, {
        actor,
        payload: { reason, note },
      });
      this.logger.log(`device token revoked context=${record.data.context} reason=${reason}`);
      return { deviceId: record.data.deviceId, context: record.data.context };
    }
    return null;
  }

  private async clearPublishedAuthMaterialForRevokedTokens(tokens: RevokedPublishedAuthMaterial[]): Promise<void> {
    const deviceIds = new Set(
      tokens.filter((token) => token.context === DeviceTokenContext.BROKKR_LIVE).map((token) => token.deviceId),
    );

    await Promise.all([...deviceIds].map((deviceId) => this.clearServerTokenAtom(deviceId)));
  }

  private async clearServerTokenAtom(deviceId: string): Promise<void> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: { zoneId: true },
    });
    if (!device?.zoneId) {
      return;
    }

    await this.atomWriter.delKey(device.zoneId, serverToken(deviceId));
  }

  private async createAuditEvent(
    client: Prisma.TransactionClient | PrismaClient,
    tokenId: string,
    event: DeviceTokenAuditEventType,
    data: {
      actor?: string | null;
      ip?: string | null;
      userAgent?: string | null;
      payload?: Prisma.InputJsonValue;
    },
  ): Promise<void> {
    await client.deviceTokenAuditEvent.create({
      data: {
        tokenId,
        event,
        actor: data.actor ?? null,
        ip: data.ip ?? null,
        userAgent: data.userAgent ?? null,
        ...(data.payload === undefined ? {} : { payload: data.payload }),
      },
    });
  }

  private async throttleLastUsedUpdate(token: VerifiedDeviceToken, ip: string | null): Promise<void> {
    // Last-used tracking is best-effort telemetry — a Redis/DB hiccup here must never deny an
    // otherwise-valid device auth, so swallow and log rather than propagate.
    try {
      const key = REDIS_KEYS.deviceTokenLastUsed(token.id);
      const result = await this.redis.set(key, '1', 'EX', LAST_USED_THROTTLE_SECONDS, 'NX');
      if (result !== 'OK') {
        return;
      }

      const record = DeviceTokenRecord.fromRow(token);
      record.markUsed(ip);
      await record.save();
    } catch (error) {
      this.logger.warn(`device token last-used update failed for ${token.id}: ${getErrorMessage(error)}`);
    }
  }

  private toDeviceIdentity(token: VerifiedDeviceToken): DeviceIdentityContext {
    return {
      deviceId: token.deviceId,
      context: token.context,
      deploymentId: token.deploymentId,
      tokenId: token.id,
      supplierId: token.device.supplierId,
      zoneId: token.device.zoneId,
      systemUuid: token.device.systemUuid,
    };
  }

  private currentActor(): string | null {
    const deviceIdentity = this.contextService.deviceIdentity;
    if (deviceIdentity) {
      return `device:${deviceIdentity.deviceId}`;
    }

    const identity = this.contextService.identity;
    if (!identity) {
      return 'system';
    }

    return this.contextService.userId;
  }

  private getBrokkrLiveTtlSeconds(): number {
    return this.getTtlSeconds('DEVICE_TOKEN_BROKKR_LIVE_TTL_SECONDS', DEFAULT_BROKKR_LIVE_TTL_SECONDS);
  }

  private getTtlSeconds(envName: string, fallback: number): number {
    const configuredValue = this.configService.get<string>(envName);
    if (!configuredValue) {
      return fallback;
    }

    const parsedValue = Number(configuredValue);
    return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : fallback;
  }

  private expiresIn(ttlSeconds: number): Date {
    return new Date(Date.now() + ttlSeconds * 1000);
  }

  private getPhoneHomeEndpoint(): string {
    return `${this.getPhoneHomeBaseUrl()}${API_PREFIX}/bmc/phone-home`;
  }

  private getPhoneHomeBaseUrl(): string {
    const port = this.configService.get<string>('PORT') ?? '3000';
    return (
      this.configService.get<string>('PHONE_HOME_BASE_URL') ??
      this.configService.get<string>('BASE_URL') ??
      `http://localhost:${port}`
    );
  }
}
