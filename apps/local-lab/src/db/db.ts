import { Logger } from '@nestjs/common';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { type LenientRead, readRows } from '../common/lenient-rows';

import { labStateDir } from '../common/lab-state';
import { parseBoundary } from '../common/pc-schemas';
import { type RunSection, RunSectionSchema, type RunStatus, RunStatusSchema } from '../contract';

const log = new Logger('LabDb');

// `test-tracking.db` is a legacy filename — this database is the lab's run ledger, not the test section's.
function dbLocation(): { dir: string; file: string } {
  const dir = join(labStateDir(), 'lab');
  return { dir, file: join(dir, 'test-tracking.db') };
}

// step 1 is the pre-ladder DDL, verbatim and idempotent: an existing developer database sits at
// user_version = 0 with exactly these tables, so it and a fresh one converge here. never "clean it up".
function m001Legacy(db: Database.Database): void {
  db.exec(`
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
  `);
}

// test_runs and test_events are left in place, frozen: a `git revert` of this work must not lose the
// developer's test history, and copying sidesteps a table rebuild under foreign_keys = ON.
function m002Ledger(db: Database.Database): void {
  db.exec(`
    CREATE TABLE runs (
      run_id          TEXT PRIMARY KEY,
      section         TEXT NOT NULL,     -- deliberately no CHECK: a sixth section must not need a migration
      op_id           TEXT NOT NULL,
      label           TEXT NOT NULL,
      status          TEXT NOT NULL CHECK(status IN ('running','passed','failed','cancelled')),
      node_index      INTEGER,
      started_at      INTEGER NOT NULL,
      finished_at     INTEGER,
      exit_code       INTEGER,
      pid             INTEGER,
      origin_ip       TEXT,
      origin_loopback INTEGER,           -- NULL on all three origin columns => a system run, not a request
      origin_token    INTEGER,
      log_bytes       INTEGER NOT NULL DEFAULT 0,
      log_truncated   INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_runs_started         ON runs(started_at DESC);
    CREATE INDEX idx_runs_section_started ON runs(section, started_at DESC);
    CREATE INDEX idx_runs_running         ON runs(started_at) WHERE status = 'running';

    -- no FK to runs: retention deletes runs independently of their events and audit rows
    CREATE TABLE run_events (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id    TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      source    TEXT NOT NULL,
      level     TEXT NOT NULL,
      message   TEXT NOT NULL,
      metadata  TEXT
    );
    CREATE INDEX idx_run_events_run ON run_events(run_id, timestamp, id);

    CREATE TABLE audit_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      ts              INTEGER NOT NULL,
      method          TEXT NOT NULL,
      path            TEXT NOT NULL,
      handler         TEXT NOT NULL,
      outcome         TEXT NOT NULL CHECK(outcome IN ('ok','error','denied')),
      status_code     INTEGER,
      duration_ms     INTEGER,
      run_id          TEXT,
      origin_ip       TEXT,
      origin_loopback INTEGER,
      origin_token    INTEGER,
      params          TEXT,
      error           TEXT
    );
    CREATE INDEX idx_audit_ts         ON audit_events(ts DESC);
    CREATE INDEX idx_audit_outcome_ts ON audit_events(outcome, ts DESC);

    INSERT OR IGNORE INTO runs
      (run_id, section, op_id, label, status, node_index, started_at, finished_at, exit_code)
      SELECT run_id, 'test', scenario_id, label, status, node_index, started_at, finished_at, exit_code
      FROM test_runs;
    INSERT INTO run_events (run_id, timestamp, source, level, message, metadata)
      SELECT run_id, timestamp, source, level, message, metadata FROM test_events
      WHERE run_id IN (SELECT run_id FROM runs);
  `);
}

