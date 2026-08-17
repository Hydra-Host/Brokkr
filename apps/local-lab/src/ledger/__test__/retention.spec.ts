import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { labRunLogDir } from '../../common/lab-state';
import {
  type AuditOutcome,
  closeDb,
  getDb,
  getRunRow,
  insertRunRow,
  listRunRows,
  type RunInsert,
} from '../../db/db';
import { RESULTS_ROOT, resultsDir } from '../../results-root';
import { AuditStore } from '../audit-store';
import { RunLogStore, runLogPath } from '../run-log-store';
import { RunResultsStore } from '../run-results-store';
import { RunRetentionService } from '../run-retention.service';
import { RunStore } from '../run-store';

vi.mock('../../results-root', async (importOriginal) => {
  vi.stubEnv('LOCAL_BROKKR_ALLURE', mkdtempSync(join(tmpdir(), 'lab-retention-results-')));
  return importOriginal<typeof import('../../results-root')>();
});

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

let stateDir: string;
let logs: RunLogStore;
let retention: RunRetentionService;
let now: number;

function seedRun(over: Partial<RunInsert>): void {
  insertRunRow({
    run_id: 'run-1',
    section: 'test',
    op_id: 'smoke',
    label: 'Smoke',
    status: 'passed',
    node_index: null,
    started_at: now - 1_000,
    finished_at: now,
    exit_code: 0,
    pid: null,
    origin_ip: null,
    origin_loopback: null,
    origin_token: null,
    ...over,
  });
}

function seedLog(runId: string, mtimeMs: number = now): string {
  mkdirSync(labRunLogDir(), { recursive: true });
  const path = runLogPath(runId);
  writeFileSync(path, 'output\r\n');
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
  return path;
}

function seedSizedRun(runId: string, startedAt: number, logBytes: number, over: Partial<RunInsert> = {}): void {
  seedRun({ run_id: runId, started_at: startedAt, ...over });
  getDb().prepare(`UPDATE runs SET log_bytes = ? WHERE run_id = ?`).run(logBytes, runId);
}

function seedEvent(runId: string): void {
  getDb()
    .prepare(
      `INSERT INTO run_events (run_id, timestamp, source, level, message, metadata)
       VALUES (?, 1, 'runner', 'info', 'hello', NULL)`,
    )
    .run(runId);
}

function seedAudit(ts: number): void {
  getDb()
    .prepare(
      `INSERT INTO audit_events (ts, method, path, handler, outcome) VALUES (?, 'POST', '/api/fleet', 'power', 'ok')`,
    )
    .run(ts);
}

function eventCount(runId: string): number {
  return getDb().prepare<[string], { c: number }>(`SELECT COUNT(*) AS c FROM run_events WHERE run_id = ?`).get(runId)!.c;
}

function seedAuditRows(count: number, outcome: AuditOutcome, startTs: number): void {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO audit_events (ts, method, path, handler, outcome) VALUES (?, 'POST', '/api/fleet', 'power', ?)`,
  );
  db.transaction(() => {
    for (let i = 0; i < count; i += 1) insert.run(startTs + i, outcome);
  })();
}

function auditCount(): number {
  return getDb().prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM audit_events`).get()!.c;
}

function auditCountOf(outcome: AuditOutcome): number {
  return getDb()
    .prepare<[AuditOutcome], { c: number }>(`SELECT COUNT(*) AS c FROM audit_events WHERE outcome = ?`)
    .get(outcome)!.c;
}

function runIds(): string[] {
  return listRunRows({ limit: 100, offset: 0 }).rows.map((row) => row.run_id);
}

function seedResultsDir(runId: string, mtimeMs: number = now): string {
  const dir = resultsDir(runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cc-hub.log'), 'hub output');
  utimesSync(dir, mtimeMs / 1000, mtimeMs / 1000);
  return dir;
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'lab-retention-'));
  vi.stubEnv('LOCAL_STATE', stateDir);
  now = Date.now();
  logs = new RunLogStore();
  retention = new RunRetentionService(new RunStore(), new AuditStore(), logs, new RunResultsStore());
});

afterEach(() => {
  vi.restoreAllMocks();
  logs.onApplicationShutdown();
  closeDb();
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
  for (const entry of readdirSync(RESULTS_ROOT)) rmSync(join(RESULTS_ROOT, entry), { recursive: true, force: true });
});

