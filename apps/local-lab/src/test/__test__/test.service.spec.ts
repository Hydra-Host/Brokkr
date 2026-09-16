import { BadRequestException, ConflictException, NotFoundException, StreamableFile } from '@nestjs/common';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hubApiFetch, simDeviceUuid } from '../../common/hub-client';
import { type Run, type RunSection } from '../../contract';
import { closeDb, getDb, getRunRow, insertRunRow, type RunInsert } from '../../db/db';
import { RunLedgerService } from '../../ledger/run-ledger.service';
import { RunLogStore, runLogPath } from '../../ledger/run-log-store';
import { RunStore } from '../../ledger/run-store';
import { RESULTS_ROOT } from '../../results-root';
import { RunnerService, type RunState } from '../../runner/runner.service';
import { RunsService } from '../../runs/runs.service';
import { TestService } from '../test.service';

vi.mock('../../results-root', async (importOriginal) => {
  vi.stubEnv('LOCAL_BROKKR_ALLURE', mkdtempSync(join(tmpdir(), 'lab-test-results-')));
  return importOriginal<typeof import('../../results-root')>();
});
vi.mock('../../common/hub-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../common/hub-client')>();
  return { ...actual, hubApiSignIn: vi.fn(() => Promise.resolve(new Map())), hubApiFetch: vi.fn() };
});

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'lab-test-state-'));
  vi.stubEnv('LOCAL_STATE', stateDir);
  for (const d of readdirSync(RESULTS_ROOT)) rmSync(join(RESULTS_ROOT, d), { recursive: true, force: true });
});

