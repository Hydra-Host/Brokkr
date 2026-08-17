import { Injectable, Logger } from '@nestjs/common';
import { existsSync, rmSync } from 'node:fs';

import { getErrorMessage } from '../common/errors';
import { labStateDir } from '../common/lab-state';
import { isSafeRunId } from '../common/run-id';
import { listResultsDirs, RESULTS_ROOT, resultsDir, resultsRootBelongsToStateDir } from '../results-root';
import { pastOrphanGrace } from './orphan-grace';

/** The per-run results dirs holding a test run's captured process-compose log slices. Retention owns
 *  them for the same reason it owns the .log files: nothing else bounds their growth. */
@Injectable()
export class RunResultsStore {
  private readonly log = new Logger(RunResultsStore.name);

  /** Called only for a run retention has just deleted, so the dir never outlives its row. */
  remove(runId: string): boolean {
    // a sweep must not throw on one odd row id, so probe the guard rather than letting resultsDir reject
    if (!isSafeRunId(runId)) return false;
    if (!this.ownsResultsRoot()) return false;
    return this.removeDir(resultsDir(runId));
  }

  /** A results dir whose run has no row. The reverse orphan — a row whose dir is gone — is normal. */
  removeOrphans(known: ReadonlySet<string>, now: number = Date.now()): number {
    if (!this.ownsResultsRoot()) return 0;
    let removed = 0;
    for (const entry of listResultsDirs()) {
      if (known.has(entry.runId)) continue;
      try {
        if (!pastOrphanGrace(entry.path, now)) continue;
      } catch (error) {
        this.log.warn(`results dir ${entry.path} could not be stat'd: ${getErrorMessage(error)}`);
        continue;
      }
      if (this.removeDir(entry.path)) removed += 1;
    }
    return removed;
  }

  // the results root ignores LOCAL_STATE, so a ledger pointed at a throwaway state dir would see a
  // developer's whole real history as its own to delete
  private ownsResultsRoot(): boolean {
    if (resultsRootBelongsToStateDir(labStateDir())) return true;
    this.log.warn(`results root ${RESULTS_ROOT} is outside ${labStateDir()} — declining to delete under it`);
    return false;
  }

  private removeDir(path: string): boolean {
    if (!existsSync(path)) return false;
    try {
      rmSync(path, { recursive: true, force: true });
      return true;
    } catch (error) {
      this.log.warn(`results dir ${path} could not be removed: ${getErrorMessage(error)}`);
      return false;
    }
  }
}
