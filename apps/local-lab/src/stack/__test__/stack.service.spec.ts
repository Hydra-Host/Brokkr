import { ConflictException, NotFoundException } from '@nestjs/common';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { of, Subject, type Observable } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type RunSection } from '../../contract';
import { NULL_RUN_SINK } from '../../runner/run-sink';
import { RunnerService, type RunInfo, type RunState } from '../../runner/runner.service';
import { swapDiffSet } from '../../services/mode-drift';
import { StackService } from '../stack.service';

vi.mock('../../services/mode-drift', () => ({ swapDiffSet: vi.fn() }));

function makeService() {
  const createdRuns: RunState[] = [];
  const runner = {
    list: vi.fn((): RunInfo[] => []),
    create: vi.fn((opts: { section: RunSection; opId: string; label: string }): RunState => {
      const run: RunState = {
        runId: `created-${opts.label}`,
        section: opts.section,
        opId: opts.opId,
        label: opts.label,
        status: 'running',
        startedAt: 1,
        exitCode: null,
        log$: new Subject<string>(),
        lines: [],
        bytes: 0,
      };
      createdRuns.push(run);
      return run;
    }),
    emit: vi.fn(),
    spawn: vi.fn(
      (
        _run: RunState,
        _cmd: string,
        _args: string[],
        _extraEnv: Record<string, string> = {},
        _opts: { cwd?: string } = {},
      ) => Promise.resolve(0),
    ),
    spawnPty: vi.fn((_run: RunState, _cmd: string, _args: string[]) => Promise.resolve(0)),
    finalize: vi.fn(),
    cancel: vi.fn(() => true),
    getRun: vi.fn(),
  };
  const pc = {
    start: vi.fn((_name: string) => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
    restart: vi.fn(() => Promise.resolve()),
    restartAndWait: vi.fn((_name: string): Promise<boolean> => Promise.resolve(true)),
    processInfo: vi.fn(
      (): Promise<{ Environment: string[] }> => Promise.resolve({ Environment: ['BROKKR_HUB_PRIVATE_KEY=zone-key'] }),
    ),
    ensureRunning: vi.fn(() => Promise.resolve()),
    ensureStopped: vi.fn(() => Promise.resolve()),
    stopAndWait: vi.fn((_name: string): Promise<boolean> => Promise.resolve(true)),
    listAll: vi.fn((): Promise<{ name: string; status: string; is_ready?: string }[]> => Promise.resolve([])),
    logFile: vi.fn((): string => '/dev/null'),
    followFile: vi.fn((): Observable<string> => of()),
  };
  const catalogMap = new Map<string, { namespace: string; label: string; port: number | null; disabled: boolean }>([
    ['postgres', { namespace: 'datastore', label: 'Postgres', port: null, disabled: false }],
    ['redis', { namespace: 'datastore', label: 'Redis', port: null, disabled: false }],
    ['nginx', { namespace: 'datastore', label: 'Nginx', port: null, disabled: false }],
    ['thanos', { namespace: 'datastore', label: 'Thanos', port: null, disabled: false }],
    ['virtqemud', { namespace: 'fleet', label: 'libvirt daemon', port: null, disabled: false }],
  ]);
  const redeploy = {
    stopAll: vi.fn(),
    control: vi.fn(),
  };
  vi.mocked(swapDiffSet).mockReset().mockResolvedValue(['spoke', 'hub-api', 'fleet']);
  const overlay = {
    fleetMode: vi.fn((): 'vm' | 'baremetal' => 'baremetal'),
    bmUplink: vi.fn((): { iface: string; ip: string } | null => ({ iface: 'eth0', ip: '10.0.0.5' })),
  };
  const rendered = {
    dependsGraph: vi.fn(() => Promise.resolve({})),
    catalog: vi.fn(() => Promise.resolve(catalogMap)),
    catalogOrEmpty: vi.fn(() => Promise.resolve(catalogMap)),
    refreshFleetYaml: vi.fn((): Promise<string | null> => Promise.resolve(null)),
    applyOverlay: vi.fn((): Promise<string | null> => Promise.resolve('/repo/config.yaml')),
    buildRenderedConfig: vi.fn((): Promise<string> => Promise.resolve('/repo/config.yaml')),
  };
  const fleetStatus = { status: vi.fn() };
  const fleet = {
    pending: vi.fn(() =>
      Promise.resolve({
        inSync: true,
        severity: 'in-sync',
        desiredDigest: '',
        appliedDigest: null,
        appliedAt: null,
        summary: { added: 0, removed: 0, changed: 0, unchanged: 0 },
        nodes: { added: [], removed: [], changed: [] },
        network: { changed: false, fields: [] },
        note: null,
      }),
    ),
    invalidatePending: vi.fn(),
    modeChangePending: vi.fn((): boolean => true),
  };
  const fleetReset = {
    countActiveSagaJobs: vi.fn((): Promise<number> => Promise.resolve(0)),
  };
  const repoBranch = {
    repoPath: vi.fn((): string | undefined => '/repo'),
  };
  const sudo = {
    preflight: vi.fn((): Promise<{ ok: boolean; reason?: string }> => Promise.resolve({ ok: true })),
  };
  const stackRestart = {
    restartStackDetached: vi.fn((_run: RunState, _opts: { reason: string; wipe?: string }) => Promise.resolve()),
  };
  const svc = new StackService(
    runner as unknown as RunnerService,
    redeploy as never,
    overlay as never,
    rendered as never,
    pc as never,
    fleetStatus as never,
    fleet as never,
    fleetReset as never,
    repoBranch as never,
    sudo as never,
    stackRestart as never,
  );
  return {
    svc,
    runner,
    pc,
    redeploy,
    overlay,
    rendered,
    fleet,
    fleetReset,
    repoBranch,
    sudo,
    stackRestart,
    createdRuns,
    swapDiffSet: vi.mocked(swapDiffSet),
  };
}

function commitAfterAnchor(fleet: { modeChangePending: ReturnType<typeof vi.fn> }): void {
  let calls = 0;
  fleet.modeChangePending.mockImplementation(() => calls++ === 0);
}
const READY_ALL = [
  { name: 'spoke', status: 'Running', is_ready: 'Ready' },
  { name: 'hub-api', status: 'Running', is_ready: 'Ready' },
  { name: 'fleet', status: 'Running', is_ready: 'Ready' },
];

describe('StackService single-flight guard', () => {
  it('rejects a second stack lifecycle op while one is in flight in the same lane', () => {
    const { svc } = makeService();
    svc.start('reconcile');
    expect(() => svc.start('restart')).toThrow(ConflictException);
  });

  it('allows a read-only op (group status) even while a lifecycle op is in flight', () => {
    const { svc } = makeService();
    svc.start('reconcile');
    expect(() => svc.start('db-drift')).not.toThrow();
  });

  it('does not let an in-flight read-only op block a lifecycle op', () => {
    const { svc } = makeService();
    svc.start('db-drift');
    expect(() => svc.start('reconcile')).not.toThrow();
  });

  it('treats stack and fleet as independent lanes', () => {
    const { svc } = makeService();
    svc.start('fleet-up');
    expect(() => svc.start('reconcile')).not.toThrow();
  });

  it('rejects an unknown op with NotFound', () => {
    const { svc } = makeService();
    expect(() => svc.start('nonsense')).toThrow(NotFoundException);
  });
});

describe('StackService db ops — drift check + migrate deploy', () => {
  it('exposes both db ops as non-destructive stack-section ops', () => {
    const { svc } = makeService();
    const drift = svc.ops().find((o) => o.id === 'db-drift');
    const migrate = svc.ops().find((o) => o.id === 'db-migrate-deploy');
    expect(drift?.section).toBe('stack');
    expect(drift?.group).toBe('status');
    expect(drift?.destructive).toBe(false);
    expect(migrate?.section).toBe('stack');
    expect(migrate?.group).toBe('bringup');
    expect(migrate?.destructive).toBe(false);
  });

  it('runs db:drift via pnpm --filter @repo/database with the resolved DATABASE_URL and repo cwd', async () => {
    const { svc, runner } = makeService();

    svc.start('db-drift');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    const call = runner.spawn.mock.calls.find((c) => Array.isArray(c[2]) && c[2].includes('db:drift'));
    expect(call).toBeDefined();
    expect(call?.[1]).toBe('pnpm');
    expect(call?.[2]).toEqual(['--filter', '@repo/database', 'db:drift']);
    expect(typeof call?.[3]?.DATABASE_URL).toBe('string');
    expect(call?.[3]?.DATABASE_URL).toBeTruthy();
    expect(call?.[4]).toEqual({ cwd: '/repo' });
  });

  it('finalizes non-zero and flags schema drift on exit 2', async () => {
    const { svc, runner } = makeService();
    runner.spawn.mockResolvedValue(2);

    svc.start('db-drift');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    expect(runner.finalize.mock.calls[0][1]).toBe(2);
    const log = runner.emit.mock.calls.map((c) => c[1]).join('');
    expect(log).toMatch(/schema differs/);
  });

  it('reports a clean schema on exit 0', async () => {
    const { svc, runner } = makeService();

    svc.start('db-drift');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    expect(runner.finalize.mock.calls[0][1]).toBe(0);
    const log = runner.emit.mock.calls.map((c) => c[1]).join('');
    expect(log).toMatch(/live schema matches/);
  });

  it('aborts db-drift (exit 1, no spawn) when the hub checkout path is unset', async () => {
    const { svc, runner, repoBranch } = makeService();
    repoBranch.repoPath.mockReturnValue(undefined);

    svc.start('db-drift');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    expect(runner.finalize.mock.calls[0][1]).toBe(1);
    expect(runner.spawn).not.toHaveBeenCalled();
    const log = runner.emit.mock.calls.map((c) => c[1]).join('');
    expect(log).toMatch(/HUB_REPO_PATH/);
  });

  it('runs db:migrate:deploy via pnpm --filter @repo/database with the resolved DATABASE_URL and repo cwd', async () => {
    const { svc, runner } = makeService();

    svc.start('db-migrate-deploy');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    const call = runner.spawn.mock.calls.find((c) => Array.isArray(c[2]) && c[2].includes('db:migrate:deploy'));
    expect(call).toBeDefined();
    expect(call?.[1]).toBe('pnpm');
    expect(call?.[2]).toEqual(['--filter', '@repo/database', 'db:migrate:deploy']);
    expect(typeof call?.[3]?.DATABASE_URL).toBe('string');
    expect(call?.[3]?.DATABASE_URL).toBeTruthy();
    expect(call?.[4]).toEqual({ cwd: '/repo' });
    expect(runner.finalize.mock.calls[0][1]).toBe(0);
  });

  it('aborts db-migrate-deploy (exit 1, no spawn) when the hub checkout path is unset', async () => {
    const { svc, runner, repoBranch } = makeService();
    repoBranch.repoPath.mockReturnValue(undefined);

    svc.start('db-migrate-deploy');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    expect(runner.finalize.mock.calls[0][1]).toBe(1);
    expect(runner.spawn).not.toHaveBeenCalled();
  });

  it('serializes db-migrate-deploy (bringup) against an in-flight stack lifecycle op', () => {
    const { svc } = makeService();
    svc.start('reconcile');
    expect(() => svc.start('db-migrate-deploy')).toThrow(ConflictException);
  });

  it('does not block db-drift (status) on an in-flight stack lifecycle op', () => {
    const { svc } = makeService();
    svc.start('reconcile');
    expect(() => svc.start('db-drift')).not.toThrow();
  });

  it('nuke hint points at the in-cockpit DB migrate deploy path', async () => {
    const { svc, runner, pc } = makeService();
    pc.listAll.mockResolvedValue([{ name: 'postgres', status: 'Running' }]);

    svc.start('nuke');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    const log = runner.emit.mock.calls.map((c) => c[1]).join('');
    expect(log).toMatch(/DB migrate deploy/);
  });
});

describe('StackService cancellation-aware orchestration', () => {
  it('does not bring the control plane back up when a restart is cancelled mid-teardown', async () => {
    const { svc, runner, pc, redeploy, createdRuns } = makeService();
    pc.stopAndWait.mockImplementation(() => {
      const run = createdRuns[0];
      if (run) run.cancelled = true;
      return Promise.resolve(true);
    });
    svc.start('restart');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());
    expect(redeploy.stopAll).toHaveBeenCalled();
    const spawnedReconcile = runner.spawn.mock.calls.some((c) => c[1] === 'stack-reconcile');
    expect(spawnedReconcile).toBe(false);
  });
});