describe('RunRetentionService per-section cap', () => {
  it('evicts the oldest runs of one section without touching another', () => {
    vi.stubEnv('LAB_RUNS_KEEP_PER_SECTION', '2');
    seedRun({ run_id: 't1', section: 'test', started_at: now - 4_000 });
    seedRun({ run_id: 't2', section: 'test', started_at: now - 3_000 });
    seedRun({ run_id: 't3', section: 'test', started_at: now - 2_000 });
    seedRun({ run_id: 't4', section: 'test', started_at: now - 1_000 });
    seedRun({ run_id: 'f1', section: 'fleet', started_at: now - 5_000 });
    seedRun({ run_id: 'f2', section: 'fleet', started_at: now - 4_500 });

    expect(retention.sweep(now).runs).toBe(2);

    expect(runIds().sort()).toEqual(['f1', 'f2', 't3', 't4']);
  });

  it('applies the cap independently to every section', () => {
    vi.stubEnv('LAB_RUNS_KEEP_PER_SECTION', '1');
    for (const section of ['stack', 'fleet', 'build', 'storage', 'test', 'queues'] as const) {
      seedRun({ run_id: `${section}-old`, section, started_at: now - 2_000 });
      seedRun({ run_id: `${section}-new`, section, started_at: now - 1_000 });
    }

    expect(retention.sweep(now).runs).toBe(6);

    expect(runIds().sort()).toEqual([
      'build-new',
      'fleet-new',
      'queues-new',
      'stack-new',
      'storage-new',
      'test-new',
    ]);
  });
});

describe('RunRetentionService ttl', () => {
  it('evicts runs older than the ttl even when the cap is not reached', () => {
    vi.stubEnv('LAB_RUNS_TTL_DAYS', '30');
    seedRun({ run_id: 'ancient', started_at: now - 31 * DAY_MS });
    seedRun({ run_id: 'recent', started_at: now - 29 * DAY_MS });

    expect(retention.sweep(now).runs).toBe(1);

    expect(runIds()).toEqual(['recent']);
  });

  it('honours a shortened ttl from the environment', () => {
    vi.stubEnv('LAB_RUNS_TTL_DAYS', '1');
    seedRun({ run_id: 'two-days', started_at: now - 2 * DAY_MS });
    seedRun({ run_id: 'one-hour', started_at: now - HOUR_MS });

    retention.sweep(now);

    expect(runIds()).toEqual(['one-hour']);
  });
});

describe('RunRetentionService never evicts a running run', () => {
  it('keeps the oldest run when it is still running', () => {
    vi.stubEnv('LAB_RUNS_KEEP_PER_SECTION', '1');
    vi.stubEnv('LAB_RUNS_TTL_DAYS', '1');
    seedRun({ run_id: 'live', status: 'running', finished_at: null, exit_code: null, started_at: now - 10 * DAY_MS });
    seedRun({ run_id: 'old', started_at: now - 9 * DAY_MS });
    seedRun({ run_id: 'new', started_at: now - 1_000 });
    const liveLog = seedLog('live', now - 10 * DAY_MS);

    expect(retention.sweep(now).runs).toBe(1);

    expect(getRunRow('live')?.status).toBe('running');
    expect(getRunRow('old')).toBeUndefined();
    expect(getRunRow('new')).toBeDefined();
    expect(existsSync(liveLog)).toBe(true);
  });

  it('keeps a running run that is over the ttl in every section', () => {
    vi.stubEnv('LAB_RUNS_TTL_DAYS', '1');
    for (const section of ['stack', 'fleet', 'build', 'storage', 'test', 'queues'] as const) {
      seedRun({
        run_id: `${section}-live`,
        section,
        status: 'running',
        finished_at: null,
        exit_code: null,
        started_at: now - 400 * DAY_MS,
      });
    }

    expect(retention.sweep(now).runs).toBe(0);

    expect(runIds()).toHaveLength(6);
  });
});

