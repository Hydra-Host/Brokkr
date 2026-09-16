import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as pty from 'node-pty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { labOriginMiddleware, type OriginRequest } from '../../common/lab-context';
import { closeDb, getDb, getRunRow } from '../../db/db';
import { RunnerService } from '../../runner/runner.service';
import { RunLedgerService } from '../run-ledger.service';
import { RunLogStore, runLogPath } from '../run-log-store';
import { RunStore } from '../run-store';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));

function mockPty(pid: number): { exit: (code?: number) => void } {
  let exitCb: ((e: { exitCode: number; signal?: number }) => void) | undefined;
  const fake = {
    pid,
    onData: vi.fn(),
    onExit: vi.fn((cb: (e: { exitCode: number; signal?: number }) => void) => {
      exitCb = cb;
    }),
    kill: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
  };
  vi.mocked(pty.spawn).mockReturnValue(fake as unknown as ReturnType<typeof pty.spawn>);
  return {
    exit: (code = 0) => exitCb?.({ exitCode: code }),
  };
}

let stateDir: string;
let logs: RunLogStore;
let store: RunStore;
let ledger: RunLedgerService;
let runner: RunnerService;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'lab-ledger-'));
  vi.stubEnv('LOCAL_STATE', stateDir);
  logs = new RunLogStore();
  store = new RunStore();
  ledger = new RunLedgerService(store, logs);
  runner = new RunnerService(ledger);
});

