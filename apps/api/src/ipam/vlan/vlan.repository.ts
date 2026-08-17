import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Vlan, VLAN_VID_MAX, VLAN_VID_MIN, VlanListQuery } from '@repo/api-client';
import { Prisma } from '@repo/database';
import { ContextService } from 'src/common/context/context.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { BaseIpamRepository, type IpamQueryExecutor } from '../shared/base-ipam.repository';
import { VlanRow } from '../shared/ipam.types';
import { VlanEntity } from './vlan.entity';

@Injectable()
export class VlanRepository extends BaseIpamRepository {
  constructor(prisma: PrismaClient, contextService: ContextService) {
    super(prisma, contextService);
  }

  async listVlans(query: VlanListQuery): Promise<Vlan[]> {
    const clauses: Prisma.Sql[] = [Prisma.sql`v."organizationId" = ${this.contextService.organizationId}`];
    if (!query.includeArchived) {
      clauses.push(Prisma.sql`v."deletedAt" IS NULL`);
    }
    if (query.vrfId) {
      clauses.push(Prisma.sql`v."vrfId" = ${query.vrfId}`);
    }
    if (query.status) {
      clauses.push(Prisma.sql`v.status = ${query.status}::"VlanStatus"`);
    }
    if (query.search) {
      clauses.push(
        Prisma.sql`(v.name ILIKE ${`%${query.search}%`} OR COALESCE(v.description, '') ILIKE ${`%${query.search}%`})`,
      );
    }

    const rows = await this.queryRaw<VlanRow[]>`
      SELECT
        v.id,
        v.name,
        v.vid,
        v.description,
        v.status,
        v."organizationId",
        v."vrfId",
        v."createdAt",
        v."updatedAt",
        v."deletedAt"
      FROM "Vlan" v
      WHERE ${Prisma.join(clauses, ' AND ')}
      ORDER BY v.vid ASC, v.name ASC
    `;
    return rows.map((row) => this.toVlan(row));
  }

  async restore(id: string): Promise<Vlan> {
    return this.requireVlan(id);
  }

  async createWithConflictGuard(entity: VlanEntity): Promise<Vlan> {
    try {
      return await this.transaction(async (tx) => {
        await this.lockIpamScope(tx, 'vlan', entity.state.organizationId, entity.state.vrfId);
        await this.ensureNoConflict(entity, null, tx);
        return this.save(entity, null, tx);
      });
    } catch (error) {
      this.throwConflictOnConstraintError(error, 'VLAN with this VID or name already exists in this scope');
    }
  }

  async updateWithConflictGuard(entity: VlanEntity, before: Vlan): Promise<Vlan> {
    try {
      return await this.transaction(async (tx) => {
        await this.lockIpamScope(tx, 'vlan', entity.state.organizationId, entity.state.vrfId);
        await this.ensureNoConflict(entity, entity.state.id, tx);
        return this.save(entity, before, tx);
      });
    } catch (error) {
      this.throwConflictOnConstraintError(error, 'VLAN with this VID or name already exists in this scope');
    }
  }

