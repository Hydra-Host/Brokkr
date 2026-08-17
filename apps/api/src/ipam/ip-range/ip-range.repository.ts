import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  DetectIpRangeOverlapRequest,
  IpamPrefix,
  IpRange,
  IpRangeListQuery,
  IpRangeOverlapResult,
} from '@repo/api-client';
import { Prisma } from '@repo/database';
import { ContextService } from 'src/common/context/context.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { BaseIpamRepository } from '../shared/base-ipam.repository';
import { IpRangeOverlapRow, IpRangeRow } from '../shared/ipam.types';
import { IpRangeEntity } from './ip-range.entity';

@Injectable()
export class IpRangeRepository extends BaseIpamRepository {
  constructor(prisma: PrismaClient, contextService: ContextService) {
    super(prisma, contextService);
  }

  async listIpRanges(query: IpRangeListQuery): Promise<IpRange[]> {
    const clauses: Prisma.Sql[] = [Prisma.sql`r."organizationId" = ${this.contextService.organizationId}`];
    if (!query.includeArchived) {
      clauses.push(Prisma.sql`r."deletedAt" IS NULL`);
    }
    if (query.prefixId) {
      clauses.push(Prisma.sql`r."prefixId" = ${query.prefixId}`);
    }
    if (query.vrfId) {
      clauses.push(Prisma.sql`r."vrfId" = ${query.vrfId}`);
    }
    if (query.status) {
      clauses.push(Prisma.sql`r.status = ${query.status}::"IpRangeStatus"`);
    }
    const rows = await this.queryRaw<IpRangeRow[]>`
      SELECT
        r.id,
        r.start::text AS start,
        r."end"::text AS "end",
        r.status,
        r.purpose,
        r."organizationId",
        r."prefixId",
        r."vrfId",
        r."createdAt",
        r."updatedAt",
        r."deletedAt"
      FROM "IpRange" r
      WHERE ${Prisma.join(clauses, ' AND ')}
      ORDER BY r."prefixId" ASC, r.start::text ASC
    `;
    return rows.map((row) => this.toIpRange(row));
  }

  async loadPrefix(prefixId: string): Promise<IpamPrefix> {
    return this.requirePrefix(prefixId);
  }

  async restore(id: string): Promise<IpRange> {
    return this.requireIpRange(id);
  }

  async normalizeBounds(entity: IpRangeEntity): Promise<void> {
    if (!entity.shouldNormalizeBounds) {
      return;
    }

    const normalizedStart = await this.normalizeInet(this.requireString(entity.state.start, 'start'));
    const normalizedEnd = await this.normalizeInet(this.requireString(entity.state.end, 'end'));
    entity.applyNormalizedBounds(normalizedStart, normalizedEnd);
  }

  async ensureScope(prefix: IpamPrefix, vrfId: string | null): Promise<void> {
    await this.validateIpRangeScope(prefix, vrfId);
  }

  async ensureVersionMatch(start: string, end: string): Promise<void> {
    const rows = await this.queryRaw<Array<{ sameVersion: boolean }>>`
      SELECT family(${start}::inet) = family(${end}::inet) AS "sameVersion"
    `;
    if (rows.length === 0 || !rows[0].sameVersion) {
      throw new BadRequestException('IP range start and end must be the same IP version');
    }
  }

  async ensureBounds(prefix: IpamPrefix, start: string, end: string): Promise<void> {
    await this.validateIpRangeBounds(prefix, start, end);
  }

  async ensureNoOverlap(entity: IpRangeEntity, currentId: string | null): Promise<void> {
    if (!entity.shouldValidatePlacement) {
      return;
    }

    const overlap = await this.lookupOverlap({
      prefixId: entity.state.prefixId,
      start: entity.state.start,
      end: entity.state.end,
      vrfId: entity.state.vrfId,
      excludeRangeId: currentId,
    });
    if (overlap !== null) {
      throw new ConflictException('IP range overlaps existing range');
    }
  }

