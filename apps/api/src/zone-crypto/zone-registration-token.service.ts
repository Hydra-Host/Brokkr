import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { Prisma } from '@repo/database';
import { createHash, randomBytes } from 'node:crypto';
import { AuthType } from 'src/auth/identity-context';
import { ContextService } from 'src/common/context/context.service';
import { Logger } from 'src/common/decorators/logger.decorator';
import { isLocalSimulationEnabled } from 'src/common/local-simulation';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import type { z } from 'zod';
import { ZoneCryptoRepository } from './zone-crypto.repository';

const TOKEN_BYTE_LENGTH = 32;

const TOKEN_TTL_HOURS = 24;

type MintResponse = z.infer<(typeof contract.mintZoneRegistrationToken.responses)[201]>;
type ListResponse = z.infer<(typeof contract.listZoneRegistrationTokens.responses)[200]>;

@Injectable()
export class ZoneRegistrationTokenService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly repository: ZoneCryptoRepository,
    private readonly contextService: ContextService,
    @Logger(ZoneRegistrationTokenService.name) private readonly logger: LoggerService,
  ) {}

  /** Audit-safe metadata only — never the raw token, its hash, or consumed zone_pub. */
  async listRegistrationTokens(zoneId: string): Promise<ListResponse> {
    this.assertInteractiveAdmin('Listing registration tokens');

    const zone = await this.prisma.zone.findUnique({ where: { id: zoneId } });
    if (!zone || zone.deletedAt) {
      throw new NotFoundException('Zone not found');
    }

    const now = Date.now();
    const rows = await this.repository.findRegistrationTokensByZoneId(zoneId);

    return rows.map((row) => ({
      id: row.id,
      zoneId: row.zoneId,
      mintedById: row.createdById,
      mintedByEmail: row.createdBy?.email ?? null,
      mintedAt: row.createdAt,
      expiresAt: row.expiresAt,
      consumedAt: row.consumedAt,
      status: row.consumedAt !== null ? 'consumed' : row.expiresAt.getTime() <= now ? 'expired' : 'unused',
    }));
  }

  async mintRegistrationToken(zoneId: string): Promise<MintResponse> {
    this.assertInteractiveAdmin('Token minting');
    return this.mintCore(zoneId, this.contextService.userId);
  }

  /** SECURITY GATE: the only mint path skipping assertInteractiveAdmin — fails closed on isLocalSimulationEnabled() before any DB work and has no controller route; `createdById` must be a real User.id. */
  async mintRegistrationTokenForSim(zoneId: string, createdById: string): Promise<MintResponse> {
    if (!isLocalSimulationEnabled()) {
      throw new ForbiddenException(
        'Non-interactive registration-token mint is only available when LOCAL_SIMULATION_ENABLED=true in a permitted environment',
      );
    }
    this.logger.warn(`Sim non-interactive mint for zone ${zoneId} (createdById=${createdById}); sim-gated path`);

    await this.prisma.zoneRegistrationToken.updateMany({
      where: { zoneId, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { expiresAt: new Date() },
    });

    return this.mintCore(zoneId, createdById);
  }

  private async mintCore(zoneId: string, createdById: string): Promise<MintResponse> {
    const zone = await this.prisma.zone.findUnique({ where: { id: zoneId } });
    if (!zone || zone.deletedAt) {
      throw new NotFoundException('Zone not found');
    }

    const rawTokenBytes = randomBytes(TOKEN_BYTE_LENGTH);
    const token = rawTokenBytes.toString('base64url');
    const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
    const expiresAt = new Date(Date.now() + TOKEN_TTL_HOURS * 60 * 60 * 1000);

    const lockKey = `zone_mint:${zoneId}`;
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

      const existing = await tx.zoneRegistrationToken.findFirst({
        where: { zoneId, consumedAt: null, expiresAt: { gt: new Date() } },
        select: { id: true },
      });
      if (existing) {
        throw new ConflictException({
          message:
            'An unused registration token already exists for this zone. Invalidate it via DELETE before minting a new one.',
          existingTokenId: existing.id,
        });
      }

      return tx.zoneRegistrationToken.create({
        data: { tokenHash, zoneId, expiresAt, createdById },
      });
    });

    // Never log the raw token or its hash; the row id is the audit key.
    const audit = this.contextService.buildAuditPayload();
    this.logger.log(
      `Minted ZoneRegistrationToken ${row.id} for zone ${zoneId} | actor=${audit.triggeredByEmail} (${audit.triggeredBy})`,
    );

    rawTokenBytes.fill(0);

    return {
      token,
      tokenId: row.id,
      zoneId: row.zoneId,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      createdById: row.createdById,
    };
  }

  async invalidateRegistrationToken(zoneId: string, tokenId: string): Promise<void> {
    this.assertInteractiveAdmin('Token invalidation');

    const audit = this.contextService.buildAuditPayload();

    const row = await this.prisma.zoneRegistrationToken.findUnique({ where: { id: tokenId } });
    if (!row || row.zoneId !== zoneId) {
      throw new NotFoundException('Registration token not found for this zone');
    }
    if (row.consumedAt !== null) {
      throw new ConflictException(
        'Registration token has already been consumed by a bridge; the resulting enrollment cannot be undone via this endpoint',
      );
    }

    if (row.expiresAt <= new Date()) {
      this.logger.log(
        `Invalidate ZoneRegistrationToken ${tokenId} for zone ${zoneId} | actor=${audit.triggeredByEmail} (${audit.triggeredBy}) | already expired (no-op)`,
      );
      return;
    }

    // The `consumedAt: null` guard closes the invalidate-vs-bridge-consume race — a mid-flight consume surfaces as P2025 → the same 409.
    try {
      await this.prisma.zoneRegistrationToken.update({
        where: { id: tokenId, consumedAt: null },
        data: { expiresAt: new Date() },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new ConflictException(
          'Registration token was consumed by a bridge between the read and the invalidate; the resulting enrollment cannot be undone via this endpoint',
        );
      }
      throw error;
    }

    this.logger.log(
      `Invalidated ZoneRegistrationToken ${tokenId} for zone ${zoneId} | actor=${audit.triggeredByEmail} (${audit.triggeredBy})`,
    );
  }

  private assertInteractiveAdmin(operation: string): void {
    // Explicit reject: an unauthenticated call must not reach the permission check at all.
    const identity = this.contextService.identity;
    if (identity === undefined) {
      throw new ForbiddenException(`${operation} requires an authenticated admin session`);
    }
    if (identity.authType === AuthType.ApiKey) {
      throw new ForbiddenException(`${operation} requires an interactive admin session`);
    }
    this.contextService.requirePermission('zone', 'register');
  }
}