afterEach(() => {
  vi.clearAllMocks();
  closeDb();
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

function seedRun(over: Partial<RunInsert> = {}): string {
  const row: RunInsert = {
    run_id: 'run-x',
    section: 'test',
    op_id: 'smoke',
    label: 'Smoke',
    status: 'running',
    node_index: null,
    started_at: 1,
    finished_at: null,
    exit_code: null,
    pid: null,
    origin_ip: null,
    origin_loopback: null,
    origin_token: null,
    ...over,
  };
  insertRunRow(row);
  return row.run_id;
}

function seedEvent(runId: string, level: string): void {
  getDb()
    .prepare(
      `INSERT INTO run_events (run_id, timestamp, source, level, message, metadata)
       VALUES (?, 1, 'test', ?, 'hi', NULL)`,
    )
    .run(runId, level);
}

function writeLog(runId: string): void {
  mkdirSync(join(stateDir, 'lab', 'runs'), { recursive: true });
  writeFileSync(runLogPath(runId), 'output');
}

function eventCount(runId: string): number {
  return getDb().prepare<[string], { c: number }>(`SELECT COUNT(*) AS c FROM run_events WHERE run_id = ?`).get(runId)!.c;
}

function makeDeps() {
  const createdRuns: RunState[] = [];
  const runner = {
    list: vi.fn((): RunState[] => []),
    create: vi.fn(
      (opts: { section: RunSection; opId: string; label: string; nodeIndex?: number | null }): RunState => {
        const run: RunState = {
          runId: `created-${createdRuns.length}`,
          section: opts.section,
          opId: opts.opId,
          label: opts.label,
          status: 'running',
          startedAt: 1,
          exitCode: null,
          log$: new Subject<string>(),
          lines: [],
          bytes: 0,
          nodeIndex: opts.nodeIndex ?? null,
        };
        createdRuns.push(run);
        return run;
      },
    ),
    emit: vi.fn(),
    spawn: vi.fn((_run: RunState, _cmd: string, _args: string[]): Promise<number> => Promise.resolve(0)),
    spawnPty: vi.fn(
      (_run: RunState, _cmd: string, _args: string[], _env?: Record<string, string>): Promise<number | null> =>
        Promise.resolve(0),
    ),
    finalize: vi.fn(),
    cancel: vi.fn(() => true),
    getRun: vi.fn(),
    remove: vi.fn(),
  };
  const roster = {
    defs: vi.fn(() => Promise.resolve([])),
  };
  const pc = {
    logFile: vi.fn((id: string) => `/tmp/${id}.log`),
  };
  const overlay = {
    planes: vi.fn(() => ({ vm: true, baremetal: false })),
  };
  const fleet = {
    nodeNames: vi.fn(() => ['cpu-1', 'cpu-2']),
    baremetalView: vi.fn(() => ({
      nodes: [{ name: 'metal-1', pxe_mac: '9c:6b:00:8d:e8:b4', bmc_ip: '192.168.1.50', zone: null }],
    })),
  };
  const exec = {
    devPubkey: vi.fn(() => ({ pubkey: null })),
  };
  const pg = {
    getStorageLayouts: vi.fn((_deviceId: string): Promise<Record<string, unknown> | null> => Promise.resolve(null)),
  };
  const ledger = {
    forget: vi.fn((_runId: string): boolean => true),
  };
  return { runner, roster, pc, overlay, fleet, exec, pg, ledger, createdRuns };
}

function build(deps: ReturnType<typeof makeDeps>, ledger: unknown, runs: unknown): TestService {
  return new TestService(
    deps.runner as unknown as RunnerService,
    deps.roster as never,
    deps.pc as never,
    deps.overlay as never,
    deps.fleet as never,
    deps.exec as never,
    deps.pg as never,
    ledger as never,
    runs as never,
  );
}

function makeService() {
  const deps = makeDeps();
  const runs = { active: vi.fn((): Run[] => []) };
  return { svc: build(deps, deps.ledger, runs), ...deps, runs };
}

function makeLedgerBackedService() {
  const deps = makeDeps();
  const rows = new RunStore();
  const logs = new RunLogStore();
  const ledger = new RunLedgerService(rows, logs);
  const idle = { list: (): [] => [], getRun: (): undefined => undefined, cancel: (): boolean => false };
  const runs = new RunsService(idle as unknown as RunnerService, rows, logs);
  return { svc: build(deps, ledger, runs), ...deps, ledger, logs, runs };
}

describe('TestService launch-chain failure handling', () => {
  it('finalizes with exit 1 when the launch chain throws', async () => {
    const { svc, runner, createdRuns } = makeService();
    runner.spawnPty.mockRejectedValue(new Error('spawn ENOENT: npx'));

    svc.start('smoke');

    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalledWith(createdRuns[0], 1));
    expect(runner.emit).toHaveBeenCalledWith(createdRuns[0], expect.stringContaining('run failed'));
  });
});

describe('TestService.start run identity', () => {
  it('mints the run with the scenario id as its opId, never the derived label', () => {
    const { svc, createdRuns } = makeService();

    svc.start('layer-test', null, { base: 'ubuntu-24.04', customizations: { gpuDriver: ['nvidia-570'] } });

    expect(createdRuns[0]?.opId).toBe('layer-test');
    expect(createdRuns[0]?.label).toBe('Layer Composition . ubuntu-24.04 nvidia-570');
  });

  it('keeps the opId stable when the label carries the pinned node', () => {
    const { svc, createdRuns } = makeService();

    svc.start('lifecycle-quick', 1);

    expect(createdRuns[0]?.opId).toBe('lifecycle-quick');
    expect(createdRuns[0]?.label).toBe('Lifecycle: quick [cpu-2]');
  });
});

describe('TestService.start results dir', () => {
  it('creates the dir without writing any run metadata into it', () => {
    const { svc } = makeService();

    const runId = svc.start('smoke');

    expect(readdirSync(join(RESULTS_ROOT, `${runId}-results`))).toEqual([]);
  });

  it('resets the pinned node before launching vitest', async () => {
    const { svc, runner } = makeService();
    runner.spawn.mockImplementation(() => new Promise<number>(() => {}));

    svc.start('lifecycle-quick', 0);

    await vi.waitFor(() =>
      expect(runner.spawn).toHaveBeenCalledWith(expect.anything(), 'python', ['-m', 'local.reset_device', 'cpu-1']),
    );
    expect(runner.spawnPty).not.toHaveBeenCalled();
  });
});

describe('TestService.scenarios', () => {
  it('exposes only the public scenario fields', () => {
    const { svc } = makeService();
    const scenarios = svc.scenarios();
    expect(scenarios.length).toBeGreaterThan(0);
    for (const s of scenarios) {
      expect(s).not.toHaveProperty('vitestFile');
      expect(s).not.toHaveProperty('live');
    }
  });
});

describe('TestService.result', () => {
  it('throws NotFound for a run unknown to both disk and the ledger', () => {
    const { svc } = makeService();
    expect(() => svc.result('nope')).toThrow(NotFoundException);
  });

  it('throws NotFound for a run another section owns', () => {
    const { svc } = makeService();
    seedRun({ run_id: 'stack-run', section: 'stack', op_id: 'db-drift', label: 'Drift' });

    expect(() => svc.result('stack-run')).toThrow(NotFoundException);
  });

  it('still serves a legacy results dir that has no ledger row', () => {
    const { svc } = makeService();
    mkdirSync(join(RESULTS_ROOT, 'legacy-run-results'), { recursive: true });

    expect(svc.result('legacy-run').runId).toBe('legacy-run');
  });

  it('returns a zeroed summary, empty tests, and the ordered non-empty run logs for a finished run', () => {
    const { svc } = makeService();
    const dir = join(RESULTS_ROOT, 'run-x-results');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cc-test-output.log'), 'test output body');
    writeFileSync(join(dir, 'cc-spoke.log'), 'spoke output');
    writeFileSync(join(dir, 'cc-hub.log'), 'hub output');
    writeFileSync(join(dir, 'cc-empty.log'), '');
    writeFileSync(join(dir, 'stale-allure-result.json'), '{}');

    const detail = svc.result('run-x');

    expect(detail.summary).toEqual({ total: 0, passed: 0, failed: 0, broken: 0, skipped: 0, unknown: 0 });
    expect(detail.tests).toEqual([]);
    expect(detail.runLogs).toEqual([
      { name: 'hub', source: 'cc-hub.log', type: 'text/plain' },
      { name: 'spoke', source: 'cc-spoke.log', type: 'text/plain' },
      { name: 'test output', source: 'cc-test-output.log', type: 'text/plain' },
    ]);
  });
});

describe('TestService.result vitest json reporter', () => {
  const writeReport = (runId: string, report: unknown) => {
    const dir = join(RESULTS_ROOT, `${runId}-results`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'results.json'), JSON.stringify(report));
  };

  it('maps assertion results onto cases and counts them', () => {
    const { svc } = makeService();
    writeReport('run-json', {
      testResults: [
        {
          name: '/repo/tests/ts-e2e/test-smoke.test.ts',
          status: 'failed',
          message: '',
          assertionResults: [
            { fullName: 'smoke hub up', title: 'hub up', status: 'passed', duration: 12, failureMessages: [] },
            {
              fullName: 'smoke dhcp configured',
              title: 'dhcp configured',
              status: 'failed',
              duration: 4,
              failureMessages: ['AssertionError: dhcpMode is null, want PROXY\n    at foo (bar.ts:1:1)'],
            },
            { fullName: 'smoke vm roster', title: 'vm roster', status: 'skipped', failureMessages: [] },
          ],
        },
      ],
    });

    const detail = svc.result('run-json');

    expect(detail.summary).toEqual({ total: 3, passed: 1, failed: 1, broken: 0, skipped: 1, unknown: 0 });
    expect(detail.tests[0]).toMatchObject({ name: 'smoke hub up', status: 'passed', durationMs: 12, message: null });
    expect(detail.tests[1]?.message).toBe('AssertionError: dhcpMode is null, want PROXY');
    expect(detail.tests[1]?.trace).toContain('at foo (bar.ts:1:1)');
    expect(detail.tests[2]).toMatchObject({ status: 'skipped', durationMs: null });
  });

  it('reports a zero-assertion failed suite as one broken case', () => {
    const { svc } = makeService();
    writeReport('run-crash', {
      testResults: [
        {
          name: '/repo/tests/ts-e2e/test-smoke.test.ts',
          status: 'failed',
          message: "TypeError: Cannot read properties of undefined (reading 'name')",
          assertionResults: [],
        },
      ],
    });

    const detail = svc.result('run-crash');

    expect(detail.summary).toMatchObject({ total: 1, broken: 1 });
    expect(detail.tests[0]?.name).toContain('test-smoke.test.ts');
    expect(detail.tests[0]?.message).toContain('Cannot read properties of undefined');
  });

  it('falls back to the zero summary when results.json is unparseable', () => {
    const { svc } = makeService();
    const dir = join(RESULTS_ROOT, 'run-bad-results');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'results.json'), 'not json');

    const detail = svc.result('run-bad');

    expect(detail.summary.total).toBe(0);
    expect(detail.tests).toEqual([]);
  });
});