describe('StackService controllableIds refresh guard', () => {
  it('preserves stale controllable ids when catalogOrEmpty returns an empty map (build failure)', async () => {
    const { svc, pc, rendered } = makeService();
    pc.listAll.mockResolvedValue([{ name: 'postgres', status: 'Running' }]);
    await svc.state();
    expect(() => svc.streamDatastoreLog('postgres')).not.toThrow(NotFoundException);

    rendered.catalogOrEmpty.mockResolvedValue(new Map());
    await svc.state();
    expect(() => svc.streamDatastoreLog('postgres')).not.toThrow(NotFoundException);
  });

  it('clears controllable ids when a valid catalog has no datastore/fleet entries', async () => {
    const { svc, pc, rendered } = makeService();
    pc.listAll.mockResolvedValue([{ name: 'postgres', status: 'Running' }]);
    await svc.state();
    expect(() => svc.streamDatastoreLog('postgres')).not.toThrow(NotFoundException);

    rendered.catalogOrEmpty.mockResolvedValue(
      new Map([['hub', { namespace: 'control', label: 'Hub', port: 3000, disabled: false }]]),
    );
    pc.listAll.mockResolvedValue([]);
    await svc.state();
    expect(() => svc.streamDatastoreLog('postgres')).toThrow(NotFoundException);
  });
});

describe('StackService teardown safety on catalog failure', () => {
  it('nuke refuses to wipe (and stops nothing) when the catalog cannot be built', async () => {
    const { svc, runner, pc, rendered } = makeService();
    rendered.catalog.mockRejectedValue(new Error('devenv build failed'));
    pc.listAll.mockResolvedValue([{ name: 'postgres', status: 'Running' }]);

    svc.start('nuke');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    expect(pc.stopAndWait).not.toHaveBeenCalled();
    expect(runner.spawn.mock.calls.some((c) => c[1] === 'stack-wipe-data')).toBe(false);
  });

  it('nuke proceeds to the wipe when the catalog resolves (teardown succeeds)', async () => {
    const { svc, runner, pc } = makeService();
    pc.listAll.mockResolvedValue([{ name: 'postgres', status: 'Running' }]);

    svc.start('nuke');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    const wipeCall = runner.spawn.mock.calls.find((c) => c[1] === 'stack-wipe-data');
    expect(wipeCall).toBeDefined();
    for (const id of ['postgres', 'redis', 'nginx', 'thanos']) {
      expect(pc.stopAndWait).toHaveBeenCalledWith(id);
    }
    const wipeInvoke = runner.spawn.mock.invocationCallOrder[runner.spawn.mock.calls.indexOf(wipeCall!)];
    const lastStopInvoke = Math.max(...pc.stopAndWait.mock.invocationCallOrder);
    expect(lastStopInvoke).toBeLessThan(wipeInvoke);
  });

  it('nuke refuses the wipe (non-zero) when a datastore never reaches a stopped state', async () => {
    const { svc, runner, pc } = makeService();
    pc.stopAndWait.mockImplementation((name: string) => Promise.resolve(name !== 'redis'));

    svc.start('nuke');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    expect(runner.spawn.mock.calls.some((c) => c[1] === 'stack-wipe-data')).toBe(false);
    expect(runner.finalize.mock.calls[0][1]).toBe(1);
  });

  it('down finalizes non-zero when a datastore never reaches a stopped state', async () => {
    const { svc, runner, pc } = makeService();
    pc.stopAndWait.mockResolvedValue(false);

    svc.start('down');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    expect(runner.finalize.mock.calls[0][1]).toBe(1);
    const log = runner.emit.mock.calls.map((c) => c[1]).join('');
    expect(log).toMatch(/did not reach a stopped state/);
  });

  it('nuke refuses the wipe when one stopAndWait rejects while the others stop cleanly', async () => {
    const { svc, runner, pc } = makeService();
    pc.stopAndWait.mockImplementation((name: string) =>
      name === 'redis' ? Promise.reject(new Error('pc socket gone')) : Promise.resolve(true),
    );

    svc.start('nuke');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    expect(runner.spawn.mock.calls.some((c) => c[1] === 'stack-wipe-data')).toBe(false);
    expect(runner.finalize.mock.calls[0][1]).toBe(1);
    const log = runner.emit.mock.calls.map((c) => c[1]).join('');
    expect(log).toMatch(/redis did not reach a stopped state/);
    expect(log).toMatch(/postgres stopped/);
  });

  it('down bails promptly when cancelled while a stopAndWait hangs', async () => {
    const { svc, runner, pc, createdRuns } = makeService();
    pc.stopAndWait.mockImplementation(() => new Promise<boolean>(() => {}));

    svc.start('down');
    await vi.waitFor(() => expect(pc.stopAndWait).toHaveBeenCalled());
    createdRuns[0]!.cancelled = true;
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled(), { timeout: 2_000 });

    const log = runner.emit.mock.calls.map((c) => c[1]).join('');
    expect(log).toMatch(/\[teardown\] cancelled/);
    expect(log).not.toMatch(/did not reach a stopped state/);
  });
});

describe('StackService fleet-apply op', () => {
  it('exposes a non-destructive fleet-apply op', () => {
    const { svc } = makeService();
    const op = svc.ops().find((o) => o.id === 'fleet-apply');
    expect(op).toBeDefined();
    expect(op?.section).toBe('fleet');
    expect(op?.destructive).toBe(false);
  });

  it('serializes fleet-apply against fleet-rebuild in the same lane', () => {
    const { svc } = makeService();
    svc.start('fleet-apply');
    expect(() => svc.start('fleet-rebuild')).toThrow();
  });

  it('blocks fleet-apply (exit 1, no engine spawn) while a fleet-mode change is pending', async () => {
    const { svc, runner, rendered, fleet } = makeService();
    fleet.modeChangePending.mockReturnValue(true);

    svc.start('fleet-apply');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    expect(runner.finalize.mock.calls[0][1]).toBe(1);
    expect(rendered.refreshFleetYaml).not.toHaveBeenCalled();
    const spawnedApply = runner.spawnPty.mock.calls.some(
      (c) => Array.isArray(c[2]) && c[2].join(' ').includes('local.fleet apply'),
    );
    expect(spawnedApply).toBe(false);
    const log = runner.emit.mock.calls.map((c) => c[1]).join('');
    expect(log).toMatch(/fleet-mode change is pending/);
  });
});

