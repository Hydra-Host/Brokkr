import { Injectable, Logger } from '@nestjs/common';

import { getErrorMessage } from '../common/errors';
import { currentOrigin, originColumns } from '../common/lab-context';
import type { RunSink } from '../runner/run-sink';
import type { RunState } from '../runner/runner.service';
import { killOrphanRun } from './orphan-kill';
import { RunLogStore } from './run-log-store';
import { RunStore } from './run-store';

@Injectable()
export class RunLedgerService implements RunSink {
  private readonly log = new Logger(RunLedgerService.name);

  constructor(
    private readonly runs: RunStore,
    private readonly logs: RunLogStore,
  ) {}

  /** A lab restart is routine (process-compose SIGTERMs the API on every redeploy), so anything still
   *  `running` in the ledger at boot was orphaned by the previous process. */
  reconcileOnBoot(): number {
    try {
      const { rows, skipped } = this.runs.running();
      const finishedAt = Date.now();
      // raw sql over every running row, parsed or not, so a row this build cannot read still lands
      // terminal — only its pid goes unsignalled
      const failed = this.runs.failRunning(finishedAt);
      if (skipped > 0) this.log.warn(`orphan reconcile: ${skipped} unreadable run row(s) skipped — no pid signalled`);
      for (const row of rows) {
        const bytes = this.logs.size(row.run_id);
        if (bytes > 0) this.runs.setLogBytes(row.run_id, bytes);
        killOrphanRun(
          {
            runId: row.run_id,
            section: row.section,
            opId: row.op_id,
            pid: row.pid,
            startedAt: row.started_at,
          },
          this.log,
          finishedAt,
        );
      }
      if (failed > 0)
        this.log.warn(`orphan reconcile: ${failed} run(s) left running by the previous process -> orphaned`);
      return failed;
    } catch (error) {
      this.log.warn(`orphan reconcile failed: ${getErrorMessage(error)}`);
      return 0;
    }
  }

  /** The operator purge: row, events and log go together, or the ledger keeps history the operator
   *  asked to be rid of. A running run is pinned by the delete itself. */
  forget(runId: string): boolean {
    const deleted = this.runs.remove(runId);
    if (deleted) this.logs.remove(runId);
    return deleted;
  }

  onCreate(run: RunState): void {
    this.runs.insert({
      run_id: run.runId,
      section: run.section,
      op_id: run.opId,
      label: run.label,
      status: run.status,
      node_index: run.nodeIndex ?? null,
      started_at: run.startedAt,
      finished_at: null,
      exit_code: null,
      pid: run.childPid ?? null,
      ...originColumns(currentOrigin()),
    });
  }

  onSpawn(run: RunState): void {
    this.runs.setPid(run.runId, run.childPid ?? null);
  }

  onOutput(run: RunState, chunk: string): void {
    this.logs.append(run.runId, chunk);
  }

  onFinalize(run: RunState): void {
    const accounting = this.logs.finish(run.runId);
    this.runs.finish(run.runId, {
      status: run.status,
      exit_code: run.exitCode,
      finished_at: Date.now(),
      log_bytes: accounting.bytes,
      log_truncated: Number(accounting.truncated),
    });
  }
}