describe('RunRetentionService deletes a run with its events and log', () => {
  it('removes the run_events rows and the .log file of every evicted run', () => {
    vi.stubEnv('LAB_RUNS_TTL_DAYS', '1');
    seedRun({ run_id: 'gone', started_at: now - 2 * DAY_MS });
    seedRun({ run_id: 'kept', started_at: now - 1_000 });
    seedEvent('gone');
    seedEvent('gone');
    seedEvent('kept');
    const goneLog = seedLog('gone', now - 2 * DAY_MS);
    const keptLog = seedLog('kept');

    const swept = retention.sweep(now);

    expect(swept.runs).toBe(1);
    expect(swept.runLogs).toBe(1);
    expect(eventCount('gone')).toBe(0);
    expect(eventCount('kept')).toBe(1);
    expect(existsSync(goneLog)).toBe(false);
    expect(existsSync(keptLog)).toBe(true);
  });

  it('counts a run whose log file was already gone as a row delete only', () => {
    vi.stubEnv('LAB_RUNS_TTL_DAYS', '1');
    seedRun({ run_id: 'no-log', started_at: now - 2 * DAY_MS });

    const swept = retention.sweep(now);

    expect(swept.runs).toBe(1);
    expect(swept.runLogs).toBe(0);
  });
});

describe('RunRetentionService log byte budget', () => {
  it('evicts the oldest terminal runs until the total log bytes fit the budget', () => {
    vi.stubEnv('LAB_RUNS_LOG_BUDGET_BYTES', '25');
    seedSizedRun('old', now - 3_000, 10);
    seedSizedRun('mid', now - 2_000, 10);
    seedSizedRun('new', now - 1_000, 10);
    const oldLog = seedLog('old');
    const midLog = seedLog('mid');

    const swept = retention.sweep(now);

    expect(swept.runs).toBe(1);
    expect(swept.runLogs).toBe(1);
    expect(swept.logBytes).toBe(10);
    expect(runIds().sort()).toEqual(['mid', 'new']);
    expect(existsSync(oldLog)).toBe(false);
    expect(existsSync(midLog)).toBe(true);
  });

  it('never evicts a zero-byte run, which would delete history without freeing any disk', () => {
    vi.stubEnv('LAB_RUNS_LOG_BUDGET_BYTES', '5');
    seedSizedRun('crashed-a', now - 4_000, 0);
    seedSizedRun('crashed-b', now - 3_000, 0);
    seedSizedRun('sized', now - 1_000, 10);
    const sizedLog = seedLog('sized');

    const swept = retention.sweep(now);

    expect(swept.runs).toBe(1);
    expect(swept.logBytes).toBe(10);
    expect(runIds().sort()).toEqual(['crashed-a', 'crashed-b']);
    expect(existsSync(sizedLog)).toBe(false);
  });

  it('keeps evicting across sections until the whole ledger is under budget', () => {
    vi.stubEnv('LAB_RUNS_LOG_BUDGET_BYTES', '10');
    seedSizedRun('fleet-old', now - 4_000, 20, { section: 'fleet' });
    seedSizedRun('test-old', now - 3_000, 20, { section: 'test' });
    seedSizedRun('test-new', now - 1_000, 5, { section: 'test' });

    const swept = retention.sweep(now);

    expect(swept.runs).toBe(2);
    expect(swept.logBytes).toBe(40);
    expect(runIds()).toEqual(['test-new']);
  });

  it('takes the run events of every run it evicts for bytes', () => {
    vi.stubEnv('LAB_RUNS_LOG_BUDGET_BYTES', '1');
    seedSizedRun('fat', now - 1_000, 100);
    seedEvent('fat');

    expect(retention.sweep(now).runs).toBe(1);

    expect(eventCount('fat')).toBe(0);
  });

  it('never evicts a running run to get under budget', () => {
    vi.stubEnv('LAB_RUNS_LOG_BUDGET_BYTES', '1');
    seedSizedRun('live', now - 10 * DAY_MS, 500, { status: 'running', finished_at: null, exit_code: null });
    const liveLog = seedLog('live', now - 10 * DAY_MS);

    const swept = retention.sweep(now);

    expect(swept.runs).toBe(0);
    expect(swept.logBytes).toBe(0);
    expect(getRunRow('live')?.status).toBe('running');
    expect(existsSync(liveLog)).toBe(true);
  });

  it('falls back to the 2 GiB default for a nonsense budget', () => {
    vi.stubEnv('LAB_RUNS_LOG_BUDGET_BYTES', 'as-much-as-it-takes');
    seedSizedRun('big', now - 1_000, 1024 * 1024 * 1024);

    const swept = retention.sweep(now);

    expect(swept.runs).toBe(0);
    expect(runIds()).toEqual(['big']);
  });
});