describe('StackService fleet-apply — within-bm roster steps (F3)', () => {
  const NOOP_PLAN = {
    fallbackFullRebuild: false,
    reason: null,
    dataLoss: false,
    etaSec: 0,
    items: [],
  };
  const spyNoopPlan = (svc: StackService) =>
    vi
      .spyOn(svc as unknown as { captureApplyPlan: () => Promise<unknown> }, 'captureApplyPlan')
      .mockResolvedValue(NOOP_PLAN);

  const journalSpy = (svc: StackService) =>
    vi.spyOn(svc as unknown as { journalPhase: (r: unknown, p: string) => void }, 'journalPhase');

  it('runs the bm host steps (seal), restarts the spoke, journals done, busts the cache', async () => {
    const { svc, runner, pc, overlay, rendered, fleet } = makeService();
    rendered.refreshFleetYaml.mockResolvedValue('/repo/fleet.yml');
    overlay.fleetMode.mockReturnValue('baremetal');
    fleet.modeChangePending.mockReturnValue(false);
    pc.listAll.mockResolvedValue([{ name: 'spoke', status: 'Running', is_ready: 'Ready' }]);
    const journal = journalSpy(svc);
    spyNoopPlan(svc);

    svc.start('fleet-apply');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    expect(runner.finalize.mock.calls[0][1]).toBe(0);
    expect(runner.spawn.mock.calls.some((c) => c[1] === 'pnpm' && c[2].includes('seed:baremetal-bmc'))).toBe(true);
    expect(pc.restartAndWait).toHaveBeenCalledWith('spoke');
    expect(journal).toHaveBeenCalledWith(expect.anything(), 'done');
    expect(fleet.invalidatePending).toHaveBeenCalled();
  });

  it('passes the sim-gate env to the seal, which refuses to run without it', async () => {
    const { svc, runner, pc, overlay, rendered, fleet } = makeService();
    rendered.refreshFleetYaml.mockResolvedValue('/repo/fleet.yml');
    overlay.fleetMode.mockReturnValue('baremetal');
    fleet.modeChangePending.mockReturnValue(false);
    pc.listAll.mockResolvedValue([{ name: 'spoke', status: 'Running', is_ready: 'Ready' }]);
    spyNoopPlan(svc);

    svc.start('fleet-apply');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    const seal = runner.spawn.mock.calls.find((c) => c[1] === 'pnpm' && c[2].includes('seed:baremetal-bmc'));
    expect(seal).toBeDefined();
    expect(seal?.[3]).toMatchObject({
      LOCAL_SIMULATION_ENABLED: 'true',
      HH_ENV: expect.any(String),
      DATABASE_URL: expect.any(String),
    });
  });

  it('passes the live hub zone key to the seal so it can seal instead of skipping', async () => {
    vi.stubEnv('BROKKR_HUB_PRIVATE_KEY', '');
    const { svc, runner, pc, overlay, rendered, fleet } = makeService();
    rendered.refreshFleetYaml.mockResolvedValue('/repo/fleet.yml');
    overlay.fleetMode.mockReturnValue('baremetal');
    fleet.modeChangePending.mockReturnValue(false);
    pc.listAll.mockResolvedValue([{ name: 'spoke', status: 'Running', is_ready: 'Ready' }]);
    spyNoopPlan(svc);

    svc.start('fleet-apply');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    expect(pc.processInfo).toHaveBeenCalledWith('hub-api');
    const seal = runner.spawn.mock.calls.find((c) => c[1] === 'pnpm' && c[2].includes('seed:baremetal-bmc'));
    expect(seal?.[3]).toMatchObject({ BROKKR_HUB_PRIVATE_KEY: 'zone-key' });
  });

  it('omits the zone key when the live hub has none, rather than passing an empty one', async () => {
    vi.stubEnv('BROKKR_HUB_PRIVATE_KEY', '');
    const { svc, runner, pc, overlay, rendered, fleet } = makeService();
    rendered.refreshFleetYaml.mockResolvedValue('/repo/fleet.yml');
    overlay.fleetMode.mockReturnValue('baremetal');
    fleet.modeChangePending.mockReturnValue(false);
    pc.listAll.mockResolvedValue([{ name: 'spoke', status: 'Running', is_ready: 'Ready' }]);
    pc.processInfo.mockResolvedValue({ Environment: [] });
    spyNoopPlan(svc);

    svc.start('fleet-apply');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    const seal = runner.spawn.mock.calls.find((c) => c[1] === 'pnpm' && c[2].includes('seed:baremetal-bmc'));
    expect(seal?.[3]).not.toHaveProperty('BROKKR_HUB_PRIVATE_KEY');
  });

  it('converges bare-metal roster drift when the engine defers with exit 3', async () => {
    const { svc, runner, pc, overlay, rendered, fleet } = makeService();
    rendered.refreshFleetYaml.mockResolvedValue('/repo/fleet.yml');
    overlay.fleetMode.mockReturnValue('baremetal');
    fleet.modeChangePending.mockReturnValue(false);
    pc.listAll.mockResolvedValue([{ name: 'spoke', status: 'Running', is_ready: 'Ready' }]);
    spyNoopPlan(svc);
    vi.spyOn(svc as unknown as { startFleetProcess: () => Promise<number> }, 'startFleetProcess').mockResolvedValue(0);
    runner.spawnPty.mockImplementation((_r: RunState, _cmd: string, args: string[]) =>
      Promise.resolve(args.includes('apply') ? 3 : 0),
    );

    svc.start('fleet-apply');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    expect(runner.finalize.mock.calls[0][1]).toBe(0);
    expect(runner.spawn.mock.calls.some((c) => c[1] === 'bash' && String(c[2]).includes('sql-seed-run.sh'))).toBe(true);
    expect(pc.stopAndWait).toHaveBeenCalledWith('fleet');
    expect(runner.emit.mock.calls.map((c) => String(c[1])).join('')).toMatch(/bare-metal roster applied/);
  });

  const rosterDriftService = () => {
    const ctx = makeService();
    ctx.rendered.refreshFleetYaml.mockResolvedValue('/repo/fleet.yml');
    ctx.overlay.fleetMode.mockReturnValue('baremetal');
    ctx.fleet.modeChangePending.mockReturnValue(false);
    ctx.pc.listAll.mockResolvedValue([{ name: 'spoke', status: 'Running', is_ready: 'Ready' }]);
    spyNoopPlan(ctx.svc);
    ctx.runner.spawnPty.mockImplementation((_r: RunState, _cmd: string, args: string[]) =>
      Promise.resolve(args.includes('apply') ? 3 : 0),
    );
    return ctx;
  };

  it('aborts the roster convergence when the fleet anchor will not stop', async () => {
    const { svc, runner, pc, fleet } = rosterDriftService();
    pc.stopAndWait.mockImplementation((name: string) => Promise.resolve(name !== 'fleet'));
    const journal = journalSpy(svc);

    svc.start('fleet-apply');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    expect(runner.finalize.mock.calls[0][1]).toBe(1);
    expect(runner.emit.mock.calls.map((c) => String(c[1])).join('')).toMatch(/fleet anchor did not stop in time/);
    expect(journal).not.toHaveBeenCalledWith(expect.anything(), 'done');
    expect(fleet.pending).not.toHaveBeenCalled();
  });

  it('journals failed, not done, when the anchor never commits the manifest', async () => {
    vi.useFakeTimers();
    try {
      const { svc, runner, fleet } = rosterDriftService();
      fleet.pending.mockResolvedValue({
        inSync: false,
        severity: 'hot-appliable',
        desiredDigest: '',
        appliedDigest: null,
        appliedAt: null,
        summary: { added: 0, removed: 0, changed: 1, unchanged: 0 },
        nodes: { added: [], removed: [], changed: [] },
        network: { changed: false, fields: [] },
        note: null,
      });
      vi.spyOn(svc as unknown as { startFleetProcess: () => Promise<number> }, 'startFleetProcess').mockResolvedValue(
        0,
      );
      const journal = journalSpy(svc);

      svc.start('fleet-apply');
      await vi.advanceTimersByTimeAsync(241_000);
      await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

      expect(runner.finalize.mock.calls[0][1]).toBe(1);
      expect(journal).toHaveBeenCalledWith(expect.anything(), 'failed');
      expect(journal).not.toHaveBeenCalledWith(expect.anything(), 'done');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops waiting for the manifest as soon as the run is cancelled', async () => {
    vi.useFakeTimers();
    try {
      const { svc, runner, fleet, createdRuns } = rosterDriftService();
      let polls = 0;
      fleet.pending.mockImplementation(() => {
        polls += 1;
        if (polls === 2) {
          const run = createdRuns[0];
          if (run) run.cancelled = true;
        }
        return Promise.resolve({
          inSync: false,
          severity: 'hot-appliable',
          desiredDigest: '',
          appliedDigest: null,
          appliedAt: null,
          summary: { added: 0, removed: 0, changed: 1, unchanged: 0 },
          nodes: { added: [], removed: [], changed: [] },
          network: { changed: false, fields: [] },
          note: null,
        });
      });
      vi.spyOn(svc as unknown as { startFleetProcess: () => Promise<number> }, 'startFleetProcess').mockResolvedValue(
        0,
      );

      svc.start('fleet-apply');
      await vi.advanceTimersByTimeAsync(241_000);

      await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());
      expect(runner.emit.mock.calls.map((c) => String(c[1])).join('')).toMatch(/cancelled while waiting/);
      expect(polls).toBeLessThan(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves a vm-mode engine exit 3 as a failure instead of converging it', async () => {
    const { svc, runner, overlay, rendered, fleet } = makeService();
    rendered.refreshFleetYaml.mockResolvedValue('/repo/fleet.yml');
    overlay.fleetMode.mockReturnValue('vm');
    fleet.modeChangePending.mockReturnValue(false);
    spyNoopPlan(svc);
    runner.spawnPty.mockResolvedValue(3);

    svc.start('fleet-apply');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    expect(runner.finalize.mock.calls[0][1]).toBe(3);
    expect(runner.emit.mock.calls.map((c) => String(c[1])).join('')).not.toMatch(/roster drift/);
  });

  it('aborts with a clear message when the spoke will not stop, instead of health-gating a dead process', async () => {
    const { svc, runner, pc, overlay, rendered, fleet } = makeService();
    rendered.refreshFleetYaml.mockResolvedValue('/repo/fleet.yml');
    overlay.fleetMode.mockReturnValue('baremetal');
    fleet.modeChangePending.mockReturnValue(false);
    pc.restartAndWait.mockResolvedValue(false);
    spyNoopPlan(svc);

    svc.start('fleet-apply');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    expect(runner.finalize.mock.calls[0][1]).toBe(1);
    expect(runner.emit.mock.calls.map((c) => String(c[1])).join('')).toMatch(/spoke restart failed/);
  });

  it('runs NONE of the bm host steps on a vm-mode apply', async () => {
    const { svc, runner, pc, overlay, rendered, fleet } = makeService();
    rendered.refreshFleetYaml.mockResolvedValue('/repo/fleet.yml');
    overlay.fleetMode.mockReturnValue('vm');
    fleet.modeChangePending.mockReturnValue(false);
    spyNoopPlan(svc);

    svc.start('fleet-apply');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    expect(runner.finalize.mock.calls[0][1]).toBe(0);
    expect(runner.spawn.mock.calls.some((c) => c[1] === 'pnpm' && c[2].includes('seed:baremetal-bmc'))).toBe(false);
    expect(pc.restartAndWait).not.toHaveBeenCalled();
  });

  it('blocks fleet-apply entirely when a mode flip is still pending (desired bm, applied vm)', async () => {
    const { svc, runner, overlay, rendered, fleet } = makeService();
    rendered.refreshFleetYaml.mockResolvedValue('/repo/fleet.yml');
    overlay.fleetMode.mockReturnValue('baremetal');
    fleet.modeChangePending.mockReturnValue(true);
    spyNoopPlan(svc);

    svc.start('fleet-apply');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    expect(runner.finalize.mock.calls[0][1]).toBe(1);
    expect(rendered.refreshFleetYaml).not.toHaveBeenCalled();
    const log = runner.emit.mock.calls.map((c) => c[1]).join('');
    expect(log).toMatch(/fleet-mode change is pending/);
  });

  it('leaves the pending cache intact (retry path) + journals failed when a bm host step fails', async () => {
    const { svc, runner, pc, overlay, rendered, fleet } = makeService();
    rendered.refreshFleetYaml.mockResolvedValue('/repo/fleet.yml');
    overlay.fleetMode.mockReturnValue('baremetal');
    fleet.modeChangePending.mockReturnValue(false);
    runner.spawn.mockImplementation((_r, cmd: string) => Promise.resolve(cmd === 'pnpm' ? 1 : 0));
    const journal = journalSpy(svc);
    spyNoopPlan(svc);

    svc.start('fleet-apply');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    expect(runner.finalize.mock.calls[0][1]).toBe(1);
    expect(journal).toHaveBeenCalledWith(expect.anything(), 'failed');
    expect(fleet.invalidatePending).not.toHaveBeenCalled();
    expect(pc.restartAndWait).not.toHaveBeenCalled();
  });
});

describe('StackService fleet log streaming', () => {
  it('fleet-down follows the fleet log from the pre-op offset and emits CRLF-rewritten lines', async () => {
    const { svc, runner, pc } = makeService();
    const logPath = join(mkdtempSync(join(tmpdir(), 'lab-fleet-log-')), 'fleet.log');
    writeFileSync(logPath, 'pre-op\n');
    pc.logFile.mockReturnValue(logPath);
    pc.followFile.mockReturnValue(of('one\n', 'two\n'));

    svc.start('fleet-down');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    expect(pc.followFile).toHaveBeenCalledWith(logPath, { startOffset: 7 });
    const emitted = runner.emit.mock.calls.map((c) => c[1]);
    expect(emitted).toContain('one\r\n');
    expect(emitted).toContain('two\r\n');
    expect(runner.finalize.mock.calls[0][1]).toBe(0);
  });

  it('fleet-down stops the stream once output goes quiet even though followFile never completes', async () => {
    vi.useFakeTimers();
    try {
      const { svc, runner, pc } = makeService();
      const live = new Subject<string>();
      pc.followFile.mockReturnValue(live);

      svc.start('fleet-down');
      await vi.advanceTimersByTimeAsync(0);
      live.next('one\n');
      await vi.advanceTimersByTimeAsync(5_100);

      expect(runner.emit.mock.calls.map((c) => c[1])).toContain('one\r\n');
      expect(runner.finalize).toHaveBeenCalledWith(expect.anything(), 0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fleet-down gives a silent log the full deadline then finalizes cleanly', async () => {
    vi.useFakeTimers();
    try {
      const { svc, runner, pc } = makeService();
      pc.followFile.mockReturnValue(new Subject<string>());

      svc.start('fleet-down');
      await vi.advanceTimersByTimeAsync(14_000);
      expect(runner.finalize).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(runner.finalize).toHaveBeenCalledWith(expect.anything(), 0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('StackService fleet drift-cache invalidation', () => {
  it('fleet-nuke busts the pending cache after the run settles', async () => {
    const { svc, runner, fleet } = makeService();
    svc.start('fleet-nuke');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());
    expect(fleet.invalidatePending).toHaveBeenCalled();
  });

  it('fleet-rebuild busts the pending cache even when the nuke phase fails', async () => {
    const { svc, runner, rendered, fleet } = makeService();
    fleet.modeChangePending.mockReturnValue(false);
    rendered.refreshFleetYaml.mockResolvedValue('/tmp/fleet.yaml');
    runner.spawnPty.mockResolvedValue(2);
    svc.start('fleet-rebuild');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());
    expect(runner.spawn).not.toHaveBeenCalled();
    expect(fleet.invalidatePending).toHaveBeenCalled();
  });
});

describe('StackService fleet apply/rebuild — abort on refresh failure', () => {
  it('aborts fleet-apply (exit 1, no engine spawn) when the fleet config cannot be refreshed', async () => {
    const { svc, runner, rendered, fleet } = makeService();
    fleet.modeChangePending.mockReturnValue(false);
    rendered.refreshFleetYaml.mockResolvedValue(null);
    svc.start('fleet-apply');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());
    expect(runner.finalize.mock.calls[0][1]).toBe(1);
    expect(runner.spawnPty).not.toHaveBeenCalled();
  });

  it('aborts fleet-rebuild (exit 1, no engine spawn) when the fleet config cannot be refreshed', async () => {
    const { svc, runner, rendered, fleet } = makeService();
    fleet.modeChangePending.mockReturnValue(false);
    rendered.refreshFleetYaml.mockResolvedValue(null);
    svc.start('fleet-rebuild');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());
    expect(runner.finalize.mock.calls[0][1]).toBe(1);
    expect(runner.spawnPty).not.toHaveBeenCalled();
  });

  it('blocks fleet-rebuild (exit 1) while a fleet-mode change is pending — before any refresh/spawn', async () => {
    const { svc, runner, rendered } = makeService();
    svc.start('fleet-rebuild');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());
    expect(runner.finalize.mock.calls[0][1]).toBe(1);
    expect(rendered.refreshFleetYaml).not.toHaveBeenCalled();
    expect(runner.spawnPty).not.toHaveBeenCalled();
  });
});

describe('StackService fleet-apply — data-loss authorization (plan recomputed at run time)', () => {
  const DATA_LOSS_PLAN = {
    fallbackFullRebuild: false,
    reason: null,
    dataLoss: true,
    etaSec: 12,
    items: [
      { name: 'cpu-1', action: 'node-disk', reason: 'disk changed', fields: ['disk_gb'], etaSec: 12, dataLoss: true },
    ],
  };
  const spyPlan = (svc: StackService) =>
    vi
      .spyOn(svc as unknown as { captureApplyPlan: () => Promise<unknown> }, 'captureApplyPlan')
      .mockResolvedValue(DATA_LOSS_PLAN);

  it('aborts (exit 1, no apply spawn) when the recomputed plan wipes a disk but data loss was not authorized', async () => {
    const { svc, runner, rendered, fleet } = makeService();
    fleet.modeChangePending.mockReturnValue(false);
    rendered.refreshFleetYaml.mockResolvedValue('/repo/fleet.yml');
    spyPlan(svc);
    svc.start('fleet-apply');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());
    expect(runner.finalize.mock.calls[0][1]).toBe(1);
    expect(runner.spawnPty).not.toHaveBeenCalled();
  });

  it('runs the destructive apply with --allow-data-loss when the user authorized it', async () => {
    const { svc, runner, rendered, fleet } = makeService();
    fleet.modeChangePending.mockReturnValue(false);
    rendered.refreshFleetYaml.mockResolvedValue('/repo/fleet.yml');
    spyPlan(svc);
    svc.start('fleet-apply', true);
    await vi.waitFor(() => expect(runner.spawnPty).toHaveBeenCalled());
    expect(runner.spawnPty.mock.calls[0][2]).toContain('--allow-data-loss');
  });
});

describe('StackService fleet-apply — full-rebuild authorization (plan recomputed at run time)', () => {
  const FULL_REBUILD_PLAN = {
    fallbackFullRebuild: true,
    reason: 'network changed (cidr) — addresses may move, full rebuild required',
    dataLoss: false,
    etaSec: 90,
    items: [
      {
        name: 'network',
        action: 'full-rebuild-required',
        reason: 'network changed (cidr) — addresses may move, full rebuild required',
        fields: ['cidr'],
        etaSec: 90,
        dataLoss: false,
      },
    ],
  };
  const spyPlan = (svc: StackService) =>
    vi
      .spyOn(svc as unknown as { captureApplyPlan: () => Promise<unknown> }, 'captureApplyPlan')
      .mockResolvedValue(FULL_REBUILD_PLAN);

  it('aborts (exit 1, no seed/apply spawn) when the recomputed plan forces a full rebuild but it was not confirmed', async () => {
    const { svc, runner, rendered, fleet } = makeService();
    fleet.modeChangePending.mockReturnValue(false);
    rendered.refreshFleetYaml.mockResolvedValue('/repo/fleet.yml');
    spyPlan(svc);
    svc.start('fleet-apply');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());
    expect(runner.finalize.mock.calls[0][1]).toBe(1);
    expect(runner.spawn).not.toHaveBeenCalled();
    expect(runner.spawnPty).not.toHaveBeenCalled();
  });

  it('runs the full rebuild (seed then apply) when the user confirmed the destructive apply', async () => {
    const { svc, runner, rendered, fleet } = makeService();
    fleet.modeChangePending.mockReturnValue(false);
    rendered.refreshFleetYaml.mockResolvedValue('/repo/fleet.yml');
    spyPlan(svc);
    svc.start('fleet-apply', true);
    await vi.waitFor(() => expect(runner.spawnPty).toHaveBeenCalled());
    expect(runner.spawn).toHaveBeenCalled();
    expect(runner.spawnPty.mock.calls[0][2]).not.toContain('--allow-data-loss');
  });
});

describe('StackService fleet-mode-apply op — registration + dual-lane contention', () => {
  it('exposes a non-destructive fleet-mode-apply op in the fleet section (sections is internal)', () => {
    const { svc } = makeService();
    const op = svc.ops().find((o) => o.id === 'fleet-mode-apply');
    expect(op).toBeDefined();
    expect(op?.section).toBe('fleet');
    expect(op?.destructive).toBe(false);
    expect(op?.needsSudo).toBe(true);
    for (const pub of svc.ops()) {
      expect('sections' in pub).toBe(false);
      expect('orchestrated' in pub).toBe(false);
    }
  });

  it('is blocked by a running STACK-lane op (dual-lane: it contends on the stack lane too)', () => {
    const { svc } = makeService();
    svc.start('reconcile');
    expect(() => svc.start('fleet-mode-apply')).toThrow(ConflictException);
  });

  it('is blocked by a running FLEET-lane op', () => {
    const { svc } = makeService();
    svc.start('fleet-up');
    expect(() => svc.start('fleet-mode-apply')).toThrow(ConflictException);
  });

  it('while running, blocks BOTH a stack op and a fleet op (occupies both lanes)', () => {
    const { svc } = makeService();
    svc.start('fleet-mode-apply');
    expect(() => svc.start('reconcile')).toThrow(ConflictException);
    expect(() => svc.start('fleet-up')).toThrow(ConflictException);
  });
});

describe('StackService startRun — active-saga preflight 409', () => {
  it('409s (with the job count) when jobs are in flight and force is not set', async () => {
    const { svc, fleetReset } = makeService();
    fleetReset.countActiveSagaJobs.mockResolvedValue(3);
    await expect(svc.startRun('fleet-mode-apply')).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.startRun('fleet-mode-apply')).rejects.toThrow(/3 in-flight/);
  });

  it('starts the run (does not 409) when force overrides the active-saga preflight', async () => {
    const { svc, fleetReset } = makeService();
    fleetReset.countActiveSagaJobs.mockResolvedValue(3);
    await expect(svc.startRun('fleet-mode-apply', false, true)).resolves.toBeTruthy();
  });

  it('starts the run when there are zero in-flight jobs', async () => {
    const { svc, fleetReset } = makeService();
    fleetReset.countActiveSagaJobs.mockResolvedValue(0);
    const runId = await svc.startRun('fleet-mode-apply');
    expect(runId).toBeTruthy();
  });

  it('skips the async preflight count when no mode change is pending', async () => {
    const { svc, fleet, fleetReset } = makeService();
    fleet.modeChangePending.mockReturnValue(false);
    fleetReset.countActiveSagaJobs.mockResolvedValue(9);
    vi.spyOn(svc as unknown as { fleetModeApply: () => Promise<number> }, 'fleetModeApply').mockResolvedValue(0);
    const runId = await svc.startRun('fleet-mode-apply');
    expect(runId).toBeTruthy();
    expect(fleetReset.countActiveSagaJobs).not.toHaveBeenCalled();
  });
});

describe('StackService destructive-cycle ops — reinit / reset / purge', () => {
  it.each([
    ['reinit', 'stack-wipe-data'],
    ['reset', 'stack-reset'],
    ['purge', 'stack-purge'],
  ])('dispatches %s to the detached restart with wipe=%s', async (opId, wipe) => {
    const { svc, runner, stackRestart } = makeService();

    svc.start(opId);
    await vi.waitFor(() => expect(stackRestart.restartStackDetached).toHaveBeenCalled());

    expect(stackRestart.restartStackDetached.mock.calls[0][1]).toMatchObject({ wipe });
    expect(stackRestart.restartStackDetached.mock.calls[0][1].reason).toContain(opId);
    expect(runner.spawn).not.toHaveBeenCalled();
  });

  it('finalizes a detached op exactly once, at the detach point', async () => {
    const { svc, runner, stackRestart } = makeService();

    svc.start('reinit');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    expect(stackRestart.restartStackDetached).toHaveBeenCalledTimes(1);
    expect(runner.finalize).toHaveBeenCalledTimes(1);
    expect(runner.finalize.mock.calls[0][1]).toBe(0);
  });

  it("keeps a refused run failed — the caller's success finalize cannot override a settled run", () => {
    const runner = new RunnerService(NULL_RUN_SINK);
    const run = runner.create({ section: 'stack', opId: 'purge', label: 'purge' });

    runner.finalize(run, 1);
    runner.finalize(run, 0);

    expect(run.status).toBe('failed');
    expect(run.exitCode).toBe(1);
  });

  it.each(['reinit', 'reset', 'purge'])('registers %s as destructive, sudo-needing, dual-lane', (opId) => {
    const { svc } = makeService();
    const op = svc.ops().find((o) => o.id === opId);

    expect(op?.section).toBe('stack');
    expect(op?.group).toBe('destructive');
    expect(op?.destructive).toBe(true);
    expect(op?.needsSudo).toBe(true);
    expect(op?.task).toContain('stack-up');
  });

  it.each(['reinit', 'reset', 'purge'])('%s contends on the fleet lane as well as the stack lane', (opId) => {
    const { svc } = makeService();
    svc.start('fleet-up');
    expect(() => svc.start(opId)).toThrow(ConflictException);
  });

  it.each(['reinit', 'reset', 'purge'])('while %s runs, both a stack op and a fleet op are refused', (opId) => {
    const { svc } = makeService();
    svc.start(opId);
    expect(() => svc.start('reconcile')).toThrow(ConflictException);
    expect(() => svc.start('fleet-up')).toThrow(ConflictException);
  });

  it('creates the run in the stack section so boot-time orphan killing spares the child', async () => {
    const { svc, createdRuns, stackRestart } = makeService();

    svc.start('reset');
    await vi.waitFor(() => expect(stackRestart.restartStackDetached).toHaveBeenCalled());

    expect(createdRuns[0].section).toBe('stack');
  });

  it('names what each op destroys, and purge names the sibling refusal', () => {
    const { svc } = makeService();
    const by = (id: string) => svc.ops().find((o) => o.id === id)?.description ?? '';

    expect(by('reinit')).toMatch(/KEEPS fleet disk overlays/);
    expect(by('reset')).toMatch(/overlays, NVRAM/);
    expect(by('purge')).toMatch(/REFUSES while another checkout's stack is live/);
    expect(by('purge')).toMatch(/task local:purge/);
  });

  it('points the nuke dead end at Reinit instead of a terminal task up', async () => {
    const { svc, runner, pc } = makeService();
    pc.listAll.mockResolvedValue([{ name: 'postgres', status: 'Running' }]);

    svc.start('nuke');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    const log = runner.emit.mock.calls.map((c) => String(c[1])).join('');
    expect(log).toMatch(/Run Reinit/);
    expect(log).not.toMatch(/task up/);
    expect(log).not.toMatch(/devenv up/);
  });
});

describe('StackService startRun — needsSudo preflight gate', () => {
  it('fails the run with the preflight reason and spawns nothing for a needsSudo op', async () => {
    const { svc, runner, sudo } = makeService();
    sudo.preflight.mockResolvedValue({ ok: false, reason: 'the drop-in is stale — run `task sudo:setup`' });

    const runId = await svc.startRun('fleet-up');

    expect(runId).toBeTruthy();
    expect(runner.finalize.mock.calls[0][1]).toBe(1);
    expect(runner.spawn).not.toHaveBeenCalled();
    expect(runner.spawnPty).not.toHaveBeenCalled();
    const log = runner.emit.mock.calls.map((c) => String(c[1])).join('');
    expect(log).toMatch(/\[preflight\] the drop-in is stale/);
    expect(log).toMatch(/task sudo:setup/);
  });

  it('never probes sudo for an op that does not need root', async () => {
    const { svc, sudo } = makeService();

    await svc.startRun('reconcile');

    expect(sudo.preflight).not.toHaveBeenCalled();
  });

  it('proceeds normally when the preflight passes', async () => {
    const { svc, runner, sudo } = makeService();

    await svc.startRun('fleet-status');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    expect(sudo.preflight).not.toHaveBeenCalled();
    expect(runner.finalize.mock.calls[0][1]).toBe(0);
  });

  it('gates every needsSudo op in the catalog, and only those', async () => {
    const { svc, sudo } = makeService();
    const needsSudo = svc.ops().filter((o) => o.needsSudo);
    sudo.preflight.mockResolvedValue({ ok: false, reason: 'no sudo' });

    for (const op of needsSudo) await svc.startRun(op.id);

    expect(sudo.preflight).toHaveBeenCalledTimes(needsSudo.length);
    expect(needsSudo.length).toBeGreaterThan(0);
  });
});

describe('StackService fleet-mode-apply orchestration — §6.1 sequence', () => {
  it('no-ops (exit 0, no swap) when no mode change is pending', async () => {
    const { svc, runner, rendered, fleet } = makeService();
    fleet.modeChangePending.mockReturnValue(false);
    svc.start('fleet-mode-apply');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());
    expect(runner.finalize.mock.calls[0][1]).toBe(0);
    expect(rendered.applyOverlay).not.toHaveBeenCalled();
  });

  it('no-ops (exit 0) when no mode change is pending, even with active saga jobs', async () => {
    const { svc, runner, rendered, fleet, fleetReset } = makeService();
    fleet.modeChangePending.mockReturnValue(false);
    fleetReset.countActiveSagaJobs.mockResolvedValue(3);
    svc.start('fleet-mode-apply');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());
    expect(runner.finalize.mock.calls[0][1]).toBe(0);
    expect(fleetReset.countActiveSagaJobs).not.toHaveBeenCalled();
    expect(rendered.applyOverlay).not.toHaveBeenCalled();
  });

  it('blocks the run (exit 1, no swap) when jobs are active and not forced', async () => {
    const { svc, runner, rendered, fleetReset } = makeService();
    fleetReset.countActiveSagaJobs.mockResolvedValue(2);
    svc.start('fleet-mode-apply', false, false);
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());
    expect(runner.finalize.mock.calls[0][1]).toBe(1);
    expect(rendered.applyOverlay).not.toHaveBeenCalled();
  });

  it('runs the full flip when forced, in §6.1 order: stop → refresh → swap → gate', async () => {
    const { svc, runner, pc, rendered, fleet, fleetReset } = makeService();
    commitAfterAnchor(fleet);
    fleetReset.countActiveSagaJobs.mockResolvedValue(5);
    rendered.refreshFleetYaml.mockResolvedValue('/repo/fleet.yaml');
    pc.listAll.mockResolvedValue(READY_ALL);
    vi.spyOn(svc as unknown as { startFleetProcess: () => Promise<number> }, 'startFleetProcess').mockResolvedValue(0);
    svc.start('fleet-mode-apply', false, true);
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());
    expect(pc.stopAndWait).toHaveBeenCalledWith('fleet');
    expect(rendered.refreshFleetYaml).toHaveBeenCalled();
    expect(rendered.applyOverlay).toHaveBeenCalled();
    expect(runner.finalize.mock.calls[0][1]).toBe(0);
  });

  it('aborts (exit 1, no swap) when the staged fleet.yml cannot be refreshed', async () => {
    const { svc, runner, rendered } = makeService();
    rendered.refreshFleetYaml.mockResolvedValue(null);
    svc.start('fleet-mode-apply');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());
    expect(runner.finalize.mock.calls[0][1]).toBe(1);
    expect(rendered.applyOverlay).not.toHaveBeenCalled();
  });

  it('stops hub-api and spoke before starting either, so the pair never straddles two modes', async () => {
    const { svc, runner, pc, rendered, fleet } = makeService();
    commitAfterAnchor(fleet);
    rendered.refreshFleetYaml.mockResolvedValue('/repo/fleet.yaml');
    pc.listAll.mockResolvedValue(READY_ALL);
    vi.spyOn(svc as unknown as { startFleetProcess: () => Promise<number> }, 'startFleetProcess').mockResolvedValue(0);

    svc.start('fleet-mode-apply');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    const lastStop = Math.max(
      ...pc.stopAndWait.mock.calls
        .map((c, i) => ({ name: c[0], order: pc.stopAndWait.mock.invocationCallOrder[i] }))
        .filter((c) => c.name === 'hub-api' || c.name === 'spoke')
        .map((c) => c.order),
    );
    const firstStart = Math.min(
      ...pc.start.mock.calls
        .map((c, i) => ({ name: c[0], order: pc.start.mock.invocationCallOrder[i] }))
        .filter((c) => c.name === 'hub-api' || c.name === 'spoke')
        .map((c) => c.order),
    );
    expect(pc.stopAndWait).toHaveBeenCalledWith('hub-api');
    expect(pc.stopAndWait).toHaveBeenCalledWith('spoke');
    expect(lastStop).toBeLessThan(firstStart);
  });

  it('aborts the flip with recovery guidance when a start is rejected after the overlay applied', async () => {
    const { svc, runner, pc, rendered } = makeService();
    rendered.refreshFleetYaml.mockResolvedValue('/repo/fleet.yaml');
    pc.start.mockImplementation((name: string) =>
      name === 'hub-api' ? Promise.reject(new Error('pc 400')) : Promise.resolve(),
    );

    svc.start('fleet-mode-apply');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    expect(runner.finalize.mock.calls[0][1]).toBe(1);
    const log = runner.emit.mock.calls.map((c) => String(c[1])).join('');
    expect(log).toMatch(/hub-api failed to start/);
    expect(log).toMatch(/run Reconcile/);
  });

  it('aborts the flip (exit 1) when hub-api will not stop', async () => {
    const { svc, runner, pc, rendered } = makeService();
    rendered.refreshFleetYaml.mockResolvedValue('/repo/fleet.yaml');
    pc.stopAndWait.mockImplementation((name: string) => Promise.resolve(name !== 'hub-api'));

    svc.start('fleet-mode-apply');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    expect(runner.finalize.mock.calls[0][1]).toBe(1);
    expect(pc.start).not.toHaveBeenCalledWith('spoke');
    expect(runner.emit.mock.calls.map((c) => String(c[1])).join('')).toMatch(/hub-api did not stop in time/);
  });

  it('fails (exit 1) when the post-swap health gate times out (spoke/hub-api never Ready)', async () => {
    vi.useFakeTimers();
    try {
      const { svc, runner, pc, rendered } = makeService();
      rendered.refreshFleetYaml.mockResolvedValue('/repo/fleet.yaml');
      pc.listAll.mockResolvedValue([
        { name: 'spoke', status: 'Running', is_ready: 'Not Ready' },
        { name: 'hub-api', status: 'Pending', is_ready: 'Not Ready' },
      ]);
      svc.start('fleet-mode-apply');
      await vi.advanceTimersByTimeAsync(121_000);
      await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());
      expect(rendered.applyOverlay).toHaveBeenCalled();
      expect(runner.finalize.mock.calls[0][1]).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('StackService fleet-mode-apply — W2 forced render threaded end-to-end', () => {
  it('force-renders with refresh-eval-cache and threads that single path to refreshFleetYaml/applyOverlay', async () => {
    const { svc, runner, pc, overlay, rendered, fleet } = makeService();
    commitAfterAnchor(fleet);
    overlay.fleetMode.mockReturnValue('vm');
    rendered.buildRenderedConfig.mockResolvedValue('/nix/store/forced-cfg.yaml');
    rendered.refreshFleetYaml.mockResolvedValue('/state/fleet.yaml');
    pc.listAll.mockResolvedValue(READY_ALL);
    vi.spyOn(svc as unknown as { startFleetProcess: () => Promise<number> }, 'startFleetProcess').mockResolvedValue(0);

    svc.start('fleet-mode-apply');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    expect(rendered.buildRenderedConfig).toHaveBeenCalledWith({ refreshEvalCache: true });
    expect(rendered.refreshFleetYaml).toHaveBeenCalledWith('/nix/store/forced-cfg.yaml');
    expect(rendered.applyOverlay).toHaveBeenCalledWith('/nix/store/forced-cfg.yaml');
  });

  it('aborts pre-mutation (exit 1, no swap) when the forced render fails', async () => {
    const { svc, runner, rendered, fleet } = makeService();
    fleet.modeChangePending.mockReturnValue(true);
    rendered.buildRenderedConfig.mockRejectedValue(new Error('nix eval failed'));

    svc.start('fleet-mode-apply');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    expect(runner.finalize.mock.calls[0][1]).toBe(1);
    expect(rendered.applyOverlay).not.toHaveBeenCalled();
    expect(rendered.refreshFleetYaml).not.toHaveBeenCalled();
  });
});

describe('StackService fleet-mode-apply — W4 bm preflight ordering', () => {
  it('runs guard → cap-ensure → bake BEFORE any stop, in order (bm direction)', async () => {
    const { svc, runner, pc, overlay, rendered, fleet } = makeService();
    commitAfterAnchor(fleet);
    overlay.fleetMode.mockReturnValue('baremetal');
    rendered.refreshFleetYaml.mockResolvedValue('/state/fleet.yaml');
    pc.listAll.mockResolvedValue(READY_ALL);
    vi.spyOn(svc as unknown as { startFleetProcess: () => Promise<number> }, 'startFleetProcess').mockResolvedValue(0);

    svc.start('fleet-mode-apply');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    const capCall = runner.spawn.mock.calls.find((c) => c[2]?.[0] === 'scripts/tasks/bm-cap-ensure.sh');
    const bakeCall = runner.spawnPty.mock.calls.find((c) => c[2]?.includes('local.ipxe_build'));
    expect(capCall).toBeDefined();
    expect(bakeCall).toBeDefined();
    expect(bakeCall?.[2]).toEqual(['-m', 'local.ipxe_build', '--chain-base-url', 'http://10.0.0.5:8000']);
    const capOrder = runner.spawn.mock.calls.indexOf(capCall!);
    const capInvoke = runner.spawn.mock.invocationCallOrder[capOrder];
    const stopInvoke = Math.min(...pc.stopAndWait.mock.invocationCallOrder);
    expect(capInvoke).toBeLessThan(stopInvoke);
  });

  it('skips cap-ensure and bake on the bm→vm direction', async () => {
    const { svc, runner, pc, overlay, rendered, fleet } = makeService();
    commitAfterAnchor(fleet);
    overlay.fleetMode.mockReturnValue('vm');
    rendered.refreshFleetYaml.mockResolvedValue('/state/fleet.yaml');
    pc.listAll.mockResolvedValue(READY_ALL);
    vi.spyOn(svc as unknown as { startFleetProcess: () => Promise<number> }, 'startFleetProcess').mockResolvedValue(0);

    svc.start('fleet-mode-apply');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    expect(runner.spawn.mock.calls.some((c) => c[2]?.[0] === 'scripts/tasks/bm-cap-ensure.sh')).toBe(false);
    expect(runner.spawnPty.mock.calls.some((c) => c[2]?.includes('local.ipxe_build'))).toBe(false);
    expect(overlay.bmUplink).not.toHaveBeenCalled();
  });

  it('aborts pre-mutation when cap-ensure fails (with the sudo:setup hint, no stop, no swap)', async () => {
    const { svc, runner, pc, overlay, rendered, fleet } = makeService();
    fleet.modeChangePending.mockReturnValue(true);
    overlay.fleetMode.mockReturnValue('baremetal');
    runner.spawn.mockImplementation((_run: RunState, _cmd: string, args: string[]) =>
      Promise.resolve(args[0] === 'scripts/tasks/bm-cap-ensure.sh' ? 3 : 0),
    );

    svc.start('fleet-mode-apply');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    expect(runner.finalize.mock.calls[0][1]).toBe(3);
    expect(pc.stopAndWait).not.toHaveBeenCalled();
    expect(rendered.applyOverlay).not.toHaveBeenCalled();
  });

  it('aborts pre-mutation when the bm uplink is unresolved (no NIC/IPv4)', async () => {
    const { svc, runner, pc, overlay, rendered, fleet } = makeService();
    fleet.modeChangePending.mockReturnValue(true);
    overlay.fleetMode.mockReturnValue('baremetal');
    overlay.bmUplink.mockReturnValue(null);

    svc.start('fleet-mode-apply');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    expect(runner.finalize.mock.calls[0][1]).toBe(1);
    expect(runner.spawnPty.mock.calls.some((c) => c[2]?.includes('local.ipxe_build'))).toBe(false);
    expect(pc.stopAndWait).not.toHaveBeenCalled();
    expect(rendered.applyOverlay).not.toHaveBeenCalled();
  });
});

describe('StackService fleet-mode-apply — W3 drift guard', () => {
  it('aborts (exit 1) naming the offenders and stops before applyOverlay when the stack has drifted', async () => {
    const { svc, runner, pc, swapDiffSet, overlay, rendered, fleet } = makeService();
    fleet.modeChangePending.mockReturnValue(true);
    overlay.fleetMode.mockReturnValue('vm');
    swapDiffSet.mockResolvedValue(['spoke', 'hub-api', 'fleet', 'nginx', 'lab']);

    svc.start('fleet-mode-apply');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    expect(runner.finalize.mock.calls[0][1]).toBe(1);
    expect(pc.stopAndWait).not.toHaveBeenCalled();
    expect(rendered.applyOverlay).not.toHaveBeenCalled();
    const log = runner.emit.mock.calls.map((c) => c[1]).join('');
    expect(log).toContain('nginx');
    expect(log).toContain('lab');
    expect(log).toMatch(/drifted/);
  });

  it('force does NOT bypass the drift guard (force overrides only the active-saga preflight)', async () => {
    const { svc, runner, pc, swapDiffSet, overlay, rendered, fleet } = makeService();
    fleet.modeChangePending.mockReturnValue(true);
    overlay.fleetMode.mockReturnValue('vm');
    swapDiffSet.mockResolvedValue(['spoke', 'hub-api', 'fleet', 'nginx']);
    rendered.refreshFleetYaml.mockResolvedValue('/state/fleet.yaml');
    pc.listAll.mockResolvedValue(READY_ALL);
    vi.spyOn(svc as unknown as { startFleetProcess: () => Promise<number> }, 'startFleetProcess').mockResolvedValue(0);

    svc.start('fleet-mode-apply', false, true);
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    expect(runner.finalize.mock.calls[0][1]).toBe(1);
    expect(rendered.applyOverlay).not.toHaveBeenCalled();
    expect(pc.stopAndWait).not.toHaveBeenCalled();
    const log = runner.emit.mock.calls.map((c) => c[1]).join('');
    expect(log).toMatch(/drifted/);
  });

  it('aborts (exit 1, no swap) when swapDiffSet throws — drift unknown, fail-closed', async () => {
    const { svc, runner, swapDiffSet, overlay, rendered, fleet } = makeService();
    commitAfterAnchor(fleet);
    overlay.fleetMode.mockReturnValue('vm');
    swapDiffSet.mockRejectedValue(new Error('pc unreachable'));

    svc.start('fleet-mode-apply');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    expect(runner.finalize.mock.calls[0][1]).toBe(1);
    expect(rendered.applyOverlay).not.toHaveBeenCalled();
    const log = runner.emit.mock.calls.map((c) => c[1]).join('');
    expect(log).toMatch(/aborting/);
  });
});

describe('StackService fleet-mode-apply — W7 phase journal', () => {
  const stateDirs: string[] = [];
  afterEach(() => {
    delete process.env.DEVENV_STATE;
    vi.unstubAllEnvs();
  });

  const withState = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'lab-journal-'));
    stateDirs.push(dir);
    process.env.DEVENV_STATE = dir;
    return dir;
  };

  const journalLines = (dir: string): { phase: string }[] => {
    const p = join(dir, 'baremetal', 'apply-journal.json');
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
  };

  it("writes a phase journal (mkdir'd) through a full bm flip ending in done", async () => {
    const dir = withState();
    const { svc, runner, pc, overlay, rendered, fleet } = makeService();
    commitAfterAnchor(fleet);
    overlay.fleetMode.mockReturnValue('baremetal');
    rendered.refreshFleetYaml.mockResolvedValue('/state/fleet.yaml');
    pc.listAll.mockResolvedValue(READY_ALL);
    vi.spyOn(svc as unknown as { startFleetProcess: () => Promise<number> }, 'startFleetProcess').mockResolvedValue(0);

    svc.start('fleet-mode-apply');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    const phases = journalLines(dir).map((r) => r.phase);
    expect(phases).toContain('guard');
    expect(phases).toContain('cap');
    expect(phases).toContain('bake');
    expect(phases).toContain('swap');
    expect(phases[phases.length - 1]).toBe('done');
  });

  it('journals the bm→vm direction too (guard … done, no cap/bake)', async () => {
    const dir = withState();
    const { svc, runner, pc, overlay, rendered, fleet } = makeService();
    commitAfterAnchor(fleet);
    overlay.fleetMode.mockReturnValue('vm');
    rendered.refreshFleetYaml.mockResolvedValue('/state/fleet.yaml');
    pc.listAll.mockResolvedValue(READY_ALL);
    vi.spyOn(svc as unknown as { startFleetProcess: () => Promise<number> }, 'startFleetProcess').mockResolvedValue(0);

    svc.start('fleet-mode-apply');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    const phases = journalLines(dir).map((r) => r.phase);
    expect(phases).toContain('guard');
    expect(phases).not.toContain('cap');
    expect(phases).not.toContain('bake');
    expect(phases[phases.length - 1]).toBe('done');
  });

  it('journals a terminal failed on an aborting flip', async () => {
    const dir = withState();
    const { svc, runner, overlay, rendered, fleet } = makeService();
    fleet.modeChangePending.mockReturnValue(true);
    overlay.fleetMode.mockReturnValue('vm');
    rendered.refreshFleetYaml.mockResolvedValue(null);

    svc.start('fleet-mode-apply');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    const phases = journalLines(dir).map((r) => r.phase);
    expect(phases[phases.length - 1]).toBe('failed');
  });

  it('does NOT journal the no-op P3-gate path (post-success re-Apply)', async () => {
    const dir = withState();
    const { svc, runner, fleet } = makeService();
    fleet.modeChangePending.mockReturnValue(false);

    svc.start('fleet-mode-apply');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    expect(journalLines(dir)).toHaveLength(0);
  });
});

