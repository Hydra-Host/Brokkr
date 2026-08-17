import { Test } from '@nestjs/testing';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { closeDb, getDb, getRunRow, insertRunRow, type RunInsert } from '../../db/db';
import { bootRunLedger } from '../ledger-boot';
import { LedgerModule } from '../ledger.module';
import { RunLedgerService } from '../run-ledger.service';
import { RunLogStore } from '../run-log-store';
import { RunRetentionService } from '../run-retention.service';
import { RunStore } from '../run-store';
import { StateDirLock } from '../state-dir-lock';

vi.mock('../../results-root', async (importOriginal) => {
  vi.stubEnv('LOCAL_BROKKR_ALLURE', mkdtempSync(join(tmpdir(), 'lab-reconcile-results-')));
  return importOriginal<typeof import('../../results-root')>();
});

const DAY_MS = 24 * 60 * 60 * 1000;

const LEGACY_TEST_RUNS_DDL = `
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
`;

let stateDir: string;
let ledger: RunLedgerService;
let alive: Set<number>;
let kill: MockInstance<typeof process.kill>;

function seedRun(over: Partial<RunInsert>): void {
  insertRunRow({
    run_id: 'run-1',
    section: 'fleet',
    op_id: 'power',
    label: 'power node-1 on',
    status: 'running',
    node_index: null,
    started_at: Date.now() - 60_000,
    finished_at: null,
    exit_code: null,
    pid: null,
    origin_ip: null,
    origin_loopback: null,
    origin_token: null,
    ...over,
  });
}

function signalledPids(): number[] {
  return kill.mock.calls.filter(([, signal]) => signal !== 0).map(([pid]) => pid);
}

function seedUnreadableRun(runId: string, pid: number): void {
  getDb()
    .prepare(
      `INSERT INTO runs (run_id, section, op_id, label, status, started_at, pid)
       VALUES (?, 'wormhole', 'op', 'from a newer lab', 'running', ?, ?)`,
    )
    .run(runId, Date.now() - 60_000, pid);
}

function rawStatus(runId: string): string | undefined {
  return getDb().prepare<[string], { status: string }>(`SELECT status FROM runs WHERE run_id = ?`).get(runId)?.status;
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'lab-reconcile-'));
  vi.stubEnv('LOCAL_STATE', stateDir);
  alive = new Set<number>();
  kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
    if (!alive.has(Math.abs(pid))) throw new Error(`ESRCH ${pid}`);
    return true;
  });
  ledger = new RunLedgerService(new RunStore(), new RunLogStore());
});

