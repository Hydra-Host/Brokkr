import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { IpAddress, IpAddressListQuery } from '@repo/api-client';
import { Prisma } from '@repo/database';
import { ContextService } from 'src/common/context/context.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { BaseIpamRepository, type IpamQueryExecutor } from '../shared/base-ipam.repository';
import { IpAddressRow } from '../shared/ipam.types';
import { IpAddressEntity } from './ip-address.entity';

@Injectable()
export class IpAddressRepository extends BaseIpamRepository {
  constructor(prisma: PrismaClient, contextService: ContextService) {
    super(prisma, contextService);
  }

  // The interface's parent device must be owned or supplied by the caller's org (assertParentDeviceOwnedOrSupplied's scope) — else a caller could pin their IP onto a foreign interface and leak it into that device's rendered netplan/UFW.
  async assertInterfaceInOrg(interfaceId: string): Promise<void> {
    const org = this.contextService.organizationId;
    const iface = await this.prisma.interface.findUnique({
      where: {
        id: interfaceId,
        deletedAt: null,
        device: { deletedAt: null, supplierId: org },
      },
      select: { id: true },
    });
    if (!iface) {
      throw new NotFoundException('Interface not found');
    }
  }

  async ensureNotInUseAsVrrpVip(ipId: string, executor: IpamQueryExecutor = this): Promise<void> {
    const rows = await executor.queryRaw<Array<{ id: string }>>`
      SELECT p.id
      FROM "Prefix" p
      WHERE p."vrrpVipId" = ${ipId}
        AND p."organizationId" = ${this.contextService.organizationId}
        AND p."deletedAt" IS NULL
      LIMIT 1
    `;
    if (rows.length > 0) {
      throw new ConflictException('IP address is in use as a prefix VRRP VIP; clear the VIP first');
    }
  }

  async listIpAddresses(query: IpAddressListQuery): Promise<IpAddress[]> {
    const clauses: Prisma.Sql[] = [Prisma.sql`ip."organizationId" = ${this.contextService.organizationId}`];
    if (!query.includeArchived) {
      clauses.push(Prisma.sql`ip."deletedAt" IS NULL`);
    }
    if (query.vrfId) {
      clauses.push(Prisma.sql`ip."vrfId" = ${query.vrfId}`);
    }
    if (query.status) {
      clauses.push(Prisma.sql`ip.status = ${query.status}::"IpStatus"`);
    }
    if (query.assignedObjectType) {
      clauses.push(Prisma.sql`ip."assignedObjectType" = ${query.assignedObjectType}::"AssignedObjectType"`);
    }
    if (query.assignedObjectId) {
      clauses.push(Prisma.sql`ip."assignedObjectId" = ${query.assignedObjectId}`);
    }
    if (query.search) {
      clauses.push(
        Prisma.sql`(ip.address::text ILIKE ${`%${query.search}%`} OR COALESCE(ip."dnsName", '') ILIKE ${`%${query.search}%`})`,
      );
    }
    if (query.prefix) {
      const normalizedPrefix = await this.normalizeCidr(query.prefix);
      clauses.push(Prisma.sql`ip.address <<= ${normalizedPrefix}::cidr`);
    }

    const limitClause = query.pageSize ? Prisma.sql`LIMIT ${query.pageSize}` : Prisma.empty;

    const rows = await this.queryRaw<IpAddressRow[]>`
      SELECT
        ip.id,
        ip.address::text AS address,
        ip.status,
        ip."dnsName",
        ip."organizationId",
        ip."vrfId",
        ip."assignedObjectType",
        ip."assignedObjectId",
        ip."interfaceId",
        ip."createdAt",
        ip."updatedAt",
        ip."deletedAt"
      FROM "IpAddress" ip
      WHERE ${Prisma.join(clauses, ' AND ')}
      ORDER BY ip.address::text ASC
      ${limitClause}
    `;
    return rows.map((row) => this.toIpAddress(row));
  }