describe('TestService vm-plane gating', () => {
  it('disables the VM-simulator-only scenarios when the vm plane is off', () => {
    const { svc, overlay } = makeService();
    overlay.planes.mockReturnValue({ vm: false, baremetal: true });

    const byId = new Map(svc.scenarios().map((s) => [s.id, s]));

    expect(byId.get('spoke-failover')?.disabled).toBe(true);
    expect(byId.get('spoke-failover')?.disabledReason).toContain('vm plane is off');
    expect(byId.get('spoke-resume')?.disabled).toBe(true);
    expect(byId.get('lifecycle-quick')?.disabled).toBeUndefined();
  });

  it('leaves them enabled while the vm plane is on', () => {
    const { svc } = makeService();
    const byId = new Map(svc.scenarios().map((s) => [s.id, s]));
    expect(byId.get('spoke-failover')?.disabled).toBeUndefined();
  });

  it('leaves them enabled when both planes are on', () => {
    const { svc, overlay } = makeService();
    overlay.planes.mockReturnValue({ vm: true, baremetal: true });
    const byId = new Map(svc.scenarios().map((s) => [s.id, s]));
    expect(byId.get('spoke-failover')?.disabled).toBeUndefined();
  });

  it('rejects starting a VM-only scenario when the vm plane is off', () => {
    const { svc, overlay } = makeService();
    overlay.planes.mockReturnValue({ vm: false, baremetal: true });
    expect(() => svc.start('spoke-failover', 0)).toThrow(BadRequestException);
  });

  it("resolves 'Auto' to the only bare-metal machine when the vm plane is off", () => {
    const { svc, runner, overlay, fleet } = makeService();
    overlay.planes.mockReturnValue({ vm: false, baremetal: true });
    fleet.nodeNames.mockReturnValue([]);

    svc.start('lifecycle-quick');

    expect(runner.create).toHaveBeenCalledWith({
      section: 'test',
      opId: 'lifecycle-quick',
      label: 'Lifecycle: quick [metal-1]',
      nodeIndex: 0,
    });
  });

  it("rejects 'Auto' when the vm plane is off and more than one machine is saved", () => {
    const { svc, overlay, fleet } = makeService();
    overlay.planes.mockReturnValue({ vm: false, baremetal: true });
    fleet.nodeNames.mockReturnValue([]);
    fleet.baremetalView.mockReturnValue({
      nodes: [
        { name: 'metal-1', pxe_mac: '9c:6b:00:8d:e8:b4', bmc_ip: '192.168.1.50', zone: null },
        { name: 'metal-2', pxe_mac: '9c:6b:00:8d:ea:b4', bmc_ip: '192.168.1.51', zone: null },
      ],
    });

    expect(() => svc.start('lifecycle-quick')).toThrow(BadRequestException);
  });
});

