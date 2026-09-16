import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';

import { getErrorMessage } from '@repo/utils';
import { RunSectionSchema } from '../contract';
import { AuditStore } from './audit-store';
import { RunLogStore } from './run-log-store';
import { RunResultsStore } from './run-results-store';
import { RunStore } from './run-store';

const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

const DEFAULT_RUNS_PER_SECTION = 500;
const DEFAULT_RUN_TTL_DAYS = 30;
const DEFAULT_AUDIT_ROWS = 5000;
const DEFAULT_AUDIT_DENIED_ROWS = 1000;
const DEFAULT_AUDIT_TTL_DAYS = 90;
const DEFAULT_LOG_BUDGET_BYTES = 2 * 1024 * 1024 * 1024;

export interface RetentionSweep {
  runs: number;
  runLogs: number;
  runResults: number;
  logBytes: number;
  auditEvents: number;
  orphanLogs: number;
  orphanResults: number;
}

function positiveEnv(name: string, fallback: number): number {
  const configured = Number(process.env[name]);
  return Number.isFinite(configured) && configured > 0 ? configured : fallback;
}

export function retentionEnabled(): boolean {
  return (process.env.LAB_RUNS_RETENTION ?? '').trim().toLowerCase() !== 'off';
}

/** Caps are per section so a burst of fleet power runs cannot evict a week of test history. */
@Injectable()
export class RunRetentionService implements OnApplicationShutdown {
  private readonly log = new Logger(RunRetentionService.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly runs: RunStore,
    private readonly audit: AuditStore,
    private readonly logs: RunLogStore,
    private readonly results: RunResultsStore,
  ) {}

  /** Started from the boot sequence rather than a lifecycle hook: the first sweep has to follow the
   *  orphan reconcile, which itself waits for the port bind. */
  start(): void {
    if (!retentionEnabled()) {
      this.log.log('run retention is off (LAB_RUNS_RETENTION=off) — nothing will be swept');
      return;
    }
    this.sweepAndLog();
    this.timer = setInterval(() => this.sweepAndLog(), SWEEP_INTERVAL_MS);
    // an interval holding the event loop open would hang SIGTERM teardown
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  sweep(now: number = Date.now()): RetentionSweep {
    const swept: RetentionSweep = {
      runs: 0,
      runLogs: 0,
      runResults: 0,
      logBytes: 0,
      auditEvents: 0,
      orphanLogs: 0,
      orphanResults: 0,
    };
    if (!retentionEnabled()) return swept;
    const keep = positiveEnv('LAB_RUNS_KEEP_PER_SECTION', DEFAULT_RUNS_PER_SECTION);
    const startedBefore = now - positiveEnv('LAB_RUNS_TTL_DAYS', DEFAULT_RUN_TTL_DAYS) * DAY_MS;
    for (const section of RunSectionSchema.options) {
      for (const runId of this.runs.prune({ section, keep, startedBefore })) {
        swept.runs += 1;
        if (this.logs.remove(runId)) swept.runLogs += 1;
        // only a test run captures the per-run process-compose log slices a results dir holds
        if (section === 'test' && this.results.remove(runId)) swept.runResults += 1;
      }
    }
    this.sweepLogBudget(swept);
    swept.auditEvents = this.audit.prune({
      keep: positiveEnv('LAB_AUDIT_KEEP', DEFAULT_AUDIT_ROWS),
      deniedKeep: positiveEnv('LAB_AUDIT_DENIED_KEEP', DEFAULT_AUDIT_DENIED_ROWS),
      before: now - positiveEnv('LAB_AUDIT_TTL_DAYS', DEFAULT_AUDIT_TTL_DAYS) * DAY_MS,
    });
    const known = this.runs.allIds();
    swept.orphanLogs = this.logs.removeOrphans(known, now);
    swept.orphanResults = this.results.removeOrphans(known, now);
    return swept;
  }

  /** The count cap alone bounds rows, not disk: six sections x the per-section cap x the 8 MiB
   *  per-file cap is tens of gigabytes before either the cap or the ttl fires. */
  private sweepLogBudget(swept: RetentionSweep): void {
    const budget = positiveEnv('LAB_RUNS_LOG_BUDGET_BYTES', DEFAULT_LOG_BUDGET_BYTES);
    const sizes = this.runs.terminalLogSizes();
    let total = sizes.reduce((sum, row) => sum + row.log_bytes, 0);
    for (const row of sizes) {
      if (total <= budget) return;
      // a zero-byte row frees nothing, so evicting it would not move total and the loop would keep
      // deleting history to reach a budget it can never reach that way
      if (row.log_bytes <= 0) continue;
      if (!this.runs.remove(row.run_id)) continue;
      total -= row.log_bytes;
      swept.runs += 1;
      swept.logBytes += row.log_bytes;
      if (this.logs.remove(row.run_id)) swept.runLogs += 1;
      if (row.section === 'test' && this.results.remove(row.run_id)) swept.runResults += 1;
    }
  }

  private sweepAndLog(): void {
    try {
      const swept = this.sweep();
      this.log.log(
        `retention sweep: ${swept.runs} run(s), ${swept.runLogs} run log(s), ` +
          `${swept.runResults} results dir(s), ${swept.auditEvents} audit event(s), ` +
          `${swept.orphanLogs} orphan log(s), ${swept.orphanResults} orphan results dir(s) removed; ` +
          `${swept.logBytes} log byte(s) reclaimed by the budget`,
      );
    } catch (error) {
      this.log.warn(`retention sweep failed: ${getErrorMessage(error)}`);
    }
  }
}