afterEach(() => {
  vi.restoreAllMocks();
  closeDb();
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

describe('RunLedgerService.reconcileOnBoot — killable sections', () => {
  it('signals a fleet orphan whose pid is still alive', () => {
    alive.add(4242);
    seedRun({ run_id: 'fleet-1', section: 'fleet', pid: 4242 });

    expect(ledger.reconcileOnBoot()).toBe(1);

    expect(signalledPids()).toEqual([-4242]);
    const row = getRunRow('fleet-1');
    expect(row?.status).toBe('failed');
    expect(row?.exit_code).toBeNull();
    expect(row?.finished_at).toBeGreaterThan(0);
  });

  it('signals a test orphan whose pid is still alive', () => {
    alive.add(1234);
    seedRun({ run_id: 'test-1', section: 'test', op_id: 'smoke', pid: 1234 });

    ledger.reconcileOnBoot();

    expect(signalledPids()).toEqual([-1234]);
    expect(getRunRow('test-1')?.status).toBe('failed');
  });

  it('never signals the bare pid of a live process that leads no group', () => {
    alive.add(4242);
    kill.mockImplementation((pid, signal) => {
      if (pid < 0 && signal === 'SIGTERM') throw new Error(`ESRCH ${pid}`);
      if (!alive.has(Math.abs(pid))) throw new Error(`ESRCH ${pid}`);
      return true;
    });
    seedRun({ run_id: 'fleet-1', section: 'fleet', pid: 4242 });

    expect(ledger.reconcileOnBoot()).toBe(1);

    expect(signalledPids()).toEqual([-4242]);
    expect(getRunRow('fleet-1')?.status).toBe('failed');
  });
});

describe('RunLedgerService.reconcileOnBoot — sections that are never signalled', () => {
  it('never signals a stack orphan, even with a live pid', () => {
    alive.add(5150);
    seedRun({ run_id: 'stack-1', section: 'stack', op_id: 'fleet-mode-apply', pid: 5150 });

    ledger.reconcileOnBoot();

    expect(kill).not.toHaveBeenCalled();
    expect(signalledPids()).toEqual([]);
    expect(getRunRow('stack-1')?.status).toBe('failed');
  });

  it('never signals the detached redeploy that restarts the whole stack', () => {
    alive.add(9001);
    seedRun({ run_id: 'redeploy-1', section: 'stack', op_id: 'redeploy', label: 'redeploy', pid: 9001 });

    ledger.reconcileOnBoot();

    expect(kill).not.toHaveBeenCalled();
    expect(getRunRow('redeploy-1')?.status).toBe('failed');
  });

  it('never signals a build orphan', () => {
    alive.add(3001);
    seedRun({ run_id: 'build-1', section: 'build', op_id: 'build-agent', pid: 3001 });

    ledger.reconcileOnBoot();

    expect(kill).not.toHaveBeenCalled();
    expect(getRunRow('build-1')?.status).toBe('failed');
  });

  it('never signals a storage orphan', () => {
    alive.add(3002);
    seedRun({ run_id: 'storage-1', section: 'storage', op_id: 'wipe', pid: 3002 });

    ledger.reconcileOnBoot();

    expect(kill).not.toHaveBeenCalled();
    expect(getRunRow('storage-1')?.status).toBe('failed');
  });

  it('signals only the killable sections when every section is orphaned at once', () => {
    for (const pid of [11, 22, 33, 44, 55]) alive.add(pid);
    seedRun({ run_id: 'a', section: 'stack', pid: 11 });
    seedRun({ run_id: 'b', section: 'fleet', pid: 22 });
    seedRun({ run_id: 'c', section: 'build', pid: 33 });
    seedRun({ run_id: 'd', section: 'storage', pid: 44 });
    seedRun({ run_id: 'e', section: 'test', pid: 55 });

    expect(ledger.reconcileOnBoot()).toBe(5);

    expect(signalledPids().sort((x, y) => x - y)).toEqual([-55, -22]);
    for (const runId of ['a', 'b', 'c', 'd', 'e']) expect(getRunRow(runId)?.status).toBe('failed');
  });
});

describe('RunLedgerService.reconcileOnBoot — pid rails', () => {
  it('does not signal a pid that is already gone', () => {
    seedRun({ run_id: 'fleet-dead', section: 'fleet', pid: 777 });

    ledger.reconcileOnBoot();

    expect(kill).toHaveBeenCalledWith(777, 0);
    expect(signalledPids()).toEqual([]);
    expect(getRunRow('fleet-dead')?.status).toBe('failed');
  });

  it('does not signal a pid older than the 24h recycle window', () => {
    alive.add(4242);
    seedRun({ run_id: 'stale', section: 'test', pid: 4242, started_at: Date.now() - DAY_MS - 60_000 });

    ledger.reconcileOnBoot();

    expect(kill).not.toHaveBeenCalled();
    expect(getRunRow('stale')?.status).toBe('failed');
  });

  it('marks a run with no persisted pid failed without signalling anything', () => {
    seedRun({ run_id: 'no-pid', section: 'fleet', pid: null });

    expect(ledger.reconcileOnBoot()).toBe(1);

    expect(kill).not.toHaveBeenCalled();
    expect(getRunRow('no-pid')?.status).toBe('failed');
  });

  it('refuses to signal a non-positive pid', () => {
    seedRun({ run_id: 'bad-pid', section: 'fleet', pid: 0 });
    seedRun({ run_id: 'worse-pid', section: 'test', pid: -1 });

    ledger.reconcileOnBoot();

    expect(kill).not.toHaveBeenCalled();
    expect(getRunRow('bad-pid')?.status).toBe('failed');
    expect(getRunRow('worse-pid')?.status).toBe('failed');
  });
});

describe('RunLedgerService.reconcileOnBoot — a row this build cannot read', () => {
  it('kills the other orphans and still fails the unreadable row', () => {
    alive.add(4242);
    alive.add(9999);
    seedRun({ run_id: 'fleet-1', section: 'fleet', pid: 4242 });
    seedUnreadableRun('wormhole-1', 9999);

    expect(ledger.reconcileOnBoot()).toBe(2);

    expect(signalledPids()).toEqual([-4242]);
    expect(getRunRow('fleet-1')?.status).toBe('failed');
    expect(rawStatus('wormhole-1')).toBe('failed');
  });

  it('reconciles every readable orphan when several rows are unreadable', () => {
    for (const pid of [11, 22]) alive.add(pid);
    seedUnreadableRun('wormhole-1', 8001);
    seedRun({ run_id: 'fleet-1', section: 'fleet', pid: 11 });
    seedUnreadableRun('wormhole-2', 8002);
    seedRun({ run_id: 'test-1', section: 'test', pid: 22 });

    expect(ledger.reconcileOnBoot()).toBe(4);

    expect(signalledPids().sort((x, y) => x - y)).toEqual([-22, -11]);
    for (const runId of ['wormhole-1', 'wormhole-2', 'fleet-1', 'test-1']) expect(rawStatus(runId)).toBe('failed');
  });
});

describe('RunLedgerService.reconcileOnBoot — log accounting', () => {
  const writeLog = (runId: string, body: string) => {
    mkdirSync(join(stateDir, 'lab', 'runs'), { recursive: true });
    writeFileSync(join(stateDir, 'lab', 'runs', `${runId}.log`), body);
  };

  it('recovers the byte count of a crashed run so retention can reclaim it', () => {
    seedRun({ run_id: 'fleet-1', section: 'fleet', pid: null });
    writeLog('fleet-1', 'partial output\n');

    ledger.reconcileOnBoot();

    expect(getRunRow('fleet-1')?.log_bytes).toBe(15);
  });

  it('leaves a logless orphan at zero', () => {
    seedRun({ run_id: 'fleet-2', section: 'fleet', pid: null });

    ledger.reconcileOnBoot();

    expect(getRunRow('fleet-2')?.log_bytes).toBe(0);
  });
});

describe('RunLedgerService.reconcileOnBoot — repeat boots and backfilled rows', () => {
  it('leaves terminal runs untouched', () => {
    seedRun({ run_id: 'done', section: 'test', status: 'passed', finished_at: 1_000, exit_code: 0, pid: 4242 });
    alive.add(4242);

    expect(ledger.reconcileOnBoot()).toBe(0);

    expect(kill).not.toHaveBeenCalled();
    const row = getRunRow('done');
    expect(row?.status).toBe('passed');
    expect(row?.exit_code).toBe(0);
    expect(row?.finished_at).toBe(1_000);
  });

  it('is idempotent across two boots', () => {
    alive.add(4242);
    seedRun({ run_id: 'fleet-1', section: 'fleet', pid: 4242 });

    expect(ledger.reconcileOnBoot()).toBe(1);
    const afterFirst = getRunRow('fleet-1');
    kill.mockClear();

    expect(ledger.reconcileOnBoot()).toBe(0);

    expect(kill).not.toHaveBeenCalled();
    expect(getRunRow('fleet-1')).toEqual(afterFirst);
  });

  it('reconciles a running run backfilled from the legacy test_runs table', () => {
    mkdirSync(join(stateDir, 'lab'), { recursive: true });
    const legacy = new Database(join(stateDir, 'lab', 'test-tracking.db'));
    legacy.exec(LEGACY_TEST_RUNS_DDL);
    legacy
      .prepare(
        `INSERT INTO test_runs (run_id, scenario_id, label, status, node_index, started_at, finished_at, exit_code)
         VALUES ('legacy-running', 'smoke', 'Smoke', 'running', 1, 1700000000000, NULL, NULL)`,
      )
      .run();
    legacy.close();

    expect(ledger.reconcileOnBoot()).toBe(1);

    const row = getRunRow('legacy-running');
    expect(row?.section).toBe('test');
    expect(row?.status).toBe('failed');
    expect(row?.exit_code).toBeNull();
    expect(row?.pid).toBeNull();
    expect(kill).not.toHaveBeenCalled();
  });

});

describe('RunLedgerService.reconcileOnBoot — never from a lifecycle hook', () => {
  it('leaves an orphan running through the whole module lifecycle', async () => {
    alive.add(4242);
    seedRun({ run_id: 'boot-1', section: 'fleet', pid: 4242 });
    const schedule = vi.spyOn(globalThis, 'setInterval');

    const moduleRef = await Test.createTestingModule({ imports: [LedgerModule] }).compile();
    await moduleRef.init();

    expect(getRunRow('boot-1')?.status).toBe('running');
    expect(kill).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();

    await moduleRef.close();
  });

  it('reconciles once the boot sequence runs it', async () => {
    seedRun({ run_id: 'boot-2', section: 'fleet', pid: null });
    const moduleRef = await Test.createTestingModule({ imports: [LedgerModule] }).compile();
    await moduleRef.init();

    bootRunLedger(moduleRef.get(StateDirLock), moduleRef.get(RunLedgerService), moduleRef.get(RunRetentionService));

    expect(getRunRow('boot-2')?.status).toBe('failed');

    await moduleRef.close();
  });
});