  async normalizeAddress(input: string): Promise<string> {
    const normalized = await this.normalizeInet(input);
    if (normalized.endsWith('/0')) {
      throw new BadRequestException('IP address cannot have a /0 mask');
    }
    return normalized;
  }

  async restore(id: string): Promise<IpAddress> {
    return this.requireIpAddress(id);
  }

  async createWithConflictGuard(entity: IpAddressEntity): Promise<IpAddress> {
    try {
      return await this.transaction(async (tx) => {
        await this.lockIpamScope(tx, 'ip-address', entity.state.organizationId, entity.state.vrfId);
        await this.ensureNoAddressConflict(entity, null, tx);
        return this.save(entity, null, tx);
      });
    } catch (error) {
      this.throwConflictOnConstraintError(error, 'IP address already exists in this VRF');
    }
  }

  async updateWithConflictGuard(entity: IpAddressEntity, before: IpAddress, vrfChanged = false): Promise<IpAddress> {
    try {
      return await this.transaction(async (tx) => {
        await this.lockIpamScope(tx, 'ip-address', entity.state.organizationId, entity.state.vrfId);
        // Re-assert VIP-unbound under the shared IP lock whenever this write could violate it — VRF moved or a non-null interfaceId assign (derived from the entity, no redundant caller flag).
        // The service's pre-flight is a lock-free fast fail; this in-tx check catches a VIP-assign committed after it (TOCTOU close).
        const interfaceAssigned = entity.changes.interfaceId && entity.state.interfaceId !== null;
        if (vrfChanged || interfaceAssigned) {
          await this.lockIpamIp(tx, entity.state.organizationId, entity.state.id);
          await this.ensureNotInUseAsVrrpVip(entity.state.id, tx);
        }
        await this.ensureNoAddressConflict(entity, entity.state.id, tx);
        return this.save(entity, before, tx);
      });
    } catch (error) {
      this.throwConflictOnConstraintError(error, 'IP address already exists in this VRF');
    }
  }

  // In-tx re-check under the shared IP lock closes the TOCTOU race with a concurrent setPrefixVrrpVip committing after the service's pre-flight check.
  async archiveUnderLock(entity: IpAddressEntity, before: IpAddress): Promise<IpAddress> {
    return this.transaction(async (tx) => {
      await this.lockIpamIp(tx, entity.state.organizationId, entity.state.id);
      await this.ensureNotInUseAsVrrpVip(entity.state.id, tx);
      return this.save(entity, before, tx);
    });
  }

