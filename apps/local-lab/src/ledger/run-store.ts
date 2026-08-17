import { Injectable } from '@nestjs/common';

import { type RunSection } from '../contract';
import {
  cancelRunningRunRow,
  deleteRunRow,
  failRunningRunRows,
  finishRunRow,
  getRunRow,
  insertRunRow,
  listRunIds,
  listRunningRunRows,
  listRunRows,
  listTerminalRunLogSizes,
  pruneRunRows,
  type RunFinish,
  type RunInsert,
  type RunListFilter,
  type RunLogSize,
  type RunPruneFilter,
  type RunRow,
  type RunRowsRead,
  setRunLogBytes,
  setRunPid,
} from '../db/db';

/** The ledger's only door to sql — every other file in `ledger/` goes through this. */
@Injectable()
export class RunStore {
  insert(row: RunInsert): void {
    insertRunRow(row);
  }

  setPid(runId: string, pid: number | null): void {
    setRunPid(runId, pid);
  }

  finish(runId: string, finish: RunFinish): void {
    finishRunRow(runId, finish);
  }

  setLogBytes(runId: string, bytes: number): void {
    setRunLogBytes(runId, bytes);
  }

  get(runId: string): RunRow | undefined {
    return getRunRow(runId);
  }

  list(filter: RunListFilter): RunRowsRead {
    return listRunRows(filter);
  }

  running(section?: RunSection): RunRowsRead {
    return listRunningRunRows(section);
  }

  failRunning(finishedAt: number): number {
    return failRunningRunRows(finishedAt);
  }

  cancelRunning(runId: string, finishedAt: number): boolean {
    return cancelRunningRunRow(runId, finishedAt);
  }

  allIds(): Set<string> {
    return new Set(listRunIds());
  }

  prune(filter: RunPruneFilter): string[] {
    return pruneRunRows(filter);
  }

  remove(runId: string): boolean {
    return deleteRunRow(runId);
  }

  terminalLogSizes(): RunLogSize[] {
    return listTerminalRunLogSizes();
  }
}