describe('StackService onApplicationBootstrap — W7 boot hook', () => {
  afterEach(() => {
    delete process.env.DEVENV_STATE;
  });

  const seedJournal = (record: object): void => {
    const dir = mkdtempSync(join(tmpdir(), 'lab-boot-'));
    process.env.DEVENV_STATE = dir;
    mkdirSync(join(dir, 'baremetal'), { recursive: true });
    writeFileSync(join(dir, 'baremetal', 'apply-journal.json'), JSON.stringify(record) + '\n');
  };

  it('surfaces an unfinished trailing journal entry as a synthetic failed run', () => {
    seedJournal({ runId: 'r1', opId: 'fleet-mode-apply', phase: 'seed', ts: 1 });

    const { svc, runner } = makeService();
    svc.onApplicationBootstrap();

    expect(runner.create.mock.calls.some((c) => c[0].opId === 'fleet-mode-apply')).toBe(true);
    expect(runner.finalize.mock.calls.some((c) => c[1] === 1)).toBe(true);
    const log = runner.emit.mock.calls.map((c) => c[1]).join('');
    expect(log).toMatch(/restarted mid-flip at phase seed/);
  });

  it('does not surface a clean (terminal) journal on boot', () => {
    seedJournal({ runId: 'r1', opId: 'fleet-mode-apply', phase: 'done', ts: 1 });

    const { svc, runner } = makeService();
    svc.onApplicationBootstrap();

    expect(runner.create.mock.calls.some((c) => c[0].opId === 'fleet-mode-apply')).toBe(false);
  });
});