  async save(entity: VlanEntity, before: Vlan | null, executor: IpamQueryExecutor = this): Promise<Vlan> {
    if (entity.isNew) {
      const rows = await executor.queryRaw<VlanRow[]>`
        INSERT INTO "Vlan" (
          id,
          name,
          vid,
          description,
          status,
          "organizationId",
          "vrfId",
          "createdAt",
          "updatedAt"
        )
        VALUES (
          gen_random_uuid(),
          ${entity.state.name},
          ${entity.state.vid},
          ${entity.state.description},
          ${entity.state.status}::"VlanStatus",
          ${entity.state.organizationId},
          ${entity.state.vrfId},
          now(),
          now()
        )
        RETURNING
          id,
          name,
          vid,
          description,
          status,
          "organizationId",
          "vrfId",
          "createdAt",
          "updatedAt",
          "deletedAt"
      `;
      const created = rows[0];
      await this.writeAudit('Vlan', created.id, null, this.toJsonObject(created), executor);
      return this.toVlan(created);
    }

    if (entity.isArchived) {
      const rows = await executor.queryRaw<VlanRow[]>`
        UPDATE "Vlan" v
        SET "deletedAt" = now(), "updatedAt" = now()
        WHERE v.id = ${entity.state.id}
          AND v."organizationId" = ${this.contextService.organizationId}
          AND v."deletedAt" IS NULL
        RETURNING
          id,
          name,
          vid,
          description,
          status,
          "organizationId",
          "vrfId",
          "createdAt",
          "updatedAt",
          "deletedAt"
      `;
      if (rows.length === 0) {
        throw new NotFoundException('VLAN not found');
      }
      const archived = rows[0];
      await this.writeAudit('Vlan', archived.id, this.toJsonObject(before), this.toJsonObject(archived), executor);
      return this.toVlan(archived);
    }

    const rows = await executor.queryRaw<VlanRow[]>`
      UPDATE "Vlan" v
      SET
        name = CASE WHEN ${entity.changes.name} THEN ${entity.state.name} ELSE v.name END,
        vid = CASE WHEN ${entity.changes.vid} THEN ${entity.state.vid} ELSE v.vid END,
        description = CASE
          WHEN ${entity.changes.description}
          THEN ${entity.state.description}
          ELSE v.description
        END,
        status = CASE
          WHEN ${entity.changes.status}
          THEN ${entity.state.status}::"VlanStatus"
          ELSE v.status
        END,
        "vrfId" = CASE
          WHEN ${entity.changes.vrfId}
          THEN ${entity.state.vrfId}
          ELSE v."vrfId"
        END,
        "updatedAt" = now()
      WHERE v.id = ${entity.state.id}
        AND v."organizationId" = ${this.contextService.organizationId}
        AND v."deletedAt" IS NULL
      RETURNING
        id,
        name,
        vid,
        description,
        status,
        "organizationId",
        "vrfId",
        "createdAt",
        "updatedAt",
        "deletedAt"
    `;
    if (rows.length === 0) {
      throw new NotFoundException('VLAN not found');
    }
    const updated = rows[0];
    await this.writeAudit('Vlan', updated.id, this.toJsonObject(before), this.toJsonObject(updated), executor);
    return this.toVlan(updated);
  }

  ensureValidVid(vid: number): void {
    if (vid < VLAN_VID_MIN || vid > VLAN_VID_MAX) {
      throw new BadRequestException(`VLAN ID must be between ${VLAN_VID_MIN} and ${VLAN_VID_MAX} (got ${vid})`);
    }
  }

  async ensureVrf(entity: VlanEntity): Promise<void> {
    if (!entity.shouldValidateVrf) {
      return;
    }

    await this.requireVrf(entity.state.vrfId);
  }

  async ensureNoConflict(
    entity: VlanEntity,
    currentId: string | null,
    executor: IpamQueryExecutor = this,
  ): Promise<void> {
    if (!entity.shouldCheckUniqueness) {
      return;
    }
    const uniquenessProbe = entity.uniquenessProbe;
    const currentIdFilter = currentId === null ? Prisma.empty : Prisma.sql`AND v.id <> ${currentId}`;
    const uniquenessPredicates: Prisma.Sql[] = [];

    if (uniquenessProbe.vid !== null) {
      uniquenessPredicates.push(Prisma.sql`v.vid = ${uniquenessProbe.vid}`);
    }
    if (uniquenessProbe.name !== null) {
      uniquenessPredicates.push(Prisma.sql`lower(v.name) = lower(${uniquenessProbe.name})`);
    }
    if (uniquenessPredicates.length === 0) {
      return;
    }

    const conflict = await executor.queryRaw<Array<{ id: string }>>`
      SELECT v.id
      FROM "Vlan" v
      WHERE v."organizationId" = ${entity.state.organizationId}
        AND v."deletedAt" IS NULL
        ${currentIdFilter}
        AND (v."vrfId" IS NOT DISTINCT FROM ${entity.state.vrfId})
        AND (${Prisma.join(uniquenessPredicates, ' OR ')})
      LIMIT 1
    `;
    if (conflict.length > 0) {
      throw new ConflictException('VLAN with this VID or name already exists in this scope');
    }
  }
}
