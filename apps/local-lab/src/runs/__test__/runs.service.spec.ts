import { ConflictException, NotFoundException } from '@nestjs/common';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firstValueFrom, toArray } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RunSection } from '../../contract';
import { closeDb, finishRunRow, getDb, getRunRow, insertRunRow } from '../../db/db';
import { RunLedgerService } from '../../ledger/run-ledger.service';
import { RunLogStore } from '../../ledger/run-log-store';
import { RunStore } from '../../ledger/run-store';
import { runLogFrames } from '../../runner/run-log-stream';
import { RunnerService } from '../../runner/runner.service';
import { resultsDir } from '../../results-root';
import { RunsService } from '../runs.service';

vi.mock('../../results-root', async (importOriginal) => {
  vi.stubEnv('LOCAL_BROKKR_ALLURE', mkdtempSync(join(tmpdir(), 'lab-runs-results-')));
  return importOriginal<typeof import('../../results-root')>();
});

const PAGE = { limit: 100, offset: 0 };

let stateDir: string;
let rows: RunStore;
let logs: RunLogStore;
let runner: RunnerService;
let svc: RunsService;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'lab-runs-'));
  vi.stubEnv('LOCAL_STATE', stateDir);
  rows = new RunStore();
  logs = new RunLogStore();
  runner = new RunnerService(new RunLedgerService(rows, logs));
  svc = new RunsService(runner, rows, logs);
});