describe('StackService fleet-mode-apply — D1.2 deterministic stop-fleet', () => {
  it('aborts pre-mutation (exit 1, no refresh/swap) when the fleet never reaches a terminal state', async () => {
    const { svc, runner, pc, overlay, rendered, fleet } = makeService();
    fleet.modeChangePending.mockReturnValue(true);
    overlay.fleetMode.mockReturnValue('vm');
    pc.stopAndWait.mockResolvedValue(false);

    svc.start('fleet-mode-apply');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    expect(runner.finalize.mock.calls[0][1]).toBe(1);
    expect(rendered.refreshFleetYaml).not.toHaveBeenCalled();
    expect(rendered.applyOverlay).not.toHaveBeenCalled();
  });

  it('runs the explicit old-mode engine down (no LOCAL_FLEET_PATH override) after the stop settles', async () => {
    const { svc, runner, pc, overlay, rendered, fleet } = makeService();
    commitAfterAnchor(fleet);
    overlay.fleetMode.mockReturnValue('vm');
    rendered.refreshFleetYaml.mockResolvedValue('/state/fleet.yaml');
    pc.listAll.mockResolvedValue(READY_ALL);
    vi.spyOn(svc as unknown as { startFleetProcess: () => Promise<number> }, 'startFleetProcess').mockResolvedValue(0);
    let downExtraEnv: Record<string, string> | undefined;
    runner.spawn.mockImplementation((_run: RunState, _cmd: string, args: string[], extra?: Record<string, string>) => {
      if (Array.isArray(args) && args.includes('local.fleet') && args.includes('down')) {
        downExtraEnv = { ...(extra ?? {}) };
      }
      return Promise.resolve(0);
    });

    svc.start('fleet-mode-apply');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    expect(downExtraEnv).toBeDefined();
    expect(downExtraEnv).not.toHaveProperty('LOCAL_FLEET_PATH');
  });

  it('aborts (exit 1, no swap) when the explicit engine down fails', async () => {
    const { svc, runner, overlay, rendered, fleet } = makeService();
    fleet.modeChangePending.mockReturnValue(true);
    overlay.fleetMode.mockReturnValue('vm');
    runner.spawn.mockImplementation((_run: RunState, _cmd: string, args: string[]) =>
      Promise.resolve(Array.isArray(args) && args.includes('local.fleet') && args.includes('down') ? 4 : 0),
    );

    svc.start('fleet-mode-apply');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    expect(runner.finalize.mock.calls[0][1]).toBe(4);
    expect(rendered.applyOverlay).not.toHaveBeenCalled();
  });
});

