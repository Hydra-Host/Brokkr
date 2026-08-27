import { Injectable } from '@nestjs/common';
import { EventLogEntrySchema, type EventLogEntry } from '@repo/api-client';
import { Prisma, type EventLog } from '@repo/database';
import { paginateQuery, type PaginatedResult, type PaginationQuery } from '@repo/database/pagination';
import { isRecord } from '@repo/utils';
import { PrismaClient } from 'src/prisma/prisma.client';
import { z } from 'zod';
import type { EventKey } from './event-log-cursor';
import { toEventLogSqlConditions, type EventLogFilter } from './event-log.filters';
import { eventLogPaginationConfig } from './event-log.pagination';
import type { EventLogWrite } from './event-log.types';

// Derived from the contract schema so a new projected field is selected and validated automatically.
const ENTRY_COLUMNS = Prisma.join(EventLogEntrySchema.keyof().options.map((field) => Prisma.raw(`"${field}"`)));

/** jsonb admits scalars while the contract declares object-or-null, and one odd row must not fail a
 *  whole export page. */
function normalizeRow(row: unknown): unknown {
  if (!isRecord(row)) return row;
  return { ...row, metadata: isRecord(row.metadata) ? row.metadata : null };
}

@Injectable()
export class EventLogRepository {
  constructor(private readonly prisma: PrismaClient) {}

  insert(write: EventLogWrite, tx?: Prisma.TransactionClient): Promise<unknown> {
    return (tx ?? this.prisma).eventLog.create({ data: toCreateInput(write) });
  }

  /** `where` is composed by the service; the organization pin is never taken from the query. */
  list(where: Prisma.EventLogWhereInput, query: PaginationQuery): Promise<PaginatedResult<EventLog>> {
    return paginateQuery<EventLog>(this.prisma.eventLog, query, eventLogPaginationConfig, { where });
  }

  async findAfterKey(filter: EventLogFilter, after: EventKey, limit: number): Promise<EventLogEntry[]> {
    const rows = await this.prisma.$queryRaw<unknown[]>(eventLogKeysetQuery(filter, after, limit));

    return rows.map((row) => EventLogEntrySchema.parse(normalizeRow(row)));
  }

  /** Bounded probe: pass `limit + 1` and a larger result proves the cap truncated the export, so
   *  exactly `limit` matching rows are never reported as truncated. */
  async countAfterKey(filter: EventLogFilter, after: EventKey, limit: number): Promise<number> {
    const rows = await this.prisma.$queryRaw<unknown[]>(Prisma.sql`
      SELECT count(*)::int AS "count" FROM (
        SELECT 1 FROM "EventLog"
        WHERE ${keysetWhere(filter, after)}
        ORDER BY "createdAt" ASC, "id" ASC
        LIMIT ${limit}
      ) AS bounded
    `);

    return z.array(z.object({ count: z.number().int() })).parse(rows)[0].count;
  }

  async findOldestKey(organizationId: string): Promise<EventKey | null> {
    const row = await this.prisma.eventLog.findFirst({
      where: { organizationId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, createdAt: true },
    });

    return row ? { createdAt: row.createdAt, id: row.id } : null;
  }
}

/** Row-tuple keyset. Prisma's query builder cannot express `("createdAt", id) > (?, ?)`, and that
 *  predicate is what lets EventLog_org_createdAt_id_asc_idx drive the scan instead of a sort. */
export function eventLogKeysetQuery(filter: EventLogFilter, after: EventKey, limit: number): Prisma.Sql {
  return Prisma.sql`
    SELECT ${ENTRY_COLUMNS}
    FROM "EventLog"
    WHERE ${keysetWhere(filter, after)}
    ORDER BY "createdAt" ASC, "id" ASC
    LIMIT ${limit}
  `;
}

function keysetWhere(filter: EventLogFilter, after: EventKey): Prisma.Sql {
  const conditions = [
    ...toEventLogSqlConditions(filter),
    Prisma.sql`("createdAt", "id") > (${after.createdAt}, ${after.id})`,
  ];

  return Prisma.join(conditions, ' AND ');
}

function toCreateInput(write: EventLogWrite): Prisma.EventLogCreateInput {
  return {
    organizationId: write.organizationId,
    tier: write.tier,
    durability: write.durability,
    resource: write.resource,
    action: write.action,
    actionKey: write.actionKey,
    actorType: write.actorType,
    actorId: write.actorId ?? null,
    actorLabel: write.actorLabel ?? null,
    apiKeyId: write.apiKeyId ?? null,
    apiKeyLabel: write.apiKeyLabel ?? null,
    targetId: write.targetId ?? null,
    targetLabel: write.targetLabel ?? null,
    outcome: write.outcome,
    errorCode: write.errorCode ?? null,
    requestId: write.requestId ?? null,
    method: write.method ?? null,
    path: write.path ?? null,
    ipAddress: write.ipAddress ?? null,
    userAgent: write.userAgent ?? null,
    // Omitted rather than set to null: Prisma distinguishes JSON null from DB NULL.
    ...(write.metadata == null ? {} : { metadata: write.metadata }),
  };
}