afterEach(() => {
  vi.restoreAllMocks();
  logs.onApplicationShutdown();
  closeDb();
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

async function finished(
  opts: { section: RunSection; opId: string; label: string; nodeIndex?: number | null },
  output: string,
  code: number,
): Promise<string> {
  const run = runner.create(opts);
  runner.emit(run, output);
  runner.finalize(run, code);
  await vi.waitFor(() => expect(logs.read(run.runId)).toContain(output));
  return run.runId;
}

function unrecorded(startedAt: number): string {
  vi.spyOn(rows, 'insert').mockImplementationOnce(() => {
    throw new Error('database is locked');
  });
  const run = runner.create({ section: 'test', opId: 'smoke', label: 'Smoke' });
  run.startedAt = startedAt;
  return run.runId;
}

function writeResults(runId: string): void {
  const dir = resultsDir(runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'results.json'), '{}');
}

describe('RunsService — a run the runner has dropped', () => {
  it('still lists it from the ledger, with its log flagged retained', async () => {
    const runId = await finished({ section: 'stack', opId: 'reconcile', label: 'reconcile' }, 'healing\n', 0);
    runner.remove(runId);

    const listed = svc.list(PAGE);

    expect(listed.map((r) => r.runId)).toEqual([runId]);
    expect(listed[0]).toMatchObject({ section: 'stack', opId: 'reconcile', status: 'passed', exitCode: 0 });
    expect(listed[0]?.hasLog).toBe(true);
    expect(listed[0]?.finishedAt).toBeGreaterThan(0);
  });

  it('still replays its persisted log, then closes the stream', async () => {
    const runId = await finished({ section: 'test', opId: 'smoke', label: 'Smoke' }, 'vitest output\n', 0);
    runner.remove(runId);

    const frames = await firstValueFrom(runLogFrames(svc.stream(runId)).pipe(toArray()));

    expect(frames).toEqual([{ data: { line: 'vitest output\n' } }, { data: { done: true } }]);
  });

  it('serves it from get() too', async () => {
    const runId = await finished({ section: 'build', opId: 'build-agent', label: 'agent' }, 'built\n', 0);
    runner.remove(runId);

    expect(svc.get(runId)).toMatchObject({ runId, section: 'build', status: 'passed' });
  });

  it('404s the stream once retention has evicted the log', async () => {
    const runId = await finished({ section: 'storage', opId: 'wipe', label: 'wipe' }, 'wiped\n', 0);
    runner.remove(runId);
    logs.remove(runId);

    expect(() => svc.stream(runId)).toThrow(NotFoundException);
  });

  it('404s get() for a run the ledger never held', () => {
    expect(() => svc.get('nope')).toThrow(NotFoundException);
  });
});

describe('RunsService — live state wins over the row', () => {
  it('reports the in-memory status even when the row disagrees', () => {
    const run = runner.create({ section: 'fleet', opId: 'power', label: 'power cpu-1 on' });
    finishRunRow(run.runId, { status: 'failed', exit_code: 9, finished_at: 1, log_bytes: 0, log_truncated: 0 });

    expect(svc.get(run.runId)).toMatchObject({ status: 'running', exitCode: null });
    expect(svc.list(PAGE)[0]).toMatchObject({ status: 'running', exitCode: null });
  });

  it('keeps row-only fields the runner never holds', () => {
    const run = runner.create({ section: 'fleet', opId: 'power', label: 'power cpu-1 on' });
    finishRunRow(run.runId, { status: 'failed', exit_code: 9, finished_at: 4_242, log_bytes: 17, log_truncated: 0 });

    expect(svc.get(run.runId)).toMatchObject({ finishedAt: 4_242, hasLog: true });
  });

  it('applies the status filter to the live status, not the stale row', () => {
    const run = runner.create({ section: 'stack', opId: 'up', label: 'up' });
    finishRunRow(run.runId, { status: 'passed', exit_code: 0, finished_at: 1, log_bytes: 0, log_truncated: 0 });

    expect(svc.list({ ...PAGE, status: 'passed' }).map((r) => r.runId)).not.toContain(run.runId);
  });

  it('projects to the wire shape, leaking no runner internals', () => {
    const run = runner.create({ section: 'stack', opId: 'up', label: 'up' });
    run.childPid = 4242;
    run.cancelled = true;

    const listed = svc.list(PAGE)[0];

    expect(Object.keys(listed ?? {}).sort()).toEqual([
      'exitCode',
      'finishedAt',
      'hasLog',
      'hasResult',
      'label',
      'nodeIndex',
      'opId',
      'origin',
      'runId',
      'section',
      'startedAt',
      'status',
    ]);
  });

  it('lists a run whose ledger insert threw so a busy node never reads free', () => {
    vi.spyOn(rows, 'insert').mockImplementationOnce(() => {
      throw new Error('database is locked');
    });
    const run = runner.create({ section: 'test', opId: 'smoke', label: 'Smoke', nodeIndex: 2 });

    expect(svc.list(PAGE).map((r) => r.runId)).toEqual([run.runId]);
    expect(svc.list(PAGE)[0]).toMatchObject({ status: 'running', nodeIndex: 2, hasLog: false });
  });
});

describe('RunsService.list filters and ordering', () => {
  const seed = async () => ({
    stack: await finished({ section: 'stack', opId: 'reconcile', label: 'reconcile' }, 'a\n', 0),
    fleet: await finished({ section: 'fleet', opId: 'power', label: 'power' }, 'b\n', 1),
    test: await finished({ section: 'test', opId: 'smoke', label: 'Smoke' }, 'c\n', 0),
  });

  it('returns every section newest-first by default', async () => {
    const ids = await seed();

    expect(svc.list(PAGE).map((r) => r.runId)).toEqual([ids.test, ids.fleet, ids.stack]);
  });

  it('narrows by section', async () => {
    const ids = await seed();

    expect(svc.list({ ...PAGE, section: 'fleet' }).map((r) => r.runId)).toEqual([ids.fleet]);
  });

  it('narrows by status', async () => {
    const ids = await seed();

    expect(svc.list({ ...PAGE, status: 'failed' }).map((r) => r.runId)).toEqual([ids.fleet]);
  });

  it('narrows by opId', async () => {
    const ids = await seed();

    expect(svc.list({ ...PAGE, opId: 'smoke' }).map((r) => r.runId)).toEqual([ids.test]);
  });

  it('pages with limit and offset', async () => {
    const ids = await seed();

    expect(svc.list({ limit: 2, offset: 0 }).map((r) => r.runId)).toEqual([ids.test, ids.fleet]);
    expect(svc.list({ limit: 2, offset: 2 }).map((r) => r.runId)).toEqual([ids.stack]);
  });
});

describe('RunsService.list re-adds an unrecorded run to the first page only', () => {
  const seedPage = async () => {
    for (let i = 0; i < 3; i += 1) await finished({ section: 'test', opId: 'smoke', label: `row ${i}` }, 'x\n', 0);
  };

  it('carries it on the first page and on no page after it', async () => {
    await seedPage();
    const live = unrecorded(Date.now() + 10_000);

    expect(svc.list({ limit: 3, offset: 0 }).map((r) => r.runId)).toContain(live);
    expect(svc.list({ limit: 3, offset: 3 }).map((r) => r.runId)).not.toContain(live);
  });

  it('keeps it off a later page even when it is the only run left to show', async () => {
    await seedPage();
    const live = unrecorded(1);

    expect(svc.list({ limit: 3, offset: 3 })).toEqual([]);
    expect(svc.list({ limit: 3, offset: 0 }).map((r) => r.runId)).toContain(live);
  });
});

describe('RunsService.list keeps a recorded live run reachable across pages', () => {
  const longRunner = () => {
    const run = runner.create({ section: 'test', opId: 'smoke', label: 'long runner' });
    run.startedAt = 1;
    return run.runId;
  };

  it('carries it on the page its start time places it on, with live status merged', async () => {
    const live = longRunner();
    for (let i = 0; i < 3; i += 1) await finished({ section: 'test', opId: 'smoke', label: `newer ${i}` }, 'x\n', 0);

    expect(svc.list({ limit: 3, offset: 0 }).map((r) => r.runId)).not.toContain(live);
    const later = svc.list({ limit: 3, offset: 3 });
    expect(later.map((r) => r.runId)).toContain(live);
    expect(later.find((r) => r.runId === live)?.status).toBe('running');
  });

  it('surfaces it on the first page under a running filter and in the unpaged guard read', async () => {
    const live = longRunner();
    for (let i = 0; i < 3; i += 1) await finished({ section: 'test', opId: 'smoke', label: `newer ${i}` }, 'x\n', 0);

    expect(svc.list({ limit: 3, offset: 0, status: 'running' }).map((r) => r.runId)).toContain(live);
    expect(svc.active('test').map((r) => r.runId)).toContain(live);
  });
});

describe('RunsService.list never exceeds the limit', () => {
  it('caps a full page that the re-add would have grown', async () => {
    for (let i = 0; i < 3; i += 1) await finished({ section: 'test', opId: 'smoke', label: `row ${i}` }, 'x\n', 0);
    unrecorded(Date.now() + 10_000);

    expect(svc.list({ limit: 3, offset: 0 })).toHaveLength(3);
  });

  it('drops the oldest row rather than the run only memory holds', async () => {
    const rowIds: string[] = [];
    for (let i = 0; i < 3; i += 1)
      rowIds.push(await finished({ section: 'test', opId: 'smoke', label: `row ${i}` }, 'x\n', 0));
    const live = unrecorded(1);

    const listed = svc.list({ limit: 3, offset: 0 }).map((r) => r.runId);

    expect(listed).toContain(live);
    expect(listed).not.toContain(rowIds[0]);
    expect(listed).toHaveLength(3);
  });

  it('leaves a page under the limit untouched', async () => {
    const runId = await finished({ section: 'test', opId: 'smoke', label: 'row' }, 'x\n', 0);

    expect(svc.list({ limit: 3, offset: 0 }).map((r) => r.runId)).toEqual([runId]);
  });

  it('keeps the newest re-adds when the re-adds alone exceed the limit', () => {
    const oldest = unrecorded(1_000);
    const middle = unrecorded(2_000);
    const newest = unrecorded(3_000);

    const listed = svc.list({ limit: 2, offset: 0 }).map((r) => r.runId);

    expect(listed).toEqual([newest, middle]);
    expect(listed).not.toContain(oldest);
    expect(svc.active('test').map((r) => r.runId).sort()).toEqual([oldest, middle, newest].sort());
  });
});

describe('RunsService.active — the destructive-op guard', () => {
  const running = (section: RunSection, nodeIndex: number | null = null) =>
    runner.create({ section, opId: 'smoke', label: 'Smoke', nodeIndex });

  it('still reports a running run that newer runs pushed off the paged list', async () => {
    insertRunRow({
      run_id: 'older',
      section: 'test',
      op_id: 'smoke',
      label: 'Smoke',
      status: 'running',
      node_index: 3,
      started_at: 1,
      finished_at: null,
      exit_code: null,
      pid: null,
      origin_ip: null,
      origin_loopback: null,
      origin_token: null,
    });
    for (let i = 0; i < 5; i += 1) await finished({ section: 'test', opId: 'smoke', label: `newer ${i}` }, 'x\n', 0);

    expect(svc.list({ section: 'test', limit: 3, offset: 0 }).map((r) => r.runId)).not.toContain('older');
    expect(svc.active('test').map((r) => r.runId)).toEqual(['older']);
    expect(svc.active('test')[0]).toMatchObject({ nodeIndex: 3, status: 'running' });
  });

  it('drops a run the moment it reaches a terminal status', () => {
    const run = running('test');

    expect(svc.active('test').map((r) => r.runId)).toEqual([run.runId]);

    runner.finalize(run, 0);

    expect(svc.active('test')).toEqual([]);
  });

  it('narrows to one section, and reports every section when unscoped', () => {
    const test = running('test');
    const fleet = running('fleet');

    expect(svc.active('test').map((r) => r.runId)).toEqual([test.runId]);
    expect(svc.active('fleet').map((r) => r.runId)).toEqual([fleet.runId]);
    expect(svc.active().map((r) => r.runId).sort()).toEqual([test.runId, fleet.runId].sort());
  });

  it('reports a run whose ledger insert threw, so a busy node never reads free', () => {
    vi.spyOn(rows, 'insert').mockImplementationOnce(() => {
      throw new Error('database is locked');
    });
    const run = running('test', 1);

    expect(svc.active('test').map((r) => r.runId)).toEqual([run.runId]);
    expect(svc.active('test')[0]).toMatchObject({ nodeIndex: 1, status: 'running' });
  });

  it('reports a run the runner has dropped but the ledger still holds as running', () => {
    const run = running('test', 2);
    runner.remove(run.runId);

    expect(svc.active('test').map((r) => r.runId)).toEqual([run.runId]);
    expect(svc.active('test')[0]).toMatchObject({ nodeIndex: 2, status: 'running' });
  });
});

describe('RunsService — a row this build cannot parse', () => {
  const seedUnreadable = (runId: string, status: string) =>
    getDb()
      .prepare(
        `INSERT INTO runs (run_id, section, op_id, label, status, started_at)
         VALUES (?, 'wormhole', 'op', 'from a newer lab', ?, 5)`,
      )
      .run(runId, status);

  it('keeps listing every readable run instead of failing the whole page', async () => {
    const good = await finished({ section: 'stack', opId: 'up', label: 'up' }, 'a\n', 0);
    seedUnreadable('bogus', 'passed');

    expect(svc.list(PAGE).map((r) => r.runId)).toEqual([good]);
  });

  it('404s it rather than throwing out of get()', () => {
    seedUnreadable('bogus', 'passed');

    expect(() => svc.get('bogus')).toThrow(NotFoundException);
  });

  it('keeps the guard answering for the runs it can read', () => {
    const live = runner.create({ section: 'test', opId: 'smoke', label: 'Smoke', nodeIndex: 0 });
    seedUnreadable('bogus-live', 'running');

    expect(svc.active('test').map((r) => r.runId)).toEqual([live.runId]);
  });
});

describe('RunsService origin mapping', () => {
  const seedRow = (runId: string, origin: { ip: string | null; loopback: number | null; token: number | null }) =>
    insertRunRow({
      run_id: runId,
      section: 'stack',
      op_id: 'up',
      label: 'up',
      status: 'passed',
      node_index: null,
      started_at: 1,
      finished_at: 2,
      exit_code: 0,
      pid: null,
      origin_ip: origin.ip,
      origin_loopback: origin.loopback,
      origin_token: origin.token,
    });

  it('is null for a system run with no recorded origin', () => {
    seedRow('sys', { ip: null, loopback: null, token: null });

    expect(svc.get('sys').origin).toBeNull();
  });

  it('maps the integer flags to booleans', () => {
    seedRow('req', { ip: '127.0.0.1', loopback: 1, token: 0 });

    expect(svc.get('req').origin).toEqual({ ip: '127.0.0.1', loopback: true, tokenAuth: false });
  });

  it('keeps a token-authorized non-loopback origin distinguishable', () => {
    seedRow('lan', { ip: '10.0.0.9', loopback: 0, token: 1 });

    expect(svc.get('lan').origin).toEqual({ ip: '10.0.0.9', loopback: false, tokenAuth: true });
  });
});

describe('RunsService.hasResult', () => {
  it('is true only for a test run with results on disk', async () => {
    const testId = await finished({ section: 'test', opId: 'smoke', label: 'Smoke' }, 'a\n', 0);
    const stackId = await finished({ section: 'stack', opId: 'up', label: 'up' }, 'b\n', 0);
    writeResults(testId);
    writeResults(stackId);

    expect(svc.get(testId).hasResult).toBe(true);
    expect(svc.get(stackId).hasResult).toBe(false);
  });

  it('is false for a test run with no results file', async () => {
    const testId = await finished({ section: 'test', opId: 'smoke', label: 'Smoke' }, 'a\n', 0);

    expect(svc.get(testId).hasResult).toBe(false);
  });
});

describe('RunsService.cancel', () => {
  it('404s an unknown run', () => {
    expect(() => svc.cancel('nope')).toThrow(NotFoundException);
  });

  it('409s a run that already reached a terminal status', async () => {
    const runId = await finished({ section: 'stack', opId: 'up', label: 'up' }, 'a\n', 0);

    expect(() => svc.cancel(runId)).toThrow(ConflictException);
  });

  it('force-finalizes a running run it cannot signal, reporting no delivery', () => {
    const run = runner.create({ section: 'stack', opId: 'up', label: 'up' });

    expect(svc.cancel(run.runId)).toEqual({ cancelled: false });

    expect(run.cancelled).toBe(true);
    expect(run.status).toBe('cancelled');
    expect(svc.get(run.runId)).toMatchObject({ status: 'cancelled', exitCode: null });
    expect(getRunRow(run.runId)?.status).toBe('cancelled');
    expect(getRunRow(run.runId)?.finished_at).toBeGreaterThan(0);
  });

  it('leaves a signalled run running until its child exits, reporting delivery', () => {
    const run = runner.create({ section: 'fleet', opId: 'power', label: 'power' });
    run.childPid = 4242;
    vi.spyOn(process, 'kill').mockReturnValue(true);

    expect(svc.cancel(run.runId)).toEqual({ cancelled: true });

    expect(run.status).toBe('running');
    expect(getRunRow(run.runId)?.status).toBe('running');
  });

  it('409s a second cancel of a force-finalized run', () => {
    const run = runner.create({ section: 'stack', opId: 'up', label: 'up' });
    svc.cancel(run.runId);

    expect(() => svc.cancel(run.runId)).toThrow(ConflictException);
  });
});

describe('RunsService.cancel — a ledger row the runner never held', () => {
  const seedStaleRunning = (runId: string, nodeIndex: number | null = null) =>
    insertRunRow({
      run_id: runId,
      section: 'test',
      op_id: 'smoke',
      label: 'Smoke',
      status: 'running',
      node_index: nodeIndex,
      started_at: 1,
      finished_at: null,
      exit_code: null,
      pid: null,
      origin_ip: null,
      origin_loopback: null,
      origin_token: null,
    });

  it('clears the row in one cancel, unblocking the node it pinned', () => {
    seedStaleRunning('wedged', 3);

    expect(svc.cancel('wedged')).toEqual({ cancelled: false });

    expect(getRunRow('wedged')?.status).toBe('cancelled');
    expect(getRunRow('wedged')?.finished_at).toBeGreaterThan(0);
    expect(svc.active('test')).toEqual([]);
  });

  it('409s the second cancel', () => {
    seedStaleRunning('wedged');
    svc.cancel('wedged');

    expect(() => svc.cancel('wedged')).toThrow(ConflictException);
  });

  it('leaves the log accounting of the crashed run alone', () => {
    seedStaleRunning('wedged');
    getDb().prepare(`UPDATE runs SET log_bytes = 42, log_truncated = 1 WHERE run_id = 'wedged'`).run();

    svc.cancel('wedged');

    expect(getRunRow('wedged')).toMatchObject({ log_bytes: 42, log_truncated: 1 });
    expect(svc.get('wedged').hasLog).toBe(true);
  });

  it('makes the row deletable by retention, which the running pin had blocked', () => {
    seedStaleRunning('wedged');

    expect(rows.remove('wedged')).toBe(false);

    svc.cancel('wedged');

    expect(rows.remove('wedged')).toBe(true);
  });
});

describe('RunsService.stream on a live run', () => {
  it('replays the in-memory backlog and follows the live subject', () => {
    const run = runner.create({ section: 'stack', opId: 'up', label: 'up' });
    runner.emit(run, 'first\n');

    const frames: unknown[] = [];
    runLogFrames(svc.stream(run.runId)).subscribe((f) => frames.push(f.data));
    runner.emit(run, 'second\n');
    runner.finalize(run, 0);

    expect(frames).toEqual([
      { line: 'first\n' },
      { line: 'second\n' },
      { line: '\n[exit 0]\n' },
      { done: true },
    ]);
  });
});