describe('StackService fleet-mode-apply — D1.4 F3 pre-anchor re-assert', () => {
  const stateDirs: string[] = [];
  afterEach(() => {
    delete process.env.DEVENV_STATE;
  });

  it('re-stages from the rendered config when the staged file drifted to the wrong mode', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lab-f3-'));
    stateDirs.push(dir);
    const stagedPath = join(dir, 'fleet.yaml');
    writeFileSync(stagedPath, 'mode: vm\nnodes: []\n');

    const { svc, runner, pc, overlay, rendered, fleet } = makeService();
    commitAfterAnchor(fleet);
    overlay.fleetMode.mockReturnValue('baremetal');
    rendered.refreshFleetYaml.mockResolvedValue(stagedPath);
    pc.listAll.mockResolvedValue(READY_ALL);
    vi.spyOn(svc as unknown as { startFleetProcess: () => Promise<number> }, 'startFleetProcess').mockResolvedValue(0);

    svc.start('fleet-mode-apply', false, true);
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    expect(rendered.refreshFleetYaml.mock.calls.length).toBeGreaterThanOrEqual(2);
    const log = runner.emit.mock.calls.map((c) => c[1]).join('');
    expect(log).toMatch(/clobbered mid-flip/);
  });
});

describe('StackService fleet-mode-apply — D1.5 post-anchor post-condition', () => {
  it('fails loudly (exit 1) when the anchor never commits the applied manifest (still pending)', async () => {
    vi.useFakeTimers();
    try {
      const { svc, runner, pc, overlay, rendered, fleet } = makeService();
      fleet.modeChangePending.mockReturnValue(true);
      overlay.fleetMode.mockReturnValue('vm');
      rendered.refreshFleetYaml.mockResolvedValue('/state/fleet.yaml');
      pc.listAll.mockResolvedValue(READY_ALL);
      vi.spyOn(svc as unknown as { startFleetProcess: () => Promise<number> }, 'startFleetProcess').mockResolvedValue(
        0,
      );

      svc.start('fleet-mode-apply');
      await vi.advanceTimersByTimeAsync(241_000);
      await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

      expect(rendered.applyOverlay).toHaveBeenCalled();
      expect(runner.finalize.mock.calls[0][1]).toBe(1);
      const log = runner.emit.mock.calls.map((c) => c[1]).join('');
      expect(log).toMatch(/did not commit the applied manifest/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('succeeds (exit 0) when the anchor commits the applied manifest within the bound', async () => {
    const { svc, runner, pc, overlay, rendered, fleet } = makeService();
    commitAfterAnchor(fleet);
    overlay.fleetMode.mockReturnValue('vm');
    rendered.refreshFleetYaml.mockResolvedValue('/state/fleet.yaml');
    pc.listAll.mockResolvedValue(READY_ALL);
    vi.spyOn(svc as unknown as { startFleetProcess: () => Promise<number> }, 'startFleetProcess').mockResolvedValue(0);

    svc.start('fleet-mode-apply');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    expect(rendered.applyOverlay).toHaveBeenCalled();
    expect(runner.finalize.mock.calls[0][1]).toBe(0);
    const log = runner.emit.mock.calls.map((c) => c[1]).join('');
    expect(log).toMatch(/flip to vm complete/);
  });
});