// sqlite cannot widen a CHECK in place, so the table is rebuilt. The runs' own indexes follow the
// rename onto the old table and have to be dropped before the new ones can take their names.
function m003OrphanedStatus(db: Database.Database): void {
  db.exec(`
    ALTER TABLE runs RENAME TO runs_pre_orphaned;
    DROP INDEX idx_runs_started;
    DROP INDEX idx_runs_section_started;
    DROP INDEX idx_runs_running;

    CREATE TABLE runs (
      run_id          TEXT PRIMARY KEY,
      section         TEXT NOT NULL,
      op_id           TEXT NOT NULL,
      label           TEXT NOT NULL,
      status          TEXT NOT NULL CHECK(status IN ('running','passed','failed','cancelled','orphaned')),
      node_index      INTEGER,
      started_at      INTEGER NOT NULL,
      finished_at     INTEGER,
      exit_code       INTEGER,
      pid             INTEGER,
      origin_ip       TEXT,
      origin_loopback INTEGER,
      origin_token    INTEGER,
      log_bytes       INTEGER NOT NULL DEFAULT 0,
      log_truncated   INTEGER NOT NULL DEFAULT 0
    );

    INSERT INTO runs
      (run_id, section, op_id, label, status, node_index, started_at, finished_at, exit_code, pid,
       origin_ip, origin_loopback, origin_token, log_bytes, log_truncated)
      SELECT run_id, section, op_id, label, status, node_index, started_at, finished_at, exit_code, pid,
             origin_ip, origin_loopback, origin_token, log_bytes, log_truncated
      FROM runs_pre_orphaned;
    DROP TABLE runs_pre_orphaned;

    CREATE INDEX idx_runs_started         ON runs(started_at DESC);
    CREATE INDEX idx_runs_section_started ON runs(section, started_at DESC);
    CREATE INDEX idx_runs_running         ON runs(started_at) WHERE status = 'running';
  `);
}

const MIGRATIONS: ReadonlyArray<(db: Database.Database) => void> = [m001Legacy, m002Ledger, m003OrphanedStatus];

function userVersion(db: Database.Database): number {
  const raw = db.pragma('user_version', { simple: true });
  return typeof raw === 'number' ? raw : 0;
}

function migrate(db: Database.Database): void {
  const from = userVersion(db);
  let version = from;
  while (version < MIGRATIONS.length) {
    const step = MIGRATIONS[version];
    const next = version + 1;
    const startedAt = Date.now();
    log.log(`applying migration ${next} of ${MIGRATIONS.length}`);
    // user_version lives in the database header and is transactional, so bumping it inside the step's
    // own transaction stops a half-applied migration from being recorded as done.
    db.transaction(() => {
      step(db);
      db.pragma(`user_version = ${next}`);
    })();
    version = next;
    log.log(`migration ${next} applied in ${Date.now() - startedAt}ms, schema now at version ${version}`);
  }
  if (version === from) log.debug(`schema already at version ${version}`);
}

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  const { dir, file } = dbLocation();
  mkdirSync(dir, { recursive: true });
  _db = new Database(file);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('busy_timeout = 5000');
  _db.pragma('synchronous = NORMAL');
  log.debug(`opened ${file} at schema version ${userVersion(_db)}`);
  migrate(_db);
  return _db;
}

export function closeDb(): void {
  if (!_db) return;
  _db.close();
  _db = null;
}

export interface RunRow {
  run_id: string;
  section: RunSection;
  op_id: string;
  label: string;
  status: RunStatus;
  node_index: number | null;
  started_at: number;
  finished_at: number | null;
  exit_code: number | null;
  pid: number | null;
  origin_ip: string | null;
  origin_loopback: number | null;
  origin_token: number | null;
  log_bytes: number;
  log_truncated: number;
}

export interface RunEventRow {
  id: number;
  run_id: string;
  timestamp: number;
  source: string;
  level: string;
  message: string;
  metadata: string | null;
}

export const AuditOutcomeSchema = z.enum(['ok', 'error', 'denied']);
export type AuditOutcome = z.infer<typeof AuditOutcomeSchema>;

export interface AuditEventRow {
  id: number;
  ts: number;
  method: string;
  path: string;
  handler: string;
  outcome: AuditOutcome;
  status_code: number | null;
  duration_ms: number | null;
  run_id: string | null;
  origin_ip: string | null;
  origin_loopback: number | null;
  origin_token: number | null;
  params: string | null;
  error: string | null;
}

