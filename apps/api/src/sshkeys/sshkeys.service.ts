import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SshKeyTypeSchema, type CreateSshKeyRequest } from '@repo/api-client';
import { Prisma } from '@repo/database';
import { paginateArray, type PaginationQuery } from '@repo/database/pagination';
import { normalizeSshKey } from '@repo/utils';
import { ContextService, type PermissionIntentHandle } from 'src/common/context/context.service';
import { EventLogService } from 'src/event-log/event-log.service';
import { PrismaClient } from 'src/prisma/prisma.client';

@Injectable()
export class SshKeysService {
  constructor(
    private readonly prismaService: PrismaClient,
    private readonly contextService: ContextService,
    private readonly eventLog: EventLogService,
  ) {}

  async getSshKeysByUserId(query: PaginationQuery) {
    this.contextService.requirePermission('ssh-key', 'read');
    const userId = this.contextService.userId;
    const keys = await this.prismaService.sshKeys.findMany({
      where: {
        userId,
        dateDeleted: null,
      },
    });
    return paginateArray(keys, query, { searchableFields: [] });
  }

  async getSshKeyById(id: string) {
    this.contextService.requirePermission('ssh-key', 'read');
    const userId = this.contextService.userId;
    const key = await this.prismaService.sshKeys.findUnique({
      where: {
        id,
        userId,
        dateDeleted: null,
      },
    });
    if (!key) {
      throw new NotFoundException('SSH key not found');
    }
    return key;
  }

  async getSshKeysByOrganizationId(query: PaginationQuery) {
    this.contextService.requirePermission('ssh-key', 'read');
    const organizationId = this.contextService.organizationId;
    const members = await this.prismaService.member.findMany({
      where: {
        organizationId,
        deletedAt: null,
      },
      select: {
        userId: true,
      },
    });
    const userIds = members.map((membership) => membership.userId);
    const keys = await this.prismaService.sshKeys.findMany({
      where: {
        userId: {
          in: userIds,
        },
        dateDeleted: null,
      },
      include: {
        user: {
          select: { firstName: true, lastName: true },
        },
      },
    });
    return paginateArray(keys, query, { searchableFields: [] });
  }

  async getManySshKeys(ids: string[], include?: Prisma.SshKeysInclude) {
    return this.prismaService.sshKeys.findMany({
      where: {
        id: {
          in: ids,
        },
        dateDeleted: null,
      },
      include,
    });
  }

  async getManySshKeysByUserIds(userIds: string[]) {
    return this.prismaService.sshKeys.findMany({
      where: {
        userId: {
          in: userIds,
        },
        dateDeleted: null,
      },
    });
  }

  async createSshKey(dto: CreateSshKeyRequest) {
    const handle = this.contextService.requirePermission('ssh-key', 'create');
    const userId = this.contextService.userId;
    const normalizedKey = normalizeSshKey(dto.key);
    const fingerprint = await this.getFingerprint(normalizedKey);
    const existingKey = await this.prismaService.sshKeys.findFirst({
      where: {
        fingerprint,
        userId,
        dateDeleted: null,
      },
    });

    if (existingKey) {
      throw new BadRequestException('SSH key already exists');
    }

    const created = await this.prismaService.$transaction(async (tx) => {
      const key = await tx.sshKeys.create({
        data: {
          user: { connect: { id: userId } },
          name: dto.name,
          key: normalizedKey,
          fingerprint,
          dateDeleted: null,
        },
      });
      await this.emitKeyEvent(tx, {
        action: 'created',
        actionKey: 'ssh-key.created',
        targetId: key.id,
        targetLabel: key.name,
      });
      return key;
    });

    this.supersede(handle);
    return created;
  }

  async deleteSshKey(id: string) {
    const handle = this.contextService.requirePermission('ssh-key', 'delete');
    const userId = this.contextService.userId;
    const existing = await this.prismaService.sshKeys.findUnique({
      where: { id, userId, dateDeleted: null },
    });
    if (!existing) {
      throw new NotFoundException('SSH key not found');
    }
    const deleted = await this.prismaService.$transaction(async (tx) => {
      const key = await tx.sshKeys.update({
        where: { id, userId },
        data: {
          dateDeleted: new Date(),
        },
      });
      await this.emitKeyEvent(tx, {
        action: 'deleted',
        actionKey: 'ssh-key.deleted',
        targetId: key.id,
        targetLabel: existing.name,
      });
      return key;
    });

    this.supersede(handle);
    return deleted;
  }

  /** Never carries key material: the body is a credential and the fingerprint identifies it just as well. */
  private emitKeyEvent(
    tx: Prisma.TransactionClient,
    event: { action: string; actionKey: string; targetId: string; targetLabel: string },
  ): Promise<void> {
    return this.eventLog.recordInTransaction(tx, {
      organizationId: this.contextService.organizationId,
      tier: 'EVIDENCE',
      durability: 'ATOMIC',
      resource: 'ssh-key',
      action: event.action,
      actionKey: event.actionKey,
      ...this.contextService.actorFields(),
      ...this.contextService.requestFields(),
      targetId: event.targetId,
      targetLabel: event.targetLabel,
      outcome: 'SUCCEEDED',
      requestId: this.contextService.requestId ?? null,
    });
  }

  /** Called after the transaction resolves: a rollback leaves the handle pending so tier 2 records the failure. */
  private supersede(handle: PermissionIntentHandle | undefined): void {
    if (handle) {
      this.contextService.finalizeIntents([handle]);
    }
  }

  async getFingerprint(publicKey: string) {
    const normalizedKey = normalizeSshKey(publicKey);

    if (normalizedKey.includes('\n')) {
      throw new BadRequestException('Newlines are not permitted within the key data');
    }

    const parsed = normalizedKey.split(' ');

    if (parsed.length < 2) {
      throw new BadRequestException('Incomplete or improperly formatted key');
    }

    for (let index = 0; index < parsed.length; index++) {
      const result = SshKeyTypeSchema.safeParse(parsed[index]);
      if (result.success) {
        const key = parsed[index + 1];
        if (!key) {
          throw new BadRequestException('Incomplete or improperly formatted key');
        }
        const decodedKey = Buffer.from(key, 'base64');

        const sha256HashBuffer = await crypto.subtle.digest('SHA-256', decodedKey);

        const hashArray = new Uint8Array(sha256HashBuffer);
        const base64Hash = Buffer.from(hashArray).toString('base64').replace(/=+$/, '');

        return `SHA256:${base64Hash}`;
      }
    }

    throw new BadRequestException('Cannot determine key type');
  }
}