describe('TestService run events', () => {
  it('reads back an event posted for a run', () => {
    const { svc } = makeService();
    seedRun();

    const posted = svc.addEvent('run-x', {
      source: 'saga',
      level: 'success',
      message: 'provisioned',
      metadata: { deviceId: 'd1' },
    });

    expect(posted.id).toBeGreaterThan(0);
    expect(svc.listEvents('run-x')).toEqual([posted]);
  });

  it('keeps each run to its own events', () => {
    const { svc } = makeService();
    seedRun();
    seedRun({ run_id: 'run-y' });

    svc.addEvent('run-x', { source: 'test', level: 'info', message: 'mine' });
    svc.addEvent('run-y', { source: 'test', level: 'info', message: 'yours' });

    expect(svc.listEvents('run-x').map((e) => e.message)).toEqual(['mine']);
    expect(svc.listEvents('run-y').map((e) => e.message)).toEqual(['yours']);
  });

  it('404s an event posted for a run the ledger never recorded', () => {
    const { svc } = makeService();
    getDb();

    expect(() => svc.addEvent('nope', { source: 'test', level: 'info', message: 'm' })).toThrow(NotFoundException);
    expect(() => svc.listEvents('nope')).toThrow(NotFoundException);
  });

  it('404s the test event routes for a run another section owns', () => {
    const { svc } = makeService();
    seedRun({ run_id: 'stack-run', section: 'stack', op_id: 'db-drift', label: 'Drift' });

    expect(() => svc.addEvent('stack-run', { source: 'test', level: 'info', message: 'm' })).toThrow(NotFoundException);
    expect(() => svc.listEvents('stack-run')).toThrow(NotFoundException);
    expect(() => svc.eventStream('stack-run')).toThrow(NotFoundException);
  });

  it('degrades a bogus persisted level to info instead of throwing [BUGBOT 1130751b-6514-4caf-9c84-18ed7d91a747]', () => {
    const { svc } = makeService();
    seedRun({ status: 'passed', finished_at: 2, exit_code: 0 });
    seedEvent('run-x', 'debug');

    const events = svc.listEvents('run-x');

    expect(events).toHaveLength(1);
    expect(events[0]!.level).toBe('info');
  });
});

