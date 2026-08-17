import { ConflictException, Injectable } from '@nestjs/common';
import { Vrf, VrfListQuery } from '@repo/api-client';
import { Prisma } from '@repo/database';
import { ContextService } from 'src/common/context/context.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { BaseIpamRepository } from '../shared/base-ipam.repository';
import { VrfEntity } from './vrf.entity';

@Injectable()
export class VrfRepository extends BaseIpamRepository {
  constructor(prisma: PrismaClient, contextService: ContextService) {
    super(prisma, contextService);
  }

  async listVrfs(query: VrfListQuery): Promise<Vrf[]> {
    const where: Prisma.VrfWhereInput = {
      organizationId: this.contextService.organizationId,
      deletedAt: query.includeArchived ? undefined : null,
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { rd: { contains: query.search, mode: 'insensitive' } },
              { description: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    return this.vrfFindMany({
      where,
      orderBy: [{ name: 'asc' }],
    });
  }

  async restore(id: string): Promise<Vrf> {
    return this.requireVrf(id);
  }

  async ensureValidRd(entity: VrfEntity): Promise<void> {
    if (!entity.shouldValidateRd) {
      return;
    }

    this.validateRd(entity.state.rd);
  }

  async ensureNoConflict(entity: VrfEntity, currentId: string | null): Promise<void> {
    if (!entity.shouldCheckUniqueness) {
      return;
    }
    const uniquenessProbe = entity.uniquenessProbe;
    const currentIdFilter = currentId === null ? Prisma.empty : Prisma.sql`AND v.id <> ${currentId}`;
    const uniquenessPredicates: Prisma.Sql[] = [];

    if (uniquenessProbe.name !== null) {
      uniquenessPredicates.push(Prisma.sql`lower(v.name) = lower(${uniquenessProbe.name})`);
    }
    if (uniquenessProbe.rd !== null) {
      uniquenessPredicates.push(Prisma.sql`v.rd = ${uniquenessProbe.rd}`);
    }
    if (uniquenessPredicates.length === 0) {
      return;
    }

    const conflict = await this.queryRaw<Array<{ id: string }>>`
      SELECT v.id
      FROM "Vrf" v
      WHERE v."organizationId" = ${entity.state.organizationId}
        AND v."deletedAt" IS NULL
        ${currentIdFilter}
        AND (${Prisma.join(uniquenessPredicates, ' OR ')})
      LIMIT 1
    `;
    if (conflict.length > 0) {
      throw new ConflictException('VRF name or RD already exists in this organization');
    }
  }

  async save(entity: VrfEntity, before: Vrf | null): Promise<Vrf> {
    if (entity.isNew) {
      const created = await this.vrfCreate({
        data: {
          organizationId: entity.state.organizationId,
          name: entity.state.name,
          rd: entity.state.rd,
          description: entity.state.description,
        },
      });
      await this.writeAudit('Vrf', created.id, null, this.toJsonObject(created));
      return created;
    }

    if (entity.isArchived) {
      const archived = await this.vrfUpdate({
        where: { id: entity.state.id },
        data: { deletedAt: new Date() },
      });
      await this.writeAudit('Vrf', archived.id, this.toJsonObject(before), this.toJsonObject(archived));
      return archived;
    }

    const updated = await this.vrfUpdate({
      where: { id: entity.state.id },
      data: {
        ...(entity.changes.name ? { name: entity.state.name } : {}),
        ...(entity.changes.rd ? { rd: entity.state.rd } : {}),
        ...(entity.changes.description ? { description: entity.state.description } : {}),
      },
    });
    await this.writeAudit('Vrf', updated.id, this.toJsonObject(before), this.toJsonObject(updated));
    return updated;
  }
}