describe('RunRetentionService audit retention', () => {
  it('evicts audit events over the cap, newest first', () => {
    vi.stubEnv('LAB_AUDIT_KEEP', '2');
    for (const offset of [5_000, 4_000, 3_000, 2_000, 1_000]) seedAudit(now - offset);

    expect(retention.sweep(now).auditEvents).toBe(3);

    expect(auditCount()).toBe(2);
  });

  it('evicts audit events past the audit ttl', () => {
    seedAudit(now - 91 * DAY_MS);
    seedAudit(now - 89 * DAY_MS);

    expect(retention.sweep(now).auditEvents).toBe(1);

    expect(auditCount()).toBe(1);
  });

  it('keeps audit history far longer than run history', () => {
    vi.stubEnv('LAB_RUNS_TTL_DAYS', '30');
    seedRun({ run_id: 'old-run', started_at: now - 60 * DAY_MS });
    seedAudit(now - 60 * DAY_MS);

    const swept = retention.sweep(now);

    expect(swept.runs).toBe(1);
    expect(swept.auditEvents).toBe(0);
    expect(auditCount()).toBe(1);
  });

  it('does not evict audit events when a tight run retention sweeps every run', () => {
    vi.stubEnv('LAB_RUNS_KEEP_PER_SECTION', '1');
    vi.stubEnv('LAB_RUNS_TTL_DAYS', '1');
    seedRun({ run_id: 'a', started_at: now - 2 * DAY_MS });
    seedRun({ run_id: 'b', started_at: now - 3 * DAY_MS });
    for (const offset of [1_000, 2_000, 3_000]) seedAudit(now - offset);

    const swept = retention.sweep(now);

    expect(swept.runs).toBe(2);
    expect(swept.auditEvents).toBe(0);
    expect(auditCount()).toBe(3);
  });
});

describe('RunRetentionService denial cap', () => {
  it('sweeps 6000 ok and 3000 denied rows down to the two default caps', () => {
    seedAuditRows(6_000, 'ok', now - 8_000_000);
    seedAuditRows(3_000, 'denied', now - 4_000_000);

    expect(retention.sweep(now).auditEvents).toBe(3_000);

    expect(auditCountOf('ok')).toBe(5_000);
    expect(auditCountOf('denied')).toBe(1_000);
  });

  it('does not let a flood of denials evict the ok history', () => {
    vi.stubEnv('LAB_AUDIT_KEEP', '100');
    vi.stubEnv('LAB_AUDIT_DENIED_KEEP', '10');
    seedAuditRows(100, 'ok', now - 500_000);
    seedAuditRows(5_000, 'denied', now - 100_000);

    retention.sweep(now);

    expect(auditCountOf('ok')).toBe(100);
    expect(auditCountOf('denied')).toBe(10);
  });

  it('counts the ok cap independently of how many denials share the table', () => {
    vi.stubEnv('LAB_AUDIT_KEEP', '3');
    vi.stubEnv('LAB_AUDIT_DENIED_KEEP', '2');
    seedAuditRows(5, 'ok', now - 50_000);
    seedAuditRows(5, 'error', now - 40_000);
    seedAuditRows(5, 'denied', now - 30_000);

    expect(retention.sweep(now).auditEvents).toBe(10);

    expect(auditCountOf('denied')).toBe(2);
    expect(auditCountOf('ok') + auditCountOf('error')).toBe(3);
  });

  it('still evicts a denial past the audit ttl even under its own cap', () => {
    seedAuditRows(1, 'denied', now - 91 * DAY_MS);
    seedAuditRows(1, 'denied', now - 89 * DAY_MS);

    expect(retention.sweep(now).auditEvents).toBe(1);

    expect(auditCountOf('denied')).toBe(1);
  });
});