describe('TestService.attachmentStream', () => {
  it('streams an existing attachment inline as text', async () => {
    const { svc } = makeService();
    const dir = join(RESULTS_ROOT, 'run-x-results');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cc-hub.log'), 'hub output');

    const file = svc.attachmentStream('run-x', 'cc-hub.log');

    expect(file).toBeInstanceOf(StreamableFile);
    expect(file.getHeaders()).toMatchObject({ type: 'text/plain; charset=utf-8', disposition: 'inline' });
    const chunks: Buffer[] = [];
    for await (const chunk of file.getStream()) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('hub output');
  });

  it('throws NotFound for a missing attachment', () => {
    const { svc } = makeService();
    mkdirSync(join(RESULTS_ROOT, 'run-x-results'), { recursive: true });
    expect(() => svc.attachmentStream('run-x', 'cc-missing.log')).toThrow(NotFoundException);
  });

  it('neutralizes a ../ traversal source via basename', () => {
    const { svc } = makeService();
    mkdirSync(join(RESULTS_ROOT, 'run-x-results'), { recursive: true });
    writeFileSync(join(RESULTS_ROOT, 'outside.log'), 'secret');
    expect(() => svc.attachmentStream('run-x', '../outside.log')).toThrow(NotFoundException);
  });
});

describe('TestService purge running-run guard', () => {
  const runInfo = (runId: string, status: Run['status']): Run => ({
    runId,
    section: 'test',
    opId: 'smoke',
    label: runId,
    status,
    startedAt: 1,
    finishedAt: null,
    exitCode: null,
    nodeIndex: null,
    origin: null,
    hasLog: false,
    hasResult: false,
  });

  it('purges a terminal run but leaves a running run untouched', () => {
    const { svc, runner, runs, ledger } = makeService();
    runs.active.mockReturnValue([runInfo('run-live', 'running')]);
    mkdirSync(join(RESULTS_ROOT, 'run-live-results'), { recursive: true });
    mkdirSync(join(RESULTS_ROOT, 'run-done-results'), { recursive: true });

    const purged = svc.purge();

    expect(purged).toBe(1);
    expect(existsSync(join(RESULTS_ROOT, 'run-done-results'))).toBe(false);
    expect(runner.remove).toHaveBeenCalledWith('run-done');
    expect(ledger.forget).toHaveBeenCalledWith('run-done');

    expect(existsSync(join(RESULTS_ROOT, 'run-live-results'))).toBe(true);
    expect(runner.remove).not.toHaveBeenCalledWith('run-live');
    expect(ledger.forget).not.toHaveBeenCalledWith('run-live');
  });

  it('refuses to purge a single run that is still running', () => {
    const { svc, runner, runs, ledger } = makeService();
    runs.active.mockReturnValue([runInfo('run-live', 'running')]);
    mkdirSync(join(RESULTS_ROOT, 'run-live-results'), { recursive: true });

    const purged = svc.purge('run-live');

    expect(purged).toBe(0);
    expect(existsSync(join(RESULTS_ROOT, 'run-live-results'))).toBe(true);
    expect(runner.remove).not.toHaveBeenCalledWith('run-live');
    expect(ledger.forget).not.toHaveBeenCalled();
  });

  it('purges the ledger of a single finished run', () => {
    const { svc, ledger } = makeService();
    mkdirSync(join(RESULTS_ROOT, 'run-done-results'), { recursive: true });

    expect(svc.purge('run-done')).toBe(1);

    expect(ledger.forget).toHaveBeenCalledWith('run-done');
  });
});