const runRowSchema = z.object({
  run_id: z.string(),
  section: RunSectionSchema,
  op_id: z.string(),
  label: z.string(),
  status: RunStatusSchema,
  node_index: z.number().nullable(),
  started_at: z.number(),
  finished_at: z.number().nullable(),
  exit_code: z.number().nullable(),
  pid: z.number().nullable(),
  origin_ip: z.string().nullable(),
  origin_loopback: z.number().nullable(),
  origin_token: z.number().nullable(),
  log_bytes: z.number(),
  log_truncated: z.number(),
}) satisfies z.ZodType<RunRow>;

const runEventRowSchema = z.object({
  id: z.number(),
  run_id: z.string(),
  timestamp: z.number(),
  source: z.string(),
  level: z.string(),
  message: z.string(),
  metadata: z.string().nullable(),
}) satisfies z.ZodType<RunEventRow>;

const auditEventRowSchema = z.object({
  id: z.number(),
  ts: z.number(),
  method: z.string(),
  path: z.string(),
  handler: z.string(),
  outcome: AuditOutcomeSchema,
  status_code: z.number().nullable(),
  duration_ms: z.number().nullable(),
  run_id: z.string().nullable(),
  origin_ip: z.string().nullable(),
  origin_loopback: z.number().nullable(),
  origin_token: z.number().nullable(),
  params: z.string().nullable(),
  error: z.string().nullable(),
}) satisfies z.ZodType<AuditEventRow>;

export type RunInsert = Omit<RunRow, 'log_bytes' | 'log_truncated'>;

export function insertRunRow(row: RunInsert): void {
  getDb()
    .prepare(
      `
    INSERT INTO runs (run_id, section, op_id, label, status, node_index, started_at, finished_at,
                      exit_code, pid, origin_ip, origin_loopback, origin_token)
    VALUES (@run_id, @section, @op_id, @label, @status, @node_index, @started_at, @finished_at,
            @exit_code, @pid, @origin_ip, @origin_loopback, @origin_token)
  `,
    )
    .run(row);
}

export type RunFinish = Pick<RunRow, 'status' | 'exit_code' | 'finished_at' | 'log_bytes' | 'log_truncated'>;

// pid is written by setRunPid while the child is alive and deliberately left alone here: a crash never
// reaches this update, so the spawned pid is what a later boot reconciles an orphan against.
export function setRunPid(runId: string, pid: number | null): void {
  getDb().prepare(`UPDATE runs SET pid = ? WHERE run_id = ?`).run(pid, runId);
}

// one statement rather than a terminal update plus a log-accounting update: a reader must never see a
// row that has finished but still claims zero bytes.
export function finishRunRow(runId: string, finish: RunFinish): void {
  getDb()
    .prepare(
      `
    UPDATE runs SET status = @status, exit_code = @exit_code, finished_at = @finished_at,
                    log_bytes = @log_bytes, log_truncated = @log_truncated
    WHERE run_id = @run_id
  `,
    )
    .run({ run_id: runId, ...finish });
}

export type { LenientRead };
export type RunRowsRead = LenientRead<RunRow>;
export type AuditEventRowsRead = LenientRead<AuditEventRow>;

function readRunRows(raws: unknown[]): RunRowsRead {
  return readRows(runRowSchema, raws);
}

// a crashed run never reaches finishRunRow, so its log is invisible to the retention byte budget
// until the boot reconcile stats the file and writes the size back.
export function setRunLogBytes(runId: string, bytes: number): void {
  getDb().prepare(`UPDATE runs SET log_bytes = ? WHERE run_id = ?`).run(bytes, runId);
}

