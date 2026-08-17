import { Injectable } from '@nestjs/common';
import type { EventLog, Prisma } from '@repo/database';
import { paginateQuery, type PaginatedResult, type PaginationQuery } from '@repo/database/pagination';
import { PrismaClient } from 'src/prisma/prisma.client';
import { eventLogPaginationConfig } from './event-log.pagination';
import type { EventLogWrite } from './event-log.types';

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