  async save(entity: IpRangeEntity): Promise<IpRange> {
    if (entity.isNew) {
      const rows = await this.queryRaw<IpRangeRow[]>`
        INSERT INTO "IpRange" (
          id,
          start,
          "end",
          status,
          purpose,
          "organizationId",
          "prefixId",
          "vrfId",
          "createdAt",
          "updatedAt"
        )
        VALUES (
          gen_random_uuid(),
          ${entity.state.start}::inet,
          ${entity.state.end}::inet,
          ${entity.state.status}::"IpRangeStatus",
          ${entity.state.purpose},
          ${entity.state.organizationId},
          ${entity.state.prefixId},
          ${entity.state.vrfId},
          now(),
          now()
        )
        RETURNING
          id,
          start::text AS start,
          "end"::text AS "end",
          status,
          purpose,
          "organizationId",
          "prefixId",
          "vrfId",
          "createdAt",
          "updatedAt",
          "deletedAt"
      `;
      const created = rows[0];
      await this.writeAudit('IpRange', created.id, null, this.toJsonObject(created));
      return this.toIpRange(created);
    }

    if (entity.isArchived) {
      const rows = await this.queryRaw<IpRangeRow[]>`
        UPDATE "IpRange" r
        SET "deletedAt" = now(), "updatedAt" = now()
        WHERE r.id = ${entity.state.id}
          AND r."organizationId" = ${this.contextService.organizationId}
          AND r."deletedAt" IS NULL
        RETURNING
          id,
          start::text AS start,
          "end"::text AS "end",
          status,
          purpose,
          "organizationId",
          "prefixId",
          "vrfId",
          "createdAt",
          "updatedAt",
          "deletedAt"
      `;
      if (rows.length === 0) {
        throw new NotFoundException('IP range not found');
      }
      const archived = rows[0];
      await this.writeAudit('IpRange', archived.id, null, this.toJsonObject(archived));
      return this.toIpRange(archived);
    }

    const rows = await this.queryRaw<IpRangeRow[]>`
      UPDATE "IpRange" r
      SET
        start = CASE WHEN ${entity.changes.start} THEN ${entity.state.start}::inet ELSE r.start END,
        "end" = CASE WHEN ${entity.changes.end} THEN ${entity.state.end}::inet ELSE r."end" END,
        status = CASE
          WHEN ${entity.changes.status}
          THEN ${entity.state.status}::"IpRangeStatus"
          ELSE r.status
        END,
        purpose = CASE
          WHEN ${entity.changes.purpose}
          THEN ${entity.state.purpose}
          ELSE r.purpose
        END,
        "vrfId" = CASE
          WHEN ${entity.changes.vrfId}
          THEN ${entity.state.vrfId}
          ELSE r."vrfId"
        END,
        "updatedAt" = now()
      WHERE r.id = ${entity.state.id}
        AND r."organizationId" = ${this.contextService.organizationId}
        AND r."deletedAt" IS NULL
      RETURNING
        id,
        start::text AS start,
        "end"::text AS "end",
        status,
        purpose,
        "organizationId",
        "prefixId",
        "vrfId",
        "createdAt",
        "updatedAt",
        "deletedAt"
    `;
    if (rows.length === 0) {
      throw new NotFoundException('IP range not found');
    }
    const updated = rows[0];
    await this.writeAudit('IpRange', updated.id, null, this.toJsonObject(updated));
    return this.toIpRange(updated);
  }

  async detectIpRangeOverlap(input: DetectIpRangeOverlapRequest): Promise<IpRangeOverlapResult> {
    const prefixId = this.requireString(input.prefixId, 'prefixId');
    const start = this.requireString(input.start, 'start');
    const end = this.requireString(input.end, 'end');
    const requestedVrfId: string | null | undefined =
      input.vrfId === undefined || input.vrfId === null ? input.vrfId : this.requireString(input.vrfId, 'vrfId');

    const prefix = await this.requirePrefix(prefixId);
    const prefixVrfId = prefix.vrfId === null ? null : this.requireString(prefix.vrfId, 'vrfId');
    const normalizedStart = await this.normalizeInet(start);
    const normalizedEnd = await this.normalizeInet(end);
    const scopedVrfId: string | null = requestedVrfId !== undefined ? requestedVrfId : prefixVrfId;
    await this.validateIpRangeScope(prefix, scopedVrfId ?? null);
    await this.validateIpRangeBounds(prefix, normalizedStart, normalizedEnd);

    const overlap = await this.lookupOverlap({
      prefixId: prefix.id,
      start: normalizedStart,
      end: normalizedEnd,
      vrfId: scopedVrfId ?? null,
      excludeRangeId: input.excludeRangeId ?? null,
    });

    if (overlap === null) {
      return {
        hasOverlap: false,
        conflictingRangeId: null,
        conflictingStart: null,
        conflictingEnd: null,
      };
    }

    return {
      hasOverlap: true,
      conflictingRangeId: overlap.id,
      conflictingStart: overlap.start,
      conflictingEnd: overlap.end,
    };
  }

  private async lookupOverlap(params: {
    prefixId: string;
    start: string;
    end: string;
    vrfId: string | null;
    excludeRangeId: string | null;
  }): Promise<IpRangeOverlapRow | null> {
    const clauses: Prisma.Sql[] = [
      Prisma.sql`r."organizationId" = ${this.contextService.organizationId}`,
      Prisma.sql`r."deletedAt" IS NULL`,
      Prisma.sql`r."prefixId" = ${params.prefixId}`,
      Prisma.sql`(r."vrfId" IS NOT DISTINCT FROM ${params.vrfId})`,
      Prisma.sql`NOT (${params.end}::inet < r.start OR ${params.start}::inet > r."end")`,
    ];
    if (params.excludeRangeId !== null) {
      clauses.push(Prisma.sql`r.id <> ${params.excludeRangeId}`);
    }

    const rows = await this.queryRaw<IpRangeOverlapRow[]>`
      SELECT r.id, r.start::text AS start, r."end"::text AS "end"
      FROM "IpRange" r
      WHERE ${Prisma.join(clauses, ' AND ')}
      LIMIT 1
    `;

    return rows.length === 0 ? null : rows[0];
  }

  private requireString(value: unknown, fieldName: string): string {
    if (typeof value !== 'string') {
      throw new BadRequestException(`${fieldName} must be a string`);
    }
    return value;
  }
}