  async save(
    entity: IpAddressEntity,
    before: IpAddress | null,
    executor: IpamQueryExecutor = this,
  ): Promise<IpAddress> {
    if (entity.isNew) {
      const createdRows = await executor.queryRaw<IpAddressRow[]>`
        INSERT INTO "IpAddress" (
          id,
          address,
          status,
          "dnsName",
          "organizationId",
          "vrfId",
          "assignedObjectType",
          "assignedObjectId",
          "interfaceId",
          "createdAt",
          "updatedAt"
        )
        VALUES (
          gen_random_uuid(),
          ${entity.state.address}::inet,
          ${entity.state.status}::"IpStatus",
          ${entity.state.dnsName},
          ${entity.state.organizationId},
          ${entity.state.vrfId},
          ${entity.state.assignedObjectType}::"AssignedObjectType",
          ${entity.state.assignedObjectId},
          ${entity.state.interfaceId},
          now(),
          now()
        )
        RETURNING
          id,
          address::text AS address,
          status,
          "dnsName",
          "organizationId",
          "vrfId",
          "assignedObjectType",
          "assignedObjectId",
          "interfaceId",
          "createdAt",
          "updatedAt",
          "deletedAt"
      `;

      const created = createdRows[0];
      await this.writeAudit('IpAddress', created.id, null, this.toJsonObject(created), executor);
      return this.toIpAddress(created);
    }

    if (entity.isArchived) {
      const rows = await executor.queryRaw<IpAddressRow[]>`
        UPDATE "IpAddress" ip
        SET "deletedAt" = now(), "updatedAt" = now()
        WHERE ip.id = ${entity.state.id}
          AND ip."organizationId" = ${this.contextService.organizationId}
          AND ip."deletedAt" IS NULL
        RETURNING
          ip.id,
          ip.address::text AS address,
          ip.status,
          ip."dnsName",
          ip."organizationId",
          ip."vrfId",
          ip."assignedObjectType",
          ip."assignedObjectId",
          ip."interfaceId",
          ip."createdAt",
          ip."updatedAt",
          ip."deletedAt"
      `;
      if (rows.length === 0) {
        throw new NotFoundException('IP address not found');
      }
      const archived = rows[0];
      await this.writeAudit('IpAddress', archived.id, this.toJsonObject(before), this.toJsonObject(archived), executor);
      return this.toIpAddress(archived);
    }

    const rows = await executor.queryRaw<IpAddressRow[]>`
      UPDATE "IpAddress" ip
      SET
        status = CASE
          WHEN ${entity.changes.status}
          THEN ${entity.state.status}::"IpStatus"
          ELSE ip.status
        END,
        "dnsName" = CASE
          WHEN ${entity.changes.dnsName}
          THEN ${entity.state.dnsName}
          ELSE ip."dnsName"
        END,
        "vrfId" = CASE
          WHEN ${entity.changes.vrfId}
          THEN ${entity.state.vrfId}
          ELSE ip."vrfId"
        END,
        "interfaceId" = CASE
          WHEN ${entity.changes.interfaceId}
          THEN ${entity.state.interfaceId}
          ELSE ip."interfaceId"
        END,
        "assignedObjectType" = CASE
          WHEN ${entity.changes.interfaceId}
          THEN ${entity.state.assignedObjectType}::"AssignedObjectType"
          ELSE ip."assignedObjectType"
        END,
        "assignedObjectId" = CASE
          WHEN ${entity.changes.interfaceId}
          THEN ${entity.state.assignedObjectId}
          ELSE ip."assignedObjectId"
        END,
        "updatedAt" = now()
      WHERE ip.id = ${entity.state.id}
        AND ip."organizationId" = ${this.contextService.organizationId}
        AND ip."deletedAt" IS NULL
      RETURNING
        ip.id,
        ip.address::text AS address,
        ip.status,
        ip."dnsName",
        ip."organizationId",
        ip."vrfId",
        ip."assignedObjectType",
        ip."assignedObjectId",
        ip."interfaceId",
        ip."createdAt",
        ip."updatedAt",
        ip."deletedAt"
    `;
    if (rows.length === 0) {
      throw new NotFoundException('IP address not found');
    }
    const updated = rows[0];
    await this.writeAudit('IpAddress', updated.id, this.toJsonObject(before), this.toJsonObject(updated), executor);
    return this.toIpAddress(updated);
  }

  async ensureVrf(entity: IpAddressEntity): Promise<void> {
    if (!entity.shouldValidateVrf) {
      return;
    }
    await this.requireVrf(entity.state.vrfId);
  }

  async ensureNoAddressConflict(
    entity: IpAddressEntity,
    currentId: string | null,
    executor: IpamQueryExecutor = this,
  ): Promise<void> {
    if (!entity.shouldCheckAddressUniqueness) {
      return;
    }

    const duplicate = await executor.queryRaw<Array<{ id: string }>>`
      SELECT ip.id
      FROM "IpAddress" ip
      WHERE (${currentId}::text IS NULL OR ip.id <> ${currentId}::text)
        AND ip."organizationId" = ${entity.state.organizationId}
        AND ip."deletedAt" IS NULL
        AND (ip."vrfId" IS NOT DISTINCT FROM ${entity.state.vrfId})
        AND ip.address = ${entity.state.address}::inet
      LIMIT 1
    `;
    if (duplicate.length > 0) {
      throw new ConflictException('IP address already exists in this VRF');
    }
  }
}
