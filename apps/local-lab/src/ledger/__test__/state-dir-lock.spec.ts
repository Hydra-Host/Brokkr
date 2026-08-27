import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { closeDb, getRunRow, insertRunRow } from '../../db/db';
import { AuditStore } from '../audit-store';
import { bootRunLedger } from '../ledger-boot';
import { RunLedgerService } from '../run-ledger.service';
import { RunLogStore } from '../run-log-store';
import { RunResultsStore } from '../run-results-store';
import { RunRetentionService } from '../run-retention.service';
import { RunStore } from '../run-store';
import { StateDirLock } from '../state-dir-lock';

vi.mock('../../results-root', async (importOriginal) => {
  vi.stubEnv('LOCAL_BROKKR_ALLURE', mkdtempSync(join(tmpdir(), 'lab-lock-results-')));
  return importOriginal<typeof import('../../results-root')>();
});

let stateDir: string;
let lock: StateDirLock;
let ledger: RunLedgerService;
let retention: RunRetentionService;
let alive: Set<number>;
let kill: MockInstance<typeof process.kill>;

function lockFile(): string {
  return join(stateDir, 'lab', 'lab.pid');
}

function writeHolder(contents: string): void {
  mkdirSync(join(stateDir, 'lab'), { recursive: true });
  writeFileSync(lockFile(), contents);
}

function seedOrphan(runId: string, pid: number): void {
  insertRunRow({
    run_id: runId,
    section: 'fleet',
    op_id: 'power',
    label: 'power node-1 on',
    status: 'running',
    node_index: null,
    started_at: Date.now() - 60_000,
    finished_at: null,
    exit_code: null,
    pid,
    origin_ip: null,
    origin_loopback: null,
    origin_token: null,
  });
}

function signalledPids(): number[] {
  return kill.mock.calls.filter(([, signal]) => signal !== 0).map(([pid]) => pid);
}

function boot(withLock: StateDirLock = lock): void {
  bootRunLedger(withLock, ledger, retention);
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'lab-lock-'));
  vi.stubEnv('LOCAL_STATE', stateDir);
  vi.stubEnv('LAB_RUNS_RETENTION', 'off');
  alive = new Set<number>();
  kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
    if (!alive.has(Math.abs(pid))) throw new Error(`ESRCH ${pid}`);
    return true;
  });
  lock = new StateDirLock();
  ledger = new RunLedgerService(new RunStore(), new RunLogStore());
  retention = new RunRetentionService(new RunStore(), new AuditStore(), new RunLogStore(), new RunResultsStore());
});

afterEach(() => {
  lock.release();
  vi.restoreAllMocks();
  closeDb();
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

describe('StateDirLock', () => {
  it('takes a state dir nobody holds, recording its own pid', () => {
    expect(lock.acquire()).toBe(true);

    expect(readFileSync(lockFile(), 'utf8').trim()).toBe(String(process.pid));
  });

  it('declines a state dir a live lab already holds', () => {
    alive.add(4242);
    writeHolder('4242\n');

    expect(lock.acquire()).toBe(false);

    expect(readFileSync(lockFile(), 'utf8').trim()).toBe('4242');
  });

  it('takes over the file a dead holder left behind', () => {
    writeHolder('4242\n');

    expect(lock.acquire()).toBe(true);

    expect(readFileSync(lockFile(), 'utf8').trim()).toBe(String(process.pid));
  });

  it('takes over a file holding no readable pid', () => {
    writeHolder('');

    expect(lock.acquire()).toBe(true);
  });

  it('never probes a non-positive holder pid', () => {
    writeHolder('-1\n');

    expect(lock.acquire()).toBe(true);
    expect(kill).not.toHaveBeenCalled();
  });

  it('releases on shutdown so the next boot can take it', () => {
    lock.acquire();

    lock.onApplicationShutdown();

    expect(existsSync(lockFile())).toBe(false);
    expect(new StateDirLock().acquire()).toBe(true);
  });

  it('leaves no staging file in the state dir', () => {
    lock.acquire();

    expect(readdirSync(join(stateDir, 'lab'))).toEqual(['lab.pid']);
  });

  it('is a no-op to release a lock it never took', () => {
    alive.add(4242);
    writeHolder('4242\n');
    lock.acquire();

    lock.release();

    expect(readFileSync(lockFile(), 'utf8').trim()).toBe('4242');
  });
});

describe('bootRunLedger under a live foreign holder', () => {
  it('signals nothing and leaves the other lab its running runs', () => {
    alive.add(4242);
    alive.add(1234);
    writeHolder('4242\n');
    seedOrphan('fleet-1', 1234);

    boot();

    expect(signalledPids()).toEqual([]);
    expect(getRunRow('fleet-1')?.status).toBe('running');
  });

  it('still starts retention, which signals nothing of its own', () => {
    alive.add(4242);
    writeHolder('4242\n');
    const start = vi.spyOn(retention, 'start');

    boot();

    expect(start).toHaveBeenCalledTimes(1);
  });
});

describe('bootRunLedger under a stale holder', () => {
  it('takes the lock over and reconciles the orphans behind it', () => {
    alive.add(1234);
    writeHolder('4242\n');
    seedOrphan('fleet-1', 1234);

    boot();

    expect(signalledPids()).toEqual([-1234]);
    expect(getRunRow('fleet-1')?.status).toBe('orphaned');
  });
});

describe('bootRunLedger after a clean shutdown', () => {
  it('reconciles normally on the next boot', () => {
    boot();
    lock.onApplicationShutdown();
    alive.add(1234);
    seedOrphan('fleet-2', 1234);

    boot(new StateDirLock());

    expect(signalledPids()).toEqual([-1234]);
    expect(getRunRow('fleet-2')?.status).toBe('orphaned');
  });
});
