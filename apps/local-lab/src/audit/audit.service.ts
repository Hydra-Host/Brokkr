import { Injectable, Logger } from '@nestjs/common';

import { originFromColumns } from '../common/lab-context';
import { type AuditEvent } from '../contract';
import type { AuditEventRow, AuditListFilter } from '../db/db';
import { AuditStore } from '../ledger/audit-store';

/** Read facade over the audit table — the trail is append-only, so this is the whole domain. */
@Injectable()
export class AuditService {
  private readonly log = new Logger(AuditService.name);

  constructor(private readonly events: AuditStore) {}

  list(filter: AuditListFilter): AuditEvent[] {
    const read = this.events.list(filter);
    if (read.skipped > 0) this.log.warn(`${read.skipped} audit row(s) this build cannot read — omitted from the list`);
    return read.rows.map((row) => this.fromRow(row));
  }

  private fromRow(row: AuditEventRow): AuditEvent {
    return {
      id: row.id,
      ts: row.ts,
      method: row.method,
      path: row.path,
      handler: row.handler,
      outcome: row.outcome,
      statusCode: row.status_code,
      durationMs: row.duration_ms,
      runId: row.run_id,
      origin: originFromColumns(row),
      params: row.params,
      error: row.error,
    };
  }
}