export function getRunRow(runId: string): RunRow | undefined {
  const raw = getDb().prepare(`SELECT * FROM runs WHERE run_id = ?`).get(runId);
  if (raw === undefined) return undefined;
  const parsed = runRowSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export interface RunListFilter {
  section?: RunSection;
  status?: RunStatus;
  opId?: string;
  limit: number;
  offset: number;
}

export function listRunRows(filter: RunListFilter): RunRowsRead {
  const conditions: string[] = [];
  const params: Record<string, string | number> = { limit: filter.limit, offset: filter.offset };
  if (filter.section !== undefined) {
    conditions.push('section = @section');
    params.section = filter.section;
  }
  if (filter.status !== undefined) {
    conditions.push('status = @status');
    params.status = filter.status;
  }
  if (filter.opId !== undefined) {
    conditions.push('op_id = @opId');
    params.opId = filter.opId;
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return readRunRows(
    getDb()
      .prepare(`SELECT * FROM runs ${where} ORDER BY started_at DESC, run_id DESC LIMIT @limit OFFSET @offset`)
      .all(params),
  );
}

export function listRunningRunRows(section?: RunSection): RunRowsRead {
  return readRunRows(
    getDb()
      .prepare(
        `SELECT * FROM runs WHERE status = 'running' AND (@section IS NULL OR section = @section)
         ORDER BY started_at ASC, run_id ASC`,
      )
      .all({ section: section ?? null }),
  );
}

/** A run left behind by a previous API process: no exit code was ever observed, so it is not the
 *  same outcome as a child that exited non-zero. */
export function failRunningRunRows(finishedAt: number): number {
  return getDb()
    .prepare(`UPDATE runs SET status = 'orphaned', finished_at = ? WHERE status = 'running'`)
    .run(finishedAt).changes;
}

// the per-id sibling of failRunningRunRows, for the operator cancel of a row no live run backs. It
// leaves the log accounting alone: finishRunRow would zero the bytes a crashed run did write.
export function cancelRunningRunRow(runId: string, finishedAt: number): boolean {
  return (
    getDb()
      .prepare(`UPDATE runs SET status = 'cancelled', finished_at = ? WHERE run_id = ? AND status = 'running'`)
      .run(finishedAt, runId).changes > 0
  );
}

export function listRunIds(): string[] {
  return getDb()
    .prepare<[], { run_id: string }>(`SELECT run_id FROM runs`)
    .all()
    .map((row) => row.run_id);
}

export interface RunPruneFilter {
  section: RunSection;
  keep: number;
  startedBefore: number;
}

// victim selection and the delete carry the same `status <> 'running'` pin, so neither the cap nor the
// ttl can evict a live run however old it is.
export function pruneRunRows(filter: RunPruneFilter): string[] {
  const db = getDb();
  return db.transaction(() => {
    const victims = db
      .prepare<RunPruneFilter, { run_id: string }>(
        `
      SELECT run_id FROM runs
      WHERE status <> 'running' AND section = @section
        AND (started_at < @startedBefore
             OR run_id NOT IN (SELECT run_id FROM runs
                               WHERE status <> 'running' AND section = @section
                               ORDER BY started_at DESC, run_id DESC LIMIT @keep))
    `,
      )
      .all(filter)
      .map((row) => row.run_id);
    const deleteRun = db.prepare(`DELETE FROM runs WHERE run_id = ? AND status <> 'running'`);
    const deleteEvents = db.prepare(`DELETE FROM run_events WHERE run_id = ?`);
    const deleted: string[] = [];
    for (const runId of victims) {
      if (deleteRun.run(runId).changes === 0) continue;
      deleteEvents.run(runId);
      deleted.push(runId);
    }
    return deleted;
  })();
}

// carries the same `status <> 'running'` pin as pruneRunRows, so neither an operator purge nor the
// byte budget can delete the row of a child that is still alive.
export function deleteRunRow(runId: string): boolean {
  const db = getDb();
  return db.transaction(() => {
    if (db.prepare(`DELETE FROM runs WHERE run_id = ? AND status <> 'running'`).run(runId).changes === 0) return false;
    db.prepare(`DELETE FROM run_events WHERE run_id = ?`).run(runId);
    return true;
  })();
}

export interface RunLogSize {
  run_id: string;
  section: RunSection;
  log_bytes: number;
}

// oldest first so the byte budget evicts in the same age order as the count cap
export function listTerminalRunLogSizes(): RunLogSize[] {
  return getDb()
    .prepare<
      [],
      RunLogSize
    >(`SELECT run_id, section, log_bytes FROM runs WHERE status <> 'running' ORDER BY started_at ASC, run_id ASC`)
    .all();
}

export function insertAuditEvent(row: Omit<AuditEventRow, 'id'>): void {
  getDb()
    .prepare(
      `
    INSERT INTO audit_events (ts, method, path, handler, outcome, status_code, duration_ms, run_id,
                              origin_ip, origin_loopback, origin_token, params, error)
    VALUES (@ts, @method, @path, @handler, @outcome, @status_code, @duration_ms, @run_id,
            @origin_ip, @origin_loopback, @origin_token, @params, @error)
  `,
    )
    .run(row);
}

export interface AuditListFilter {
  outcome?: AuditOutcome;
  method?: string;
  since?: number;
  limit: number;
  offset: number;
}

// the ts DESC ordering and the outcome predicate are what ride idx_audit_ts and idx_audit_outcome_ts;
// a filter that cannot use one of those two indexes needs a migration, not a scan.
export function listAuditEventRows(filter: AuditListFilter): AuditEventRowsRead {
  const conditions: string[] = [];
  const params: Record<string, string | number> = { limit: filter.limit, offset: filter.offset };
  if (filter.outcome !== undefined) {
    conditions.push('outcome = @outcome');
    params.outcome = filter.outcome;
  }
  if (filter.method !== undefined) {
    conditions.push('method = @method');
    params.method = filter.method;
  }
  if (filter.since !== undefined) {
    conditions.push('ts >= @since');
    params.since = filter.since;
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return readRows(
    auditEventRowSchema,
    getDb()
      .prepare(`SELECT * FROM audit_events ${where} ORDER BY ts DESC, id DESC LIMIT @limit OFFSET @offset`)
      .all(params),
  );
}

export interface AuditPruneFilter {
  keep: number;
  deniedKeep: number;
  before: number;
}

const DENIED_ROWS = `outcome = 'denied'`;
const RECORDED_ROWS = `outcome <> 'denied'`;

// denials get their own budget: a single cap over every row would let an unauthenticated flood of
// rejected requests evict the ok/error history it is there to preserve.
export function pruneAuditEvents(filter: AuditPruneFilter): number {
  const db = getDb();
  return db.transaction(() => {
    const expired = db.prepare(`DELETE FROM audit_events WHERE ts < ?`).run(filter.before).changes;
    return expired + pruneOverCap(db, DENIED_ROWS, filter.deniedKeep) + pruneOverCap(db, RECORDED_ROWS, filter.keep);
  })();
}

// `predicate` is a module constant, never caller input; the per-class ts DESC ordering rides idx_audit_outcome_ts
function pruneOverCap(db: Database.Database, predicate: string, keep: number): number {
  return db
    .prepare(
      `DELETE FROM audit_events WHERE ${predicate} AND id NOT IN
         (SELECT id FROM audit_events WHERE ${predicate} ORDER BY ts DESC, id DESC LIMIT ?)`,
    )
    .run(keep).changes;
}

// feeds the operator's purge-all, scoped to the section that raised it: an unscoped sweep would take
// every other section's history with it. Terminal only, matching the pin in deleteRunRow.
export function listTerminalRunIds(section: RunSection): string[] {
  return getDb()
    .prepare<[RunSection], { run_id: string }>(`SELECT run_id FROM runs WHERE section = ? AND status <> 'running'`)
    .all(section)
    .map((row) => row.run_id);
}

export function insertEvent(row: Omit<RunEventRow, 'id'>): RunEventRow {
  const result = getDb()
    .prepare(
      `
    INSERT INTO run_events (run_id, timestamp, source, level, message, metadata)
    VALUES (@run_id, @timestamp, @source, @level, @message, @metadata)
  `,
    )
    .run(row);
  return { ...row, id: Number(result.lastInsertRowid) };
}

export function getEvents(runId: string): RunEventRow[] {
  return getDb()
    .prepare(`SELECT * FROM run_events WHERE run_id = ? ORDER BY timestamp ASC, id ASC`)
    .all(runId)
    .map((raw) => parseBoundary(runEventRowSchema, raw, 'run_events row'));
}
