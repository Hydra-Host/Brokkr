import { Logger } from '@nestjs/common';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb } from '../db';

const LEGACY_DDL = `
  CREATE TABLE IF NOT EXISTS test_runs (
    run_id      TEXT PRIMARY KEY,
    scenario_id TEXT NOT NULL,
    label       TEXT NOT NULL,
    status      TEXT NOT NULL CHECK(status IN ('running','passed','failed','cancelled')),
    node_index  INTEGER,
    started_at  INTEGER NOT NULL,
    finished_at INTEGER,
    exit_code   INTEGER
  );
  CREATE TABLE IF NOT EXISTS test_events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id    TEXT NOT NULL REFERENCES test_runs(run_id),
    timestamp INTEGER NOT NULL,
    source    TEXT NOT NULL,
    level     TEXT NOT NULL,
    message   TEXT NOT NULL,
    metadata  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_events_run ON test_events(run_id, timestamp);
`;

let stateDir: string;

function dbFile(): string {
  return join(stateDir, 'lab', 'test-tracking.db');
}

function seedLegacyDb(): void {
  mkdirSync(join(stateDir, 'lab'), { recursive: true });
  const raw = new Database(dbFile());
  raw.exec(LEGACY_DDL);
  raw
    .prepare(
      `INSERT INTO test_runs (run_id, scenario_id, label, status, node_index, started_at, finished_at, exit_code)
       VALUES (@run_id, @scenario_id, @label, @status, @node_index, @started_at, @finished_at, @exit_code)`,
    )
    .run({
      run_id: 'legacy-1',
      scenario_id: 'happy-path',
      label: 'Happy path',
      status: 'passed',
      node_index: 2,
      started_at: 1_700_000_000_000,
      finished_at: 1_700_000_060_000,
      exit_code: 0,
    });
  raw
    .prepare(
      `INSERT INTO test_runs (run_id, scenario_id, label, status, node_index, started_at, finished_at, exit_code)
       VALUES (@run_id, @scenario_id, @label, @status, @node_index, @started_at, @finished_at, @exit_code)`,
    )
    .run({
      run_id: 'legacy-2',
      scenario_id: 'boom',
      label: 'Boom',
      status: 'failed',
      node_index: null,
      started_at: 1_700_000_100_000,
      finished_at: 1_700_000_130_000,
      exit_code: 1,
    });
  raw
    .prepare(
      `INSERT INTO test_events (run_id, timestamp, source, level, message, metadata)
       VALUES (@run_id, @timestamp, @source, @level, @message, @metadata)`,
    )
    .run({
      run_id: 'legacy-1',
      timestamp: 1_700_000_001_000,
      source: 'runner',
      level: 'info',
      message: 'started',
      metadata: null,
    });
  raw.close();
}

function userVersion(db: Database.Database): unknown {
  return db.pragma('user_version', { simple: true });
}

function objectNames(db: Database.Database, type: 'table' | 'index'): string[] {
  return db
    .prepare<[string], { name: string }>(`SELECT name FROM sqlite_master WHERE type = ? ORDER BY name`)
    .all(type)
    .map((r) => r.name);
}

function status(db: Database.Database, table: 'runs' | 'test_runs', runId: string): string | undefined {
  return db.prepare<[string], { status: string }>(`SELECT status FROM ${table} WHERE run_id = ?`).get(runId)?.status;
}

function columnNames(db: Database.Database, table: string): string[] {
  return db
    .prepare<[], { name: string }>(`SELECT name FROM pragma_table_info('${table}') ORDER BY name`)
    .all()
    .map((r) => r.name);
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'lab-db-'));
  vi.stubEnv('LOCAL_STATE', stateDir);
});

