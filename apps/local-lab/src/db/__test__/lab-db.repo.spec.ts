import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, getRunRow, insertRunRow, listRunningRunRows, listRunRows, type RunInsert } from '../db';

let stateDir: string;

function makeRun(over: Partial<RunInsert> = {}): RunInsert {
  return {
    run_id: 'run-1',
    section: 'test',
    op_id: 'scenario-a',
    label: 'Scenario A',
    status: 'running',
    node_index: null,
    started_at: 1_000,
    finished_at: null,
    exit_code: null,
    pid: null,
    origin_ip: null,
    origin_loopback: null,
    origin_token: null,
    ...over,
  };
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'lab-db-repo-'));
  vi.stubEnv('LOCAL_STATE', stateDir);
});

afterEach(() => {
  closeDb();
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

describe('run ledger row helpers', () => {
  it('round-trips a run and defaults its log accounting', () => {
    insertRunRow(makeRun({ node_index: 3, pid: 4242, origin_ip: '127.0.0.1', origin_loopback: 1, origin_token: 0 }));

    expect(getRunRow('run-1')).toEqual({
      run_id: 'run-1',
      section: 'test',
      op_id: 'scenario-a',
      label: 'Scenario A',
      status: 'running',
      node_index: 3,
      started_at: 1_000,
      finished_at: null,
      exit_code: null,
      pid: 4242,
      origin_ip: '127.0.0.1',
      origin_loopback: 1,
      origin_token: 0,
      log_bytes: 0,
      log_truncated: 0,
    });
  });

  it('returns undefined for an unknown run', () => {
    getDb();
    expect(getRunRow('nope')).toBeUndefined();
  });

  it('accepts a run from any section without a migration', () => {
    insertRunRow(makeRun({ run_id: 'run-storage', section: 'storage', op_id: 'wipe' }));
    expect(getRunRow('run-storage')?.section).toBe('storage');
  });

  it('orders newest first and paginates', () => {
    insertRunRow(makeRun({ run_id: 'a', started_at: 100 }));
    insertRunRow(makeRun({ run_id: 'b', started_at: 300 }));
    insertRunRow(makeRun({ run_id: 'c', started_at: 200 }));

    expect(listRunRows({ limit: 10, offset: 0 }).rows.map((r) => r.run_id)).toEqual(['b', 'c', 'a']);
    expect(listRunRows({ limit: 2, offset: 0 }).rows.map((r) => r.run_id)).toEqual(['b', 'c']);
    expect(listRunRows({ limit: 2, offset: 2 }).rows.map((r) => r.run_id)).toEqual(['a']);
    expect(listRunRows({ limit: 10, offset: 5 }).rows).toEqual([]);
  });

  it('filters by section, status and op id', () => {
    insertRunRow(makeRun({ run_id: 'a', section: 'test', op_id: 'scenario-a', status: 'passed', started_at: 100 }));
    insertRunRow(makeRun({ run_id: 'b', section: 'fleet', op_id: 'fleet-up', status: 'running', started_at: 200 }));
    insertRunRow(makeRun({ run_id: 'c', section: 'test', op_id: 'scenario-b', status: 'running', started_at: 300 }));

    expect(listRunRows({ section: 'test', limit: 10, offset: 0 }).rows.map((r) => r.run_id)).toEqual(['c', 'a']);
    expect(listRunRows({ status: 'running', limit: 10, offset: 0 }).rows.map((r) => r.run_id)).toEqual(['c', 'b']);
    expect(listRunRows({ opId: 'fleet-up', limit: 10, offset: 0 }).rows.map((r) => r.run_id)).toEqual(['b']);
    expect(listRunRows({ section: 'test', status: 'running', limit: 10, offset: 0 }).rows.map((r) => r.run_id)).toEqual([
      'c',
    ]);
    expect(listRunRows({ section: 'build', limit: 10, offset: 0 }).rows).toEqual([]);
  });

});

describe('run ledger reads of a row this build cannot parse', () => {
  const seedUnreadable = (runId: string, startedAt: number) =>
    getDb()
      .prepare(
        `INSERT INTO runs (run_id, section, op_id, label, status, started_at)
         VALUES (?, 'wormhole', 'op', 'from a newer lab', 'passed', ?)`,
      )
      .run(runId, startedAt);

  it('serves the readable rows and counts the rest instead of throwing', () => {
    insertRunRow(makeRun({ run_id: 'a', started_at: 100 }));
    seedUnreadable('bogus', 200);
    insertRunRow(makeRun({ run_id: 'c', started_at: 300 }));

    const read = listRunRows({ limit: 10, offset: 0 });

    expect(read.rows.map((r) => r.run_id)).toEqual(['c', 'a']);
    expect(read.skipped).toBe(1);
  });

  it('reads it as absent rather than throwing on the single-row lookup', () => {
    seedUnreadable('bogus', 1);

    expect(getRunRow('bogus')).toBeUndefined();
  });

  it('counts it in the running read too', () => {
    getDb()
      .prepare(
        `INSERT INTO runs (run_id, section, op_id, label, status, started_at)
         VALUES ('bogus-live', 'wormhole', 'op', 'from a newer lab', 'running', 1)`,
      )
      .run();
    insertRunRow(makeRun({ run_id: 'live', status: 'running' }));

    const read = listRunningRunRows();

    expect(read.rows.map((r) => r.run_id)).toEqual(['live']);
    expect(read.skipped).toBe(1);
  });
});
