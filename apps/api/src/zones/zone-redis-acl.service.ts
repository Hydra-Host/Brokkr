import {
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { ContextService } from 'src/common/context/context.service';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { REDIS_CLIENT } from 'src/common/redis';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import {
  generateZoneAclPassword,
  REDIS_ACL_MANAGEMENT_FLAG,
  sha256Hex,
  zoneAclLockKey,
  zoneAclSetUserArgs,
  zoneAclUsername,
  zoneIdFromAclUsername,
} from './zone-redis-acl.util';
import { ZoneRecord } from './zone.record';

export interface ZoneRedisAclCredential {
  username: string;
  /** Plaintext — surfaced to the caller exactly once, never persisted or logged. */
  password: string;
  passwordHash: string;
}

@Injectable()
export class ZoneRedisAclService implements OnApplicationBootstrap {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly configService: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Logger(ZoneRedisAclService.name) private readonly logger: LoggerService,
    private readonly contextService: ContextService,
  ) {}

  get enabled(): boolean {
    return this.configService.get(REDIS_ACL_MANAGEMENT_FLAG) === 'true';
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) return;
    this.logger.log('Redis ACL management enabled; reconciling zone ACL users');
    try {
      await this.reconcileAll();
    } catch (error) {
      this.logger.error(`Redis ACL startup reconcile failed: ${getErrorMessage(error)}`);
    }
  }

  async provisionUser(zoneId: string): Promise<ZoneRedisAclCredential> {
    const password = generateZoneAclPassword();
    const passwordHash = sha256Hex(password);
    await this.setUser(zoneId, passwordHash);
    return { username: zoneAclUsername(zoneId), password, passwordHash };
  }

  async ensureUser(zoneId: string, passwordHash: string): Promise<void> {
    await this.setUser(zoneId, passwordHash);
  }

  async deleteUser(zoneId: string): Promise<void> {
    const username = zoneAclUsername(zoneId);
    try {
      await this.redis.call('ACL', 'DELUSER', username);
    } catch (error) {
      throw new Error(`Failed to delete Redis ACL user ${username}: ${getErrorMessage(error)}`, { cause: error });
    }
    this.logger.log(`Deleted Redis ACL user ${username}`);
  }

  async rotateCredential(zoneId: string): Promise<ZoneRedisAclCredential> {
    this.contextService.requirePermission('zone', 'update');

    if (!this.enabled) {
      throw new ServiceUnavailableException('Redis ACL management is not enabled on this hub');
    }

    const zone = await ZoneRecord.findActiveById(zoneId);
    if (!zone) {
      throw new NotFoundException('Zone not found');
    }

    const previous = await this.prisma.zoneRedisCredential.findUnique({ where: { zoneId } });
    let credential: ZoneRedisAclCredential;
    try {
      // SETUSER + upsert must run INSIDE the per-zone advisory lock (deleteZone holds the SAME lock) — otherwise two rotates could land SETUSERs and DB commits in opposite orders, stranding a stale hash.
      credential = await this.prisma.$transaction(async (tx) => {
        const lockKey = zoneAclLockKey(zoneId);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

        // Re-verifies liveness only — a delete committed after the early check must abort before touching Redis.
        const current = await tx.zone.findUnique({ where: { id: zoneId }, select: { deletedAt: true } });
        if (!current || current.deletedAt !== null) {
          throw new NotFoundException('Zone not found');
        }

        const provisioned = await this.provisionUser(zoneId);
        await tx.zoneRedisCredential.upsert({
          where: { zoneId },
          create: { zoneId, passwordHash: provisioned.passwordHash },
          update: { passwordHash: provisioned.passwordHash, rotatedAt: new Date() },
        });
        return provisioned;
      });
    } catch (error) {
      await this.convergeUserToDb(zoneId, previous?.passwordHash ?? null, 'rotate');
      throw error;
    }
    const audit = this.contextService.buildAuditPayload();
    this.logger.log(
      `Rotated Redis ACL credential for zone ${zoneId} | actor=${audit.triggeredByEmail} (${audit.triggeredBy})`,
    );
    return credential;
  }

  /** Converges to the CURRENT DB row, not the snapshot (a concurrent rotate may have advanced it; snapshot is only the re-read fallback); never throws — the original error must surface. */
  async convergeUserToDb(zoneId: string, fallbackHash: string | null, operation: string): Promise<void> {
    let hash = fallbackHash;
    try {
      const row = await this.prisma.zoneRedisCredential.findUnique({ where: { zoneId } });
      hash = row?.passwordHash ?? null;
    } catch (readError) {
      this.logger.warn(
        `Could not re-read Redis credential for zone ${zoneId} during ${operation} rollback; falling back to the pre-${operation} snapshot: ${getErrorMessage(readError)}`,
      );
    }

    try {
      if (hash !== null) {
        await this.ensureUser(zoneId, hash);
      } else {
        await this.deleteUser(zoneId);
      }
      this.logger.warn(`Converged Redis ACL state for zone ${zoneId} after failed ${operation}`);
    } catch (rollbackError) {
      this.logger.error(
        `Failed to restore Redis ACL state for zone ${zoneId} after failed ${operation}: ${getErrorMessage(rollbackError)}`,
      );
    }
  }

  async reconcileAll(): Promise<void> {
    const zones = await this.prisma.zone.findMany({
      where: { deletedAt: null },
      select: { id: true, redisCredential: { select: { passwordHash: true } } },
    });

    for (const zone of zones) {
      try {
        if (zone.redisCredential) {
          await this.ensureUser(zone.id, zone.redisCredential.passwordHash);
        } else {
          const passwordHash = sha256Hex(generateZoneAclPassword());
          await this.prisma.zoneRedisCredential.create({
            data: { zoneId: zone.id, passwordHash },
          });
          await this.ensureUser(zone.id, passwordHash);
          this.logger.warn(
            `Zone ${zone.id} had no Redis credential; provisioned a locked ACL user — rotate to obtain a usable password`,
          );
        }
      } catch (error) {
        this.logger.error(`Failed to reconcile Redis ACL user for zone ${zone.id}: ${getErrorMessage(error)}`);
      }
    }

    await this.removeOrphanedUsers(new Set(zones.map((z) => z.id)));
  }

  private async removeOrphanedUsers(activeZoneIds: Set<string>): Promise<void> {
    let usernames: string[];
    try {
      const reply = await this.redis.call('ACL', 'USERS');
      usernames = (Array.isArray(reply) ? reply : []).filter((u): u is string => typeof u === 'string');
    } catch (error) {
      this.logger.error(`Failed to list Redis ACL users during reconcile: ${getErrorMessage(error)}`);
      return;
    }

    for (const username of usernames) {
      const zoneId = zoneIdFromAclUsername(username);
      if (zoneId === null || activeZoneIds.has(zoneId)) continue;
      try {
        await this.deleteUser(zoneId);
        this.logger.log(`Removed orphaned Redis ACL user ${username} (zone deleted or unknown)`);
      } catch (error) {
        this.logger.error(`Failed to remove orphaned Redis ACL user ${username}: ${getErrorMessage(error)}`);
      }
    }
  }

  private async setUser(zoneId: string, passwordHash: string): Promise<void> {
    const args = zoneAclSetUserArgs(zoneId, passwordHash);
    try {
      await this.redis.call('ACL', ...args);
    } catch (error) {
      throw new Error(`Failed to apply Redis ACL user for zone ${zoneId}: ${getErrorMessage(error)}`, { cause: error });
    }
    this.logger.log(`Applied Redis ACL user ${zoneAclUsername(zoneId)}`);
  }
}