describe('RunRetentionService orphan log sweep', () => {
  it('deletes an orphan log only once it is past the 1h grace window', () => {
    getDb();
    const fresh = seedLog('fresh-orphan', now - 60_000);
    const stale = seedLog('stale-orphan', now - 2 * HOUR_MS);

    expect(retention.sweep(now).orphanLogs).toBe(1);

    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(stale)).toBe(false);
  });

  it('leaves the log of any run that still has a row', () => {
    seedRun({ run_id: 'kept', started_at: now - 1_000 });
    seedRun({ run_id: 'live', status: 'running', finished_at: null, exit_code: null, started_at: now - 400 * DAY_MS });
    const keptLog = seedLog('kept', now - 10 * DAY_MS);
    const liveLog = seedLog('live', now - 400 * DAY_MS);

    expect(retention.sweep(now).orphanLogs).toBe(0);

    expect(existsSync(keptLog)).toBe(true);
    expect(existsSync(liveLog)).toBe(true);
  });

  it('leaves a row whose log file is already gone alone', () => {
    seedRun({ run_id: 'logless', started_at: now - 1_000 });

    const swept = retention.sweep(now);

    expect(swept.runs).toBe(0);
    expect(swept.orphanLogs).toBe(0);
    expect(getRunRow('logless')).toBeDefined();
  });

  it('ignores non-log files in the run log directory', () => {
    getDb();
    mkdirSync(labRunLogDir(), { recursive: true });
    const other = join(labRunLogDir(), 'notes.txt');
    writeFileSync(other, 'keep me');
    utimesSync(other, (now - 10 * DAY_MS) / 1000, (now - 10 * DAY_MS) / 1000);

    expect(retention.sweep(now).orphanLogs).toBe(0);

    expect(existsSync(other)).toBe(true);
  });
});

describe('RunRetentionService results dir sweep', () => {
  it('takes the results dir of every pruned test run', () => {
    vi.stubEnv('LAB_RUNS_TTL_DAYS', '1');
    seedRun({ run_id: 'gone', started_at: now - 2 * DAY_MS });
    seedRun({ run_id: 'kept', started_at: now - 1_000 });
    const goneDir = seedResultsDir('gone', now - 2 * DAY_MS);
    const keptDir = seedResultsDir('kept');

    const swept = retention.sweep(now);

    expect(swept.runResults).toBe(1);
    expect(existsSync(goneDir)).toBe(false);
    expect(existsSync(keptDir)).toBe(true);
  });

  it('counts a pruned run whose dir was already gone as a row delete only', () => {
    vi.stubEnv('LAB_RUNS_TTL_DAYS', '1');
    seedRun({ run_id: 'dirless', started_at: now - 2 * DAY_MS });

    const swept = retention.sweep(now);

    expect(swept.runs).toBe(1);
    expect(swept.runResults).toBe(0);
  });

  it('reclaims the dir of a test run the byte budget evicts', () => {
    vi.stubEnv('LAB_RUNS_LOG_BUDGET_BYTES', '1');
    seedSizedRun('fat', now - 2 * HOUR_MS, 100);
    const fatDir = seedResultsDir('fat', now - 2 * HOUR_MS);

    const swept = retention.sweep(now);

    expect(swept.runs).toBe(1);
    expect(swept.runResults).toBe(1);
    expect(existsSync(fatDir)).toBe(false);
  });

  it('reclaims a byte-budget eviction whose dir is still inside the orphan grace', () => {
    vi.stubEnv('LAB_RUNS_LOG_BUDGET_BYTES', '1');
    seedSizedRun('fresh-fat', now - 2 * HOUR_MS, 100);
    const freshDir = seedResultsDir('fresh-fat', now - 60_000);

    const swept = retention.sweep(now);

    expect(swept.runResults).toBe(1);
    expect(swept.orphanResults).toBe(0);
    expect(existsSync(freshDir)).toBe(false);
  });

  it('leaves the byte budget alone for a non-test section that has no results dir', () => {
    vi.stubEnv('LAB_RUNS_LOG_BUDGET_BYTES', '1');
    seedSizedRun('stack-fat', now - 2 * HOUR_MS, 100, { section: 'stack', op_id: 'db-drift' });

    const swept = retention.sweep(now);

    expect(swept.runs).toBe(1);
    expect(swept.runResults).toBe(0);
  });

  it('deletes an orphan results dir only once it is past the grace window', () => {
    getDb();
    const fresh = seedResultsDir('fresh-orphan', now - 60_000);
    const stale = seedResultsDir('stale-orphan', now - 2 * HOUR_MS);

    expect(retention.sweep(now).orphanResults).toBe(1);

    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(stale)).toBe(false);
  });

  it('leaves the results dir of any run that still has a row', () => {
    seedRun({ run_id: 'kept', started_at: now - 1_000 });
    seedRun({ run_id: 'live', status: 'running', finished_at: null, exit_code: null, started_at: now - 400 * DAY_MS });
    const keptDir = seedResultsDir('kept', now - 10 * DAY_MS);
    const liveDir = seedResultsDir('live', now - 400 * DAY_MS);

    expect(retention.sweep(now).orphanResults).toBe(0);

    expect(existsSync(keptDir)).toBe(true);
    expect(existsSync(liveDir)).toBe(true);
  });

  it('ignores anything in the results root that is not a results dir', () => {
    getDb();
    const other = join(RESULTS_ROOT, 'notes.txt');
    writeFileSync(other, 'keep me');
    utimesSync(other, (now - 10 * DAY_MS) / 1000, (now - 10 * DAY_MS) / 1000);

    expect(retention.sweep(now).orphanResults).toBe(0);

    expect(existsSync(other)).toBe(true);
  });
});

