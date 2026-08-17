import { Global, Module } from '@nestjs/common';

import { RUN_SINK } from '../runner/run-sink';
import { AuditStore } from './audit-store';
import { RunLedgerService } from './run-ledger.service';
import { RunLogStore } from './run-log-store';
import { RunResultsStore } from './run-results-store';
import { RunRetentionService } from './run-retention.service';
import { RunStore } from './run-store';
import { StateDirLock } from './state-dir-lock';

// global, and never re-bound inside RunnerModule: a module-local RUN_SINK would shadow this one and
// silently drop every write.
@Global()
@Module({
  providers: [
    RunStore,
    AuditStore,
    RunLogStore,
    RunResultsStore,
    RunLedgerService,
    RunRetentionService,
    StateDirLock,
    { provide: RUN_SINK, useExisting: RunLedgerService },
  ],
  exports: [RUN_SINK, RunLedgerService, RunStore, AuditStore, RunLogStore],
})
export class LedgerModule {}
