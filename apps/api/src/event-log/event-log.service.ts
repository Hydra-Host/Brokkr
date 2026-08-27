import { Injectable } from '@nestjs/common';
import type { EventLogEntry, EventLogQuery } from '@repo/api-client';
import type { EventLog, Prisma } from '@repo/database';
import type { PaginatedResult } from '@repo/database/pagination';
import { isRecord } from '@repo/utils';
import { ContextService } from 'src/common/context/context.service';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LoggerService } from 'src/logger/logger.service';
import { toEventLogFilter, toEventLogWhere } from './event-log.filters';
import { EventLogRepository } from './event-log.repository';
import type { EventLogWrite } from './event-log.types';

@Injectable()
export class EventLogService {
  constructor(
    private readonly repository: EventLogRepository,
    @Logger(EventLogService.name) private readonly logger: LoggerService,
    private readonly contextService: ContextService,
  ) {}

  async list(query: EventLogQuery): Promise<PaginatedResult<EventLogEntry>> {
    this.contextService.requirePermission('event-log', 'access');
    // Pinned from context, never from the query — this is the tenant boundary.
    const organizationId = this.contextService.organizationId;
    const {
      from,
      to,
      includeSystemActors,
      actionKey,
      resource,
      tier,
      durability,
      actorId,
      actorType,
      outcome,
      targetId,
      ...paginationQuery
    } = query;

    // Compiled through the shared builder rather than the pagination helper's `filters` string: these
    // are named contract params, and the export path must resolve them identically.
    const filter = toEventLogFilter(organizationId, {
      from,
      to,
      includeSystemActors,
      actionKey,
      resource,
      tier,
      durability,
      actorId,
      actorType,
      outcome,
      targetId,
    });

    const page = await this.repository.list(toEventLogWhere(filter), paginationQuery);
    return { ...page, data: page.data.map(toEntry) };
  }

  /** Tier 1 class A. An export is the exfiltration-relevant read, so it is recorded even though a
   *  plain browse is not. Unthrottled: one bulk download is already bounded by the row cap. */
  async recordExport(): Promise<void> {
    const write: EventLogWrite = {
      organizationId: this.contextService.organizationId,
      tier: 'EVIDENCE',
      durability: 'ATOMIC',
      resource: 'event-log',
      action: 'exported',
      actionKey: 'event-log.exported',
      ...this.contextService.actorFields(),
      ...this.contextService.requestFields(),
      outcome: 'SUCCEEDED',
      requestId: this.contextService.requestId ?? null,
    };

    await this.repository.insert(write);
  }

  /** Tier 1 class A. Shares the mutation's transaction, so a failure here rolls the mutation back. */
  async recordInTransaction(tx: Prisma.TransactionClient, write: EventLogWrite): Promise<void> {
    await this.repository.insert(write, tx);
  }

  /** Tier 1 classes B and C. Throws so the caller can leave its intent unfinalized and let tier 2 record instead. */
  async record(write: EventLogWrite): Promise<void> {
    await this.repository.insert(write);
  }

  /** Tier 2. Never on the response critical path, so a failure is logged and dropped. */
  async recordBestEffort(write: EventLogWrite): Promise<void> {
    try {
      await this.repository.insert(write);
    } catch (error) {
      this.logger.error(
        `Failed to persist event ${write.actionKey} for organization ${write.organizationId}: ${getErrorMessage(error)}`,
      );
    }
  }
}

/** Projected explicitly so a future column cannot reach the wire, and so Prisma's JsonValue
 *  narrows to the object-or-null shape the contract declares. */
function toEntry(row: EventLog): EventLogEntry {
  return {
    id: row.id,
    tier: row.tier,
    durability: row.durability,
    resource: row.resource,
    action: row.action,
    actionKey: row.actionKey,
    actorType: row.actorType,
    actorId: row.actorId,
    actorLabel: row.actorLabel,
    apiKeyId: row.apiKeyId,
    apiKeyLabel: row.apiKeyLabel,
    targetId: row.targetId,
    targetLabel: row.targetLabel,
    outcome: row.outcome,
    errorCode: row.errorCode,
    requestId: row.requestId,
    method: row.method,
    path: row.path,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    metadata: isRecord(row.metadata) ? row.metadata : null,
    createdAt: row.createdAt,
  };
}
