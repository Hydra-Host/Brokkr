import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EMPTY, type Observable } from 'rxjs';

import { originFromColumns } from '../common/lab-context';
import { isSafeRunId } from '../common/run-id';
import { type Run, type RunSection } from '../contract';
import type { RunListFilter, RunRow, RunRowsRead } from '../db/db';
import { RunLogStore } from '../ledger/run-log-store';
import { RunStore } from '../ledger/run-store';
import { resultsDir } from '../results-root';
import { RunnerService, type RunInfo } from '../runner/runner.service';

/** Read facade over the run ledger: a run still executing is authoritative from memory, everything
 *  else comes from the rows the sink persisted. */
@Injectable()
export class RunsService {
  private readonly log = new Logger(RunsService.name);

  constructor(
    private readonly runner: RunnerService,
    private readonly rows: RunStore,
    private readonly logs: RunLogStore,
  ) {}

  list(filter: RunListFilter): Run[] {
    const byId = new Map<string, Run>();
    const readded = new Set<string>();
    for (const row of this.readable(this.rows.list(filter), 'the list')) byId.set(row.run_id, this.fromRow(row));
    for (const live of this.runner.list(filter.section)) {
      const paged = byId.get(live.runId);
      if (paged === undefined && !this.unrecorded(live.runId, filter)) continue;
      const merged = this.fromLive(live, paged);
      if (!matches(merged, filter)) {
        byId.delete(live.runId);
        continue;
      }
      byId.set(live.runId, merged);
      if (paged === undefined) readded.add(live.runId);
    }
    const page = [...byId.values()].sort((a, b) => b.startedAt - a.startedAt || (a.runId < b.runId ? 1 : -1));
    return capPage(page, filter.limit, readded);
  }

  /** Unpaged on purpose: this backs the node-conflict and purge guards, and a paged read can push an
   *  older still-running run off the page, reading a busy node as free. */
  active(section?: RunSection): Run[] {
    const byId = new Map<string, Run>();
    for (const row of this.readable(this.rows.running(section), 'the guard')) byId.set(row.run_id, this.fromRow(row));
    for (const live of this.runner.list(section)) byId.set(live.runId, this.fromLive(live, byId.get(live.runId)));
    return [...byId.values()].filter((run) => run.status === 'running');
  }

  get(runId: string): Run {
    const row = this.rows.get(runId);
    const live = this.runner.getRun(runId);
    if (live) return this.fromLive(live, row === undefined ? undefined : this.fromRow(row));
    if (row) return this.fromRow(row);
    throw new NotFoundException(`unknown run '${runId}'`);
  }

  /** A run the runner cannot signal has no child executing, so it is force-finalized here rather than
   *  left running until the next boot reconcile; `cancelled` reports only whether a SIGTERM landed. */
  cancel(runId: string): { cancelled: boolean } {
    const run = this.get(runId);
    if (run.status !== 'running') throw new ConflictException(`run '${runId}' is not running (status=${run.status})`);
    const live = this.runner.getRun(runId);
    const signalled = this.runner.cancel(runId);
    if (signalled) return { cancelled: true };
    if (live) {
      this.runner.finalize(live, null);
      return { cancelled: false };
    }
    // a row left `running` with nothing behind it reports its node busy forever: every delete pins
    // `status <> 'running'`, so retention and purge both skip it and only a restart would clear it
    if (this.rows.cancelRunning(runId, Date.now())) this.log.warn(`cleared the stale running row of '${runId}'`);
    return { cancelled: false };
  }

  /** The persisted log is what makes a run observable across the restart that dropped it from memory;
   *  an empty live$ lets the caller emit the replay and close. */
  stream(runId: string): { backlog: string; live$: Observable<string> } {
    if (this.runner.getRun(runId)) return this.runner.stream(runId);
    const persisted = this.logs.read(runId);
    if (persisted === null) throw new NotFoundException(`no retained log for run '${runId}'`);
    return { backlog: persisted, live$: EMPTY };
  }

  private readable(read: RunRowsRead, context: string): RunRow[] {
    if (read.skipped > 0) this.log.warn(`${read.skipped} run row(s) this build cannot read — omitted from ${context}`);
    return read.rows;
  }

  /** A run whose ledger insert threw lives only in memory; without adding it back a busy node would
   *  read free. Restricted to the first page so it cannot duplicate onto later ones. */
  private unrecorded(runId: string, filter: RunListFilter): boolean {
    return filter.offset === 0 && this.rows.get(runId) === undefined;
  }

  private fromRow(row: RunRow): Run {
    return {
      runId: row.run_id,
      section: row.section,
      opId: row.op_id,
      label: row.label,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      exitCode: row.exit_code,
      nodeIndex: row.node_index,
      origin: originFromColumns(row),
      hasLog: row.log_bytes > 0,
      hasResult: hasResult(row.section, row.run_id),
    };
  }

  private fromLive(live: RunInfo, row: Run | undefined): Run {
    return {
      runId: live.runId,
      section: live.section,
      opId: live.opId,
      label: live.label,
      status: live.status,
      startedAt: live.startedAt,
      finishedAt: row?.finishedAt ?? null,
      exitCode: live.exitCode,
      nodeIndex: live.nodeIndex ?? null,
      origin: row?.origin ?? null,
      hasLog: row?.hasLog ?? false,
      hasResult: hasResult(live.section, live.runId),
    };
  }
}

// a full page plus the re-added runs would exceed the caller's limit, so the overflow comes off the oldest
// non-re-added rows first; re-adds go only when they alone exceed it, and the guards read unpaged active()
function capPage(page: Run[], limit: number, readded: ReadonlySet<string>): Run[] {
  if (page.length <= limit) return page;
  let overflow = page.length - limit;
  const kept: Run[] = [];
  for (let i = page.length - 1; i >= 0; i -= 1) {
    const run = page[i]!;
    if (overflow > 0 && !readded.has(run.runId)) {
      overflow -= 1;
      continue;
    }
    kept.push(run);
  }
  return kept.reverse().slice(0, limit);
}

// results.json is the vitest json-reporter sentinel; the reporter isn't wired yet, so this stays false
function hasResult(section: RunSection, runId: string): boolean {
  // a list read must not throw on one odd id, so probe the guard rather than letting resultsDir reject
  return section === 'test' && isSafeRunId(runId) && existsSync(join(resultsDir(runId), 'results.json'));
}

function matches(run: Run, filter: RunListFilter): boolean {
  if (filter.section !== undefined && run.section !== filter.section) return false;
  if (filter.status !== undefined && run.status !== filter.status) return false;
  return filter.opId === undefined || run.opId === filter.opId;
}