describe('TestService.purge path guard', () => {
  it('refuses a traversing run id instead of deleting outside the results root', () => {
    const { svc, runner, ledger } = makeService();
    const outside = join(stateDir, 'escaped-results');
    mkdirSync(outside, { recursive: true });

    expect(() => svc.purge(`../${basename(stateDir)}/escaped`)).toThrow(NotFoundException);

    expect(existsSync(outside)).toBe(true);
    expect(runner.remove).not.toHaveBeenCalled();
    expect(ledger.forget).not.toHaveBeenCalled();
  });

  it('refuses a run id that is not one safe segment', () => {
    const { svc } = makeService();

    expect(() => svc.purge('..')).toThrow(NotFoundException);
    expect(() => svc.purge('a/b')).toThrow(NotFoundException);
  });

  it('removes a scanned dir whose derived id is unsafe without touching the ledger', () => {
    const { svc, runner, ledger } = makeService();
    const sneaky = join(RESULTS_ROOT, '..sneaky-results');
    mkdirSync(sneaky, { recursive: true });

    expect(svc.purge()).toBe(1);

    expect(existsSync(sneaky)).toBe(false);
    expect(runner.remove).not.toHaveBeenCalled();
    expect(ledger.forget).not.toHaveBeenCalled();
  });
});

describe('TestService.purge cross-section guard', () => {
  it('leaves a live run of another section in the runner map and the ledger', () => {
    const { svc, runner, ledger } = makeService();
    runner.getRun.mockReturnValue({ runId: 'shared', section: 'fleet', status: 'running' });
    mkdirSync(join(RESULTS_ROOT, 'shared-results'), { recursive: true });

    expect(svc.purge('shared')).toBe(1);

    expect(existsSync(join(RESULTS_ROOT, 'shared-results'))).toBe(false);
    expect(runner.remove).not.toHaveBeenCalled();
    expect(ledger.forget).not.toHaveBeenCalled();
  });

  it('evicts a live test run the purge does own', () => {
    const { svc, runner, ledger } = makeService();
    runner.getRun.mockReturnValue({ runId: 'mine', section: 'test', status: 'passed' });
    mkdirSync(join(RESULTS_ROOT, 'mine-results'), { recursive: true });

    expect(svc.purge('mine')).toBe(1);

    expect(runner.remove).toHaveBeenCalledWith('mine');
    expect(ledger.forget).toHaveBeenCalledWith('mine');
  });
});

