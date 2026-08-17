import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SshKeyTypeSchema, type CreateSshKeyRequest } from '@repo/api-client';
import { Prisma } from '@repo/database';
import { paginateArray, type PaginationQuery } from '@repo/database/pagination';
import { normalizeSshKey } from '@repo/utils';
import { ContextService } from 'src/common/context/context.service';
import { PrismaClient } from 'src/prisma/prisma.client';

@Injectable()
export class SshKeysService {
  constructor(
    private readonly prismaService: PrismaClient,
    private readonly contextService: ContextService,
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
    this.contextService.requirePermission('ssh-key', 'create');
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

    return this.prismaService.sshKeys.create({
      data: {
        user: { connect: { id: userId } },
        name: dto.name,
        key: normalizedKey,
        fingerprint,
        dateDeleted: null,
      },
    });
  }

  async deleteSshKey(id: string) {
    this.contextService.requirePermission('ssh-key', 'delete');
    const userId = this.contextService.userId;
    const existing = await this.prismaService.sshKeys.findUnique({
      where: { id, userId, dateDeleted: null },
    });
    if (!existing) {
      throw new NotFoundException('SSH key not found');
    }
    return this.prismaService.sshKeys.update({
      where: { id, userId },
      data: {
        dateDeleted: new Date(),
      },
    });
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
