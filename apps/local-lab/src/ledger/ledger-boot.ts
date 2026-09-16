import { Logger } from '@nestjs/common';

import { getErrorMessage } from '@repo/utils';
import { RunLedgerService } from './run-ledger.service';
import { RunRetentionService } from './run-retention.service';
import { StateDirLock } from './state-dir-lock';

const log = new Logger('RunLedgerBoot');

/** Deliberately not a lifecycle hook: the reconcile SIGTERMs the pids the ledger still calls running,
 *  so it waits on the state-dir lock that proves those are ours rather than a live lab's. */
export function bootRunLedger(lock: StateDirLock, ledger: RunLedgerService, retention: RunRetentionService): void {
  if (lock.acquire()) {
    try {
      ledger.reconcileOnBoot();
    } catch (error) {
      log.warn(`orphan reconcile failed: ${getErrorMessage(error)}`);
    }
  }
  // retention runs either way: it signals nothing, and every delete it makes pins a terminal row
  retention.start();
}