describe('TestService node-conflict guard', () => {
  const seedTerminalRuns = (n: number) => {
    for (let i = 0; i < n; i += 1)
      seedRun({ run_id: `newer-${i}`, status: 'passed', started_at: 1_000 + i, finished_at: 2_000 + i, exit_code: 0 });
  };

  it('blocks a node whose running run sorts past the first page of newer runs', () => {
    const { svc } = makeLedgerBackedService();
    seedRun({ run_id: 'pinned', status: 'running', node_index: 0, started_at: 1 });
    seedTerminalRuns(120);

    expect(() => svc.start('lifecycle-quick', 0)).toThrow(ConflictException);
  });

  it('frees a node whose running row no runner entry backs once the run is cancelled', () => {
    const { svc, runs, runner } = makeLedgerBackedService();
    runner.spawn.mockImplementation(() => new Promise<number>(() => {}));
    seedRun({ run_id: 'wedged', status: 'running', node_index: 0, started_at: 1 });

    expect(() => svc.start('lifecycle-quick', 0)).toThrow(ConflictException);

    expect(runs.cancel('wedged')).toEqual({ cancelled: false });

    expect(svc.start('lifecycle-quick', 0)).toBe('created-0');
  });

  it('starts on a node whose only history is terminal', () => {
    const { svc, runner, createdRuns } = makeLedgerBackedService();
    runner.spawn.mockImplementation(() => new Promise<number>(() => {}));
    seedTerminalRuns(120);

    svc.start('lifecycle-quick', 0);

    expect(createdRuns).toHaveLength(1);
  });
});

describe('TestService purge-all ledger sweep', () => {
  it('sweeps only the test section, leaving every other section its history', () => {
    const { svc } = makeLedgerBackedService();
    seedRun({ run_id: 'test-done', status: 'passed', finished_at: 2, exit_code: 0 });
    seedRun({ run_id: 'stack-done', section: 'stack', op_id: 'up', status: 'passed', finished_at: 2, exit_code: 0 });
    seedRun({ run_id: 'fleet-done', section: 'fleet', op_id: 'power', status: 'passed', finished_at: 2, exit_code: 0 });
    seedEvent('test-done', 'info');
    seedEvent('stack-done', 'info');

    svc.purge();

    expect(getRunRow('test-done')).toBeUndefined();
    expect(eventCount('test-done')).toBe(0);
    expect(getRunRow('stack-done')?.status).toBe('passed');
    expect(getRunRow('fleet-done')?.status).toBe('passed');
    expect(eventCount('stack-done')).toBe(1);
  });

  it('deletes the run log of a row no results dir backs', () => {
    const { svc } = makeLedgerBackedService();
    seedRun({ run_id: 'test-done', status: 'passed', finished_at: 2, exit_code: 0 });
    seedRun({ run_id: 'stack-done', section: 'stack', op_id: 'up', status: 'passed', finished_at: 2, exit_code: 0 });
    writeLog('test-done');
    writeLog('stack-done');

    svc.purge();

    expect(existsSync(runLogPath('test-done'))).toBe(false);
    expect(existsSync(runLogPath('stack-done'))).toBe(true);
  });

  it('leaves a running test run and its events in place', () => {
    const { svc } = makeLedgerBackedService();
    seedRun({ run_id: 'test-live', status: 'running' });
    seedEvent('test-live', 'info');

    svc.purge();

    expect(getRunRow('test-live')?.status).toBe('running');
    expect(eventCount('test-live')).toBe(1);
  });

  it('sweeps ledger-only finished rows while another test is still running', () => {
    const { svc, runs } = makeLedgerBackedService();
    seedRun({ run_id: 'test-live', status: 'running' });
    seedRun({ run_id: 'test-migrated', status: 'passed', finished_at: 2, exit_code: 0 });
    seedEvent('test-migrated', 'info');
    expect(runs.active('test').map((r) => r.runId)).toEqual(['test-live']);

    svc.purge();

    expect(getRunRow('test-migrated')).toBeUndefined();
    expect(eventCount('test-migrated')).toBe(0);
    expect(getRunRow('test-live')?.status).toBe('running');
  });

  it.skipIf(process.getuid?.() === 0)('keeps the row of a results dir it could not delete', () => {
    const { svc } = makeLedgerBackedService();
    seedRun({ run_id: 'test-stuck', status: 'passed', finished_at: 2, exit_code: 0 });
    seedEvent('test-stuck', 'info');
    mkdirSync(join(RESULTS_ROOT, 'test-stuck-results'), { recursive: true });
    chmodSync(RESULTS_ROOT, 0o500);

    try {
      expect(svc.purge()).toBe(0);
    } finally {
      chmodSync(RESULTS_ROOT, 0o700);
    }

    expect(existsSync(join(RESULTS_ROOT, 'test-stuck-results'))).toBe(true);
    expect(getRunRow('test-stuck')?.status).toBe('passed');
    expect(eventCount('test-stuck')).toBe(1);
  });
});