describe('RunRetentionService off switch', () => {
  it('sweeps nothing at all when LAB_RUNS_RETENTION=off', () => {
    vi.stubEnv('LAB_RUNS_RETENTION', 'off');
    vi.stubEnv('LAB_RUNS_KEEP_PER_SECTION', '1');
    vi.stubEnv('LAB_RUNS_TTL_DAYS', '1');
    vi.stubEnv('LAB_AUDIT_KEEP', '1');
    vi.stubEnv('LAB_AUDIT_TTL_DAYS', '1');
    seedRun({ run_id: 'a', started_at: now - 400 * DAY_MS });
    seedRun({ run_id: 'b', started_at: now - 300 * DAY_MS });
    seedAudit(now - 400 * DAY_MS);
    seedAudit(now - 300 * DAY_MS);
    const orphan = seedLog('nobody', now - 400 * DAY_MS);
    const orphanDir = seedResultsDir('nobody', now - 400 * DAY_MS);

    expect(retention.sweep(now)).toEqual({
      runs: 0,
      runLogs: 0,
      runResults: 0,
      logBytes: 0,
      auditEvents: 0,
      orphanLogs: 0,
      orphanResults: 0,
    });

    expect(runIds().sort()).toEqual(['a', 'b']);
    expect(auditCount()).toBe(2);
    expect(existsSync(orphan)).toBe(true);
    expect(existsSync(orphanDir)).toBe(true);
  });

  it('registers no interval when retention is off', () => {
    vi.stubEnv('LAB_RUNS_RETENTION', 'off');
    const schedule = vi.spyOn(globalThis, 'setInterval');

    retention.start();

    expect(schedule).not.toHaveBeenCalled();
  });

  it('is case insensitive and tolerates surrounding whitespace', () => {
    vi.stubEnv('LAB_RUNS_RETENTION', '  OFF ');
    vi.stubEnv('LAB_RUNS_TTL_DAYS', '1');
    seedRun({ run_id: 'a', started_at: now - 400 * DAY_MS });

    retention.sweep(now);

    expect(runIds()).toEqual(['a']);
  });
});

describe('RunRetentionService lifecycle', () => {
  it('sweeps once at bootstrap and schedules an unref-ed interval', () => {
    const sweep = vi.spyOn(retention, 'sweep');
    const schedule = vi.spyOn(globalThis, 'setInterval');

    retention.start();

    expect(sweep).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule.mock.results[0]!.value.hasRef()).toBe(false);

    retention.onApplicationShutdown();
  });

  it('clears the interval on shutdown', () => {
    const schedule = vi.spyOn(globalThis, 'setInterval');
    const cancel = vi.spyOn(globalThis, 'clearInterval');

    retention.start();
    retention.onApplicationShutdown();

    expect(cancel).toHaveBeenCalledWith(schedule.mock.results[0]!.value);
  });

  it('sweeps on every interval tick', () => {
    vi.useFakeTimers();
    const sweep = vi.spyOn(retention, 'sweep');

    retention.start();
    vi.advanceTimersByTime(12 * HOUR_MS);

    expect(sweep).toHaveBeenCalledTimes(3);

    retention.onApplicationShutdown();
    vi.useRealTimers();
  });

  it('survives a sweep that throws', () => {
    vi.spyOn(retention, 'sweep').mockImplementation(() => {
      throw new Error('database is locked');
    });

    expect(() => retention.start()).not.toThrow();

    retention.onApplicationShutdown();
  });
});