afterEach(async () => {
  await logs.onApplicationShutdown();
  closeDb();
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

function seedEvent(runId: string): void {
  getDb()
    .prepare(
      `INSERT INTO run_events (run_id, timestamp, source, level, message, metadata)
       VALUES (?, 1, 'runner', 'info', 'hello', NULL)`,
    )
    .run(runId);
}

function eventCount(runId: string): number {
  return getDb().prepare<[string], { c: number }>(`SELECT COUNT(*) AS c FROM run_events WHERE run_id = ?`).get(runId)!.c;
}

function loopbackRequest(over: Partial<OriginRequest> = {}): OriginRequest {
  return {
    method: 'POST',
    path: '/api/stack/ops/redeploy',
    query: {},
    socket: { remoteAddress: '127.0.0.1' },
    headers: {},
    ...over,
  };
}

describe('RunLedgerService.onCreate', () => {
  it('writes the row synchronously as the run is minted', () => {
    const before = Date.now();
    const run = runner.create({ section: 'fleet', opId: 'reset', label: 'reset node-1', nodeIndex: 2 });

    const row = getRunRow(run.runId);
    expect(row?.section).toBe('fleet');
    expect(row?.op_id).toBe('reset');
    expect(row?.label).toBe('reset node-1');
    expect(row?.status).toBe('running');
    expect(row?.node_index).toBe(2);
    expect(row?.started_at).toBe(run.startedAt);
    expect(row?.started_at).toBeGreaterThanOrEqual(before);
    expect(row?.finished_at).toBeNull();
    expect(row?.log_bytes).toBe(0);
    expect(row?.log_truncated).toBe(0);
  });

  it('leaves all three origin columns null for a run with no request behind it', () => {
    const run = runner.create({ section: 'stack', opId: 'fleet-planes-apply', label: 'fleet-planes-apply' });

    const row = getRunRow(run.runId);
    expect(row?.origin_ip).toBeNull();
    expect(row?.origin_loopback).toBeNull();
    expect(row?.origin_token).toBeNull();
  });

  it('records the origin of the request that minted the run', () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');
    let runId = '';
    labOriginMiddleware(loopbackRequest({ headers: { 'x-lab-token': 'sekret-token' } }), undefined, () => {
      runId = runner.create({ section: 'stack', opId: 'redeploy', label: 'redeploy' }).runId;
    });

    const row = getRunRow(runId);
    expect(row?.origin_ip).toBe('127.0.0.1');
    expect(row?.origin_loopback).toBe(1);
    expect(row?.origin_token).toBe(1);
  });

  it('records a non-loopback token-authenticated origin', () => {
    let runId = '';
    labOriginMiddleware(loopbackRequest({ socket: { remoteAddress: '10.0.0.5' } }), undefined, () => {
      runId = runner.create({ section: 'build', opId: 'build-agent', label: 'agent' }).runId;
    });

    const row = getRunRow(runId);
    expect(row?.origin_ip).toBe('10.0.0.5');
    expect(row?.origin_loopback).toBe(0);
    expect(row?.origin_token).toBe(0);
  });
});

describe('RunLedgerService.onOutput', () => {
  it('writes the run log and issues no sql', async () => {
    const run = runner.create({ section: 'test', opId: 'smoke', label: 'output' });
    const insert = vi.spyOn(store, 'insert');
    const finish = vi.spyOn(store, 'finish');

    runner.emit(run, 'line one\r\n');
    runner.emit(run, 'line two\r\n');

    expect(insert).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
    expect(getRunRow(run.runId)?.log_bytes).toBe(0);
    await logs.onApplicationShutdown();
    expect(readFileSync(runLogPath(run.runId), 'utf8')).toBe('line one\r\nline two\r\n');
  });
});

describe('RunLedgerService.onFinalize', () => {
  it('persists the terminal status, exit code and log accounting', async () => {
    const run = runner.create({ section: 'test', opId: 'smoke', label: 'finalize' });
    runner.emit(run, 'hello\r\n');

    runner.finalize(run, 3);

    const row = getRunRow(run.runId);
    expect(row?.status).toBe('failed');
    expect(row?.exit_code).toBe(3);
    expect(row?.log_bytes).toBe(7);
    expect(row?.log_truncated).toBe(0);
    expect(row?.finished_at).toBeGreaterThanOrEqual(run.startedAt);
    await vi.waitFor(() => expect(readFileSync(runLogPath(run.runId), 'utf8')).toBe('hello\r\n'));
  });

  it('records a cancelled run and a truncated log', async () => {
    vi.stubEnv('LAB_RUN_LOG_MAX_BYTES', '4');
    const run = runner.create({ section: 'fleet', opId: 'power', label: 'power node-1 on' });
    runner.emit(run, 'abcdefgh');
    run.cancelled = true;

    runner.finalize(run, null);

    const row = getRunRow(run.runId);
    expect(row?.status).toBe('cancelled');
    expect(row?.exit_code).toBeNull();
    expect(row?.log_truncated).toBe(1);
    expect(row?.log_bytes).toBeGreaterThan(8);
    await vi.waitFor(() => expect(readFileSync(runLogPath(run.runId), 'utf8')).toContain('truncated'));
  });

  it('leaves the pid null for a run that never spawned a child', () => {
    const run = runner.create({ section: 'test', opId: 'smoke', label: 'no-child' });

    runner.finalize(run, 0);

    const row = getRunRow(run.runId);
    expect(row?.status).toBe('passed');
    expect(row?.pid).toBeNull();
    expect(row?.log_bytes).toBe(0);
  });
});

describe('RunLedgerService pid durability', () => {
  it('persists the pid while the child is still running, not at finalize', async () => {
    const run = runner.create({ section: 'test', opId: 'smoke', label: 'crash-window' });

    const exit = runner.spawn(run, 'node', ['-e', 'setTimeout(() => undefined, 250)']);
    const midFlight = getRunRow(run.runId);

    expect(midFlight?.pid).toBe(run.childPid);
    expect(midFlight?.pid).toBeGreaterThan(0);
    expect(midFlight?.status).toBe('running');
    expect(midFlight?.finished_at).toBeNull();

    await exit;
  });

  it('keeps the spawned pid on the row after the child exits', async () => {
    const run = runner.create({ section: 'test', opId: 'smoke', label: 'pid-retained' });

    await runner.spawn(run, 'node', ['-e', '']);
    runner.finalize(run, 0);

    expect(run.childPid).toBeUndefined();
    expect(getRunRow(run.runId)?.pid).toBeGreaterThan(0);
  });

  it('persists the pty pid while the child is still running', async () => {
    const ptyChild = mockPty(4242);
    const run = runner.create({ section: 'test', opId: 'smoke', label: 'pty-crash-window' });

    const exit = runner.spawnPty(run, 'node', ['-e', 'setTimeout(() => undefined, 250)']);
    const midFlight = getRunRow(run.runId);

    expect(midFlight?.pid).toBe(run.childPid);
    expect(midFlight?.pid).toBe(4242);
    expect(midFlight?.status).toBe('running');
    expect(midFlight?.finished_at).toBeNull();

    ptyChild.exit(0);
    await exit;
  });

  it('keeps the pty pid on the row after the child exits', async () => {
    const ptyChild = mockPty(4242);
    const run = runner.create({ section: 'test', opId: 'smoke', label: 'pty-pid-retained' });

    const exit = runner.spawnPty(run, 'node', ['-e', '']);
    ptyChild.exit(0);
    await exit;
    runner.finalize(run, 0);

    expect(run.childPid).toBeUndefined();
    expect(getRunRow(run.runId)?.pid).toBe(4242);
  });
});

describe('RunLedgerService.forget', () => {
  it('deletes the row, its events and its log together', async () => {
    const run = runner.create({ section: 'test', opId: 'smoke', label: 'purge me' });
    runner.emit(run, 'output\r\n');
    runner.finalize(run, 0);
    seedEvent(run.runId);
    await vi.waitFor(() => expect(existsSync(runLogPath(run.runId))).toBe(true));

    expect(ledger.forget(run.runId)).toBe(true);

    expect(getRunRow(run.runId)).toBeUndefined();
    expect(eventCount(run.runId)).toBe(0);
    expect(existsSync(runLogPath(run.runId))).toBe(false);
  });

  it('never deletes a running run or its log', async () => {
    const run = runner.create({ section: 'test', opId: 'smoke', label: 'still going' });
    runner.emit(run, 'output\r\n');
    await vi.waitFor(() => expect(existsSync(runLogPath(run.runId))).toBe(true));

    expect(ledger.forget(run.runId)).toBe(false);

    expect(getRunRow(run.runId)?.status).toBe('running');
    expect(existsSync(runLogPath(run.runId))).toBe(true);
  });

  it('reports nothing deleted for a run the ledger never recorded', () => {
    getDb();

    expect(ledger.forget('never-existed')).toBe(false);
  });
});

describe('a throwing ledger', () => {
  it('never breaks create, emit or finalize', () => {
    const boom = (): never => {
      throw new Error('disk full');
    };
    vi.spyOn(store, 'insert').mockImplementation(boom);
    vi.spyOn(store, 'finish').mockImplementation(boom);
    vi.spyOn(logs, 'append').mockImplementation(boom);

    const run = runner.create({ section: 'test', opId: 'smoke', label: 'resilient' });

    expect(run.runId).toBeTruthy();
    expect(() => runner.emit(run, 'still streaming\r\n')).not.toThrow();
    expect(() => runner.finalize(run, 0)).not.toThrow();
    expect(run.status).toBe('passed');
    expect(runner.stream(run.runId).backlog).toBe('still streaming\r\n');
  });
});