afterEach(() => {
  closeDb();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

describe('lab sqlite migration ladder', () => {
  it('brings a fresh database up to the latest version', () => {
    const db = getDb();
    expect(userVersion(db)).toBe(3);
    expect(objectNames(db, 'table')).toEqual(
      expect.arrayContaining(['test_runs', 'test_events', 'runs', 'run_events', 'audit_events']),
    );
    expect(columnNames(db, 'test_runs')).toEqual([
      'exit_code',
      'finished_at',
      'label',
      'node_index',
      'run_id',
      'scenario_id',
      'started_at',
      'status',
    ]);
  });

  it('creates every ledger index', () => {
    expect(objectNames(getDb(), 'index')).toEqual(
      expect.arrayContaining([
        'idx_events_run',
        'idx_runs_started',
        'idx_runs_section_started',
        'idx_runs_running',
        'idx_run_events_run',
        'idx_audit_ts',
        'idx_audit_outcome_ts',
      ]),
    );
  });

  it('gives the runs table the ledger columns', () => {
    expect(columnNames(getDb(), 'runs')).toEqual([
      'exit_code',
      'finished_at',
      'label',
      'log_bytes',
      'log_truncated',
      'node_index',
      'op_id',
      'origin_ip',
      'origin_loopback',
      'origin_token',
      'pid',
      'run_id',
      'section',
      'started_at',
      'status',
    ]);
  });

  it('migrates a legacy user_version 0 database without losing rows', () => {
    seedLegacyDb();
    const before = new Database(dbFile());
    expect(userVersion(before)).toBe(0);
    before.close();

    const db = getDb();
    expect(userVersion(db)).toBe(3);
    expect(db.prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM test_runs`).get()?.c).toBe(2);
    expect(db.prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM test_events`).get()?.c).toBe(1);
    expect(
      db.prepare<[string], { label: string }>(`SELECT label FROM test_runs WHERE run_id = ?`).get('legacy-1'),
    ).toEqual({ label: 'Happy path' });
  });

  it('backfills legacy test runs into the ledger as the test section', () => {
    seedLegacyDb();
    const db = getDb();

    expect(
      db
        .prepare<[], { run_id: string; section: string; op_id: string; label: string; status: string }>(
          `SELECT run_id, section, op_id, label, status FROM runs ORDER BY run_id`,
        )
        .all(),
    ).toEqual([
      { run_id: 'legacy-1', section: 'test', op_id: 'happy-path', label: 'Happy path', status: 'passed' },
      { run_id: 'legacy-2', section: 'test', op_id: 'boom', label: 'Boom', status: 'failed' },
    ]);
    expect(db.prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM run_events`).get()?.c).toBe(1);
    expect(
      db.prepare<[], { run_id: string; message: string }>(`SELECT run_id, message FROM run_events`).get(),
    ).toEqual({ run_id: 'legacy-1', message: 'started' });
  });

  it('defaults the backfilled log accounting columns', () => {
    seedLegacyDb();
    expect(
      getDb()
        .prepare<[string], { log_bytes: number; log_truncated: number; pid: number | null }>(
          `SELECT log_bytes, log_truncated, pid FROM runs WHERE run_id = ?`,
        )
        .get('legacy-1'),
    ).toEqual({ log_bytes: 0, log_truncated: 0, pid: null });
  });

  it('leaves the frozen legacy tables in place after the ledger migration', () => {
    seedLegacyDb();
    const db = getDb();
    expect(objectNames(db, 'table')).toEqual(expect.arrayContaining(['test_runs', 'test_events']));
    expect(db.prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM test_runs`).get()?.c).toBe(2);
    expect(db.prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM test_events`).get()?.c).toBe(1);
  });

  it('is a no-op on re-open', () => {
    seedLegacyDb();
    getDb();
    closeDb();

    const db = getDb();
    expect(userVersion(db)).toBe(3);
    expect(db.prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM test_runs`).get()?.c).toBe(2);
    expect(db.prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM test_events`).get()?.c).toBe(1);
    expect(db.prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM runs`).get()?.c).toBe(2);
    expect(db.prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM run_events`).get()?.c).toBe(1);
  });

  it('applies the durability pragmas', () => {
    const db = getDb();
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(db.pragma('synchronous', { simple: true })).toBe(1);
  });

  it('resolves the database path when getDb runs, not at import', () => {
    const db = getDb();
    expect(db.name).toBe(dbFile());
  });

  it('leaves a run the legacy table left running for the boot reconcile to resolve', () => {
    seedLegacyDb();
    const raw = new Database(dbFile());
    raw
      .prepare(
        `INSERT INTO test_runs (run_id, scenario_id, label, status, started_at) VALUES ('orphan', 's', 'l', 'running', 1)`,
      )
      .run();
    raw.close();

    const db = getDb();

    expect(status(db, 'test_runs', 'orphan')).toBe('running');
    expect(status(db, 'runs', 'orphan')).toBe('running');
  });

  it('logs the resolved path and the starting version when it opens the database', () => {
    const debug = vi.spyOn(Logger.prototype, 'debug');

    getDb();

    expect(debug).toHaveBeenCalledWith(`opened ${dbFile()} at schema version 0`);
  });

  it('logs each migration step it applies and the version it reaches', () => {
    const info = vi.spyOn(Logger.prototype, 'log');

    getDb();

    expect(info).toHaveBeenCalledWith('applying migration 1 of 3');
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/^migration 1 applied in \d+ms, schema now at version 1$/));
    expect(info).toHaveBeenCalledWith('applying migration 2 of 3');
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/^migration 2 applied in \d+ms, schema now at version 2$/));
    expect(info).toHaveBeenCalledWith('applying migration 3 of 3');
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/^migration 3 applied in \d+ms, schema now at version 3$/));
  });

  it('stays quiet on an open that applies nothing', () => {
    getDb();
    closeDb();
    const info = vi.spyOn(Logger.prototype, 'log');
    const debug = vi.spyOn(Logger.prototype, 'debug');

    getDb();

    expect(info).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith('schema already at version 3');
  });
});