describe('TestService.diskLayoutsNative', () => {
  it('applies contract defaults to sparse storageLayouts', async () => {
    const { svc, pg } = makeService();
    pg.getStorageLayouts.mockResolvedValue({
      configs: [{ disk_group_name: 'SSD_480GB', disk_type: 'ssd', capabilities: ['direct'] }],
    });

    const layouts = await svc.diskLayoutsNative(0);

    expect(layouts.node).toBe('cpu-1');
    expect(layouts.deviceId).toBe(simDeviceUuid(0));
    expect(layouts.configs[0]).toMatchObject({ disk_group_name: 'SSD_480GB', file_systems: [], disks: [] });
    expect(layouts.default).toEqual({ data_disks_groups: [], cold_storage_disks_groups: [] });
  });

  it('rejects malformed storageLayouts naming the shape problem', async () => {
    const { svc, pg } = makeService();
    pg.getStorageLayouts.mockResolvedValue({ configs: 'nope' });

    const failure = await svc.diskLayoutsNative(0).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(BadRequestException);
    expect(failure).toMatchObject({
      message: expect.stringContaining('storageLayouts did not match the expected shape'),
    });
    expect(failure).toMatchObject({ message: expect.stringContaining('configs') });
  });
});

describe('TestService.layerCatalogNative', () => {
  const validBody = {
    lifecycleStatus: 'INVENTORY',
    specs: { gpu: { model: 'NVIDIA H100' } },
    availableBaseLayers: [{ slug: 'ubuntu-22', name: 'Ubuntu 22.04' }],
    availableComponentLayersByBase: {
      'ubuntu-22': [
        {
          slug: 'gpuDriver',
          name: 'GPU Driver',
          selectionType: 'SINGLE_SELECT',
          options: [
            {
              value: 'drv-535',
              label: '535',
              relations: [],
              availability: null,
              hardwareCompatibility: { gpuFamilies: ['hopper'] },
            },
          ],
          rolloutPhase: 'ga',
        },
      ],
    },
  };

  it('maps a valid hub payload into the layer catalog', async () => {
    const { svc } = makeService();
    vi.mocked(hubApiFetch).mockResolvedValue({ code: 200, body: validBody });

    const catalog = await svc.layerCatalogNative(0);

    expect(catalog).toEqual({
      node: 'cpu-1',
      deviceId: simDeviceUuid(0),
      gpuModel: 'NVIDIA H100',
      lifecycleStatus: 'INVENTORY',
      baseLayers: [{ slug: 'ubuntu-22', name: 'Ubuntu 22.04' }],
      componentsByBase: validBody.availableComponentLayersByBase,
    });
  });

  it('unwraps an object-form lifecycleStatus and defaults a missing gpu', async () => {
    const { svc } = makeService();
    vi.mocked(hubApiFetch).mockResolvedValue({
      code: 200,
      body: { lifecycleStatus: { value: 'PROVISIONED' }, availableBaseLayers: [], availableComponentLayersByBase: {} },
    });

    const catalog = await svc.layerCatalogNative(0);

    expect(catalog.lifecycleStatus).toBe('PROVISIONED');
    expect(catalog.gpuModel).toBeNull();
  });

  it('rejects naming the shape problem when the hub payload is malformed', async () => {
    const { svc } = makeService();
    vi.mocked(hubApiFetch).mockResolvedValue({ code: 200, body: { availableBaseLayers: 'nope' } });

    const failure = await svc.layerCatalogNative(0).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(BadRequestException);
    expect(failure).toMatchObject({
      message: expect.stringContaining('layer catalog failed: hub server payload did not match the expected shape'),
    });
    expect(failure).toMatchObject({ message: expect.stringContaining('availableBaseLayers') });
  });
});
