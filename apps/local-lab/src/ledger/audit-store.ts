import { Injectable } from '@nestjs/common';

import {
  type AuditEventRow,
  type AuditEventRowsRead,
  type AuditListFilter,
  type AuditPruneFilter,
  insertAuditEvent,
  listAuditEventRows,
  pruneAuditEvents,
} from '../db/db';

/** The audit table's only door to sql — the sibling of RunStore, which is runs-only. */
@Injectable()
export class AuditStore {
  insert(row: Omit<AuditEventRow, 'id'>): void {
    insertAuditEvent(row);
  }

  list(filter: AuditListFilter): AuditEventRowsRead {
    return listAuditEventRows(filter);
  }

  prune(filter: AuditPruneFilter): number {
    return pruneAuditEvents(filter);
  }
}
