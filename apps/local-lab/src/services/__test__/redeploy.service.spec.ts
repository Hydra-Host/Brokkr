import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, vi } from 'vitest';

import { NULL_RUN_SINK } from '../../runner/run-sink';
import { RunnerService } from '../../runner/runner.service';
import { SudoService } from '../../sudo/sudo.service';
import { OverlayStoreService } from '../overlay-store';
import type { PcProcess, PcProcessConfig, ProcessComposeClient } from '../process-compose.client';
import { RedeployService } from '../redeploy.service';
import { RenderedConfigService, type CatalogEntry } from '../rendered-config.service';
import { StackRestartService } from '../stack-restart.service';

const { spawnMock, seedStdout } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  seedStdout: JSON.stringify({
    portGroups: { editable: ['postgres'], readOnly: [] },
    ports: { postgres: 5432 },
    portDefaults: { postgres: 5432 },
  }),
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock,
  execFile: (
    _file: string,
    _args: string[],
    _opts: object,
    cb: (err: Error | null, out: { stdout: string; stderr: string }) => void,
  ) => cb(null, { stdout: seedStdout, stderr: '' }),
}));

const proc = (over: Partial<PcProcess>): PcProcess => ({ name: 'x', status: 'Running', ...over });

const catalogOf = (byName: Record<string, string>): Map<string, CatalogEntry> =>
  new Map(
    Object.entries(byName).map(([name, namespace]) => [name, { namespace, label: name, port: null, disabled: false }]),
  );

const withApplied = (mode: 'vm' | 'baremetal'): void => {
  const dir = mkdtempSync(join(tmpdir(), 'lab-applied-'));
  process.env.LOCAL_STATE = dir;
  mkdirSync(join(dir, 'state', 'run'), { recursive: true });
  writeFileSync(join(dir, 'state', 'run', 'fleet-applied.json'), JSON.stringify({ mode }));
};

function makeService(procs: PcProcess[]) {
  const pc = {
    list: vi.fn(async () => procs.filter((p) => p.status !== 'Disabled')),
    listAll: vi.fn(async () => procs),
    start: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    ensureRunning: vi.fn(async () => undefined),
    ensureStopped: vi.fn(async () => undefined),
    tailError: vi.fn(() => undefined),
    projectUpdate: vi.fn(async () => undefined),
    processInfo: vi.fn(async (_name: string): Promise<PcProcessConfig> => ({})),
  };
  const rendered = new RenderedConfigService(pc as unknown as ProcessComposeClient);
  const overlay = new OverlayStoreService(rendered);
  const sudo = new SudoService();
  const runner = new RunnerService(NULL_RUN_SINK);
  const stackRestart = new StackRestartService(sudo, runner);
  const svc = new RedeployService(pc as unknown as ProcessComposeClient, rendered, overlay, runner, stackRestart);
  return { svc, pc, rendered, overlay, sudo, runner, stackRestart };
}

describe('RedeployService.control — start is idempotent', () => {
  it('does not restart a healthy running process on a start action', async () => {
    const { svc, pc, rendered } = makeService([proc({ name: 'x', status: 'Running', is_ready: 'Ready' })]);
    vi.spyOn(rendered, 'dependsGraph').mockResolvedValue({});

    const res = await svc.control('x', 'start');

    expect(res.ok).toBe(true);
    expect(res.detail).toMatch(/already running/);
    expect(pc.start).not.toHaveBeenCalled();
    expect(pc.restart).not.toHaveBeenCalled();
  });

  it('still bounces the process on an explicit restart action', async () => {
    const { svc, pc, rendered } = makeService([proc({ name: 'x', status: 'Running', is_ready: 'Ready' })]);
    vi.spyOn(rendered, 'dependsGraph').mockResolvedValue({});

    const res = await svc.control('x', 'restart');

    expect(pc.restart).toHaveBeenCalledWith('x');
    expect(res.ok).toBe(true);
  });

  it('refuses a start blocked on a down dependency and names the culprit', async () => {
    const { svc, pc, rendered } = makeService([
      proc({ name: 'hub-api', status: 'Completed', is_ready: '-' }),
      proc({ name: 'redis', status: 'Completed', is_ready: '-' }),
    ]);
    vi.spyOn(rendered, 'dependsGraph').mockResolvedValue({ 'hub-api': ['redis'] });

    const res = await svc.control('hub-api', 'start');

    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/redis is not ready/);
    expect(pc.start).not.toHaveBeenCalled();
    expect(pc.restart).not.toHaveBeenCalled();
  });
});

describe('RedeployService.control — control-namespace guard', () => {
  const writeCfg = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'lab-catalog-'));
    const cfgPath = join(dir, 'process-compose.yaml');
    writeFileSync(
      cfgPath,
      [
        'processes:',
        '  lab:',
        '    namespace: control',
        '    description: Control Center API',
        '    readiness_probe:',
        '      http_get:',
        '        port: 3002',
        '',
      ].join('\n'),
    );
    return cfgPath;
  };

  it('refuses to stop a control-namespace service (restart-only), without calling pc.stop', async () => {
    const { svc, pc, rendered } = makeService([proc({ name: 'lab', status: 'Running', is_ready: 'Ready' })]);
    vi.spyOn(rendered, 'renderedConfigPath').mockResolvedValue(writeCfg());

    const res = await svc.control('lab', 'stop');

    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/restart-only/);
    expect(pc.stop).not.toHaveBeenCalled();
  });
});

describe('RedeployService — telemetry apply coalescing', () => {
  const origDevenvRoot = process.env.DEVENV_ROOT;
  afterEach(() => {
    if (origDevenvRoot === undefined) delete process.env.DEVENV_ROOT;
    else process.env.DEVENV_ROOT = origDevenvRoot;
  });

  const setup = async () => {
    process.env.DEVENV_ROOT = mkdtempSync(join(tmpdir(), 'lab-telemetry-'));
    const { svc, pc, overlay } = makeService([]);
    await overlay.reseed();
    const apply = vi
      .spyOn(svc as unknown as { applyTelemetry: (enable: boolean, defer: boolean) => Promise<void> }, 'applyTelemetry')
      .mockResolvedValue();
    return { svc, pc, overlay, apply, dir: process.env.DEVENV_ROOT };
  };

  it('serialises concurrent applies and reconciles to the last-written value', async () => {
    const { overlay, apply } = await setup();
    let releaseFirst!: () => void;
    apply.mockImplementationOnce(() => new Promise<void>((r) => (releaseFirst = r)));

    overlay.setStackConfig({ hub: {}, spoke: {}, telemetry: { enable: true } });
    overlay.setStackConfig({ hub: {}, spoke: {}, telemetry: { enable: false } });

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenNthCalledWith(1, true, false);

    releaseFirst();
    await new Promise((r) => setTimeout(r, 0));

    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenNthCalledWith(2, false, false);
  });

  it('defers the hub/spoke reload when a save both disables telemetry and rebinds a port', async () => {
    process.env.DEVENV_ROOT = mkdtempSync(join(tmpdir(), 'lab-telemetry-'));
    const { pc, rendered, overlay } = makeService([proc({ name: 'hub-api' }), proc({ name: 'spoke' })]);
    await overlay.reseed();
    const applyOverlay = vi.spyOn(rendered, 'applyOverlay').mockResolvedValue(null);

    overlay.setStackConfig({ hub: {}, spoke: {}, telemetry: { enable: true } });
    await new Promise((r) => setTimeout(r, 10));
    applyOverlay.mockClear();
    pc.ensureRunning.mockClear();
    pc.ensureStopped.mockClear();
    pc.restart.mockClear();

    overlay.setStackConfig({ hub: {}, spoke: {}, telemetry: { enable: false }, ports: { postgres: 5555 } });
    await new Promise((r) => setTimeout(r, 10));

    expect(overlay.isRebindPending()).toBe(true);
    expect(pc.ensureStopped).toHaveBeenCalledTimes(3);
    expect(applyOverlay).not.toHaveBeenCalled();
    expect(pc.restart).not.toHaveBeenCalled();
  });
});

describe('RedeployService.applyTelemetry — sink lifecycle', () => {
  const applyTelemetry = (svc: RedeployService, enable: boolean, deferReload = false) =>
    (svc as unknown as { applyTelemetry: (e: boolean, d: boolean) => Promise<void> }).applyTelemetry(
      enable,
      deferReload,
    );

  const roster = () => [
    proc({ name: 'hub-api' }),
    proc({ name: 'hub-api-1' }),
    proc({ name: 'hub-web' }),
    proc({ name: 'hub-admin' }),
    proc({ name: 'spoke' }),
    proc({ name: 'spoke-zone2' }),
    proc({ name: 'spoke-telegraf' }),
  ];

  it('starts the sink by name and reloads hub-api + spokes (not hub-web/hub-admin/telegraf)', async () => {
    const { svc, pc, rendered } = makeService(roster());
    vi.spyOn(rendered, 'applyOverlay').mockResolvedValue(null);

    await applyTelemetry(svc, true);

    expect(pc.ensureRunning).toHaveBeenCalledTimes(3);
    for (const n of ['otel-collector', 'tempo', 'grafana']) expect(pc.ensureRunning).toHaveBeenCalledWith(n);
    expect(pc.stop).not.toHaveBeenCalled();
    expect(pc.restart).toHaveBeenCalledWith('hub-api');
    expect(pc.restart).toHaveBeenCalledWith('hub-api-1');
    expect(pc.restart).toHaveBeenCalledWith('spoke');
    expect(pc.restart).toHaveBeenCalledWith('spoke-zone2');
    expect(pc.restart).not.toHaveBeenCalledWith('hub-web');
    expect(pc.restart).not.toHaveBeenCalledWith('hub-admin');
    expect(pc.restart).not.toHaveBeenCalledWith('spoke-telegraf');
    expect(pc.restart).toHaveBeenCalledTimes(4);
  });

  it('stops the sink when disabling (tolerantly, via ensureStopped)', async () => {
    const { svc, pc, rendered } = makeService([proc({ name: 'hub-api' })]);
    vi.spyOn(rendered, 'applyOverlay').mockResolvedValue(null);

    await applyTelemetry(svc, false);

    expect(pc.ensureStopped).toHaveBeenCalledTimes(3);
    for (const n of ['otel-collector', 'tempo', 'grafana']) expect(pc.ensureStopped).toHaveBeenCalledWith(n);
    expect(pc.ensureRunning).not.toHaveBeenCalled();
  });

  it('when deferred, stops the sink on disable but holds the hub/spoke reload + overlay', async () => {
    const { svc, pc, rendered } = makeService(roster());
    const overlay = vi.spyOn(rendered, 'applyOverlay').mockResolvedValue(null);

    await applyTelemetry(svc, false, true);

    expect(pc.ensureStopped).toHaveBeenCalledTimes(3);
    expect(pc.restart).not.toHaveBeenCalled();
    expect(pc.ensureRunning).not.toHaveBeenCalled();
    expect(overlay).not.toHaveBeenCalled();
  });

  it('skips the hub/spoke reload when applyOverlay fails', async () => {
    const { svc, pc, rendered } = makeService(roster());
    vi.spyOn(rendered, 'applyOverlay').mockRejectedValue(new Error('nix eval failed'));

    await applyTelemetry(svc, true);

    expect(pc.ensureRunning).toHaveBeenCalledTimes(3);
    expect(pc.restart).not.toHaveBeenCalled();
  });

  it('when deferred, an enable is a no-op (waits for the Redeploy)', async () => {
    const { svc, pc, rendered } = makeService(roster());
    const overlay = vi.spyOn(rendered, 'applyOverlay').mockResolvedValue(null);

    await applyTelemetry(svc, true, true);

    expect(pc.ensureRunning).not.toHaveBeenCalled();
    expect(pc.stop).not.toHaveBeenCalled();
    expect(pc.restart).not.toHaveBeenCalled();
    expect(overlay).not.toHaveBeenCalled();
  });
});

describe('RedeployService mode-pending guards — D1.6', () => {
  afterEach(() => {
    delete process.env.LOCAL_STATE;
  });

  it('redeploy is blocked (failed run, no restart) while desired ≠ applied', async () => {
    const { svc, pc, overlay } = makeService([proc({ name: 'hub-api', status: 'Running' })]);
    withApplied('vm');
    vi.spyOn(overlay, 'fleetMode').mockReturnValue('baremetal');
    const restartSpy = vi.spyOn(svc, 'restart');

    const run = svc.redeploy();
    await new Promise((r) => setTimeout(r, 10));

    expect(run.status).toBe('failed');
    expect(run.lines.some((l) => l.includes('fleet-mode change is pending'))).toBe(true);
    expect(pc.restart).not.toHaveBeenCalled();
    expect(restartSpy).not.toHaveBeenCalled();
  });

  it('reloadGroup is blocked (no applyOverlay, no restart) while desired ≠ applied', async () => {
    const { svc, pc, rendered, overlay } = makeService([]);
    withApplied('vm');
    vi.spyOn(overlay, 'fleetMode').mockReturnValue('baremetal');
    const applySpy = vi.spyOn(rendered, 'applyOverlay');

    const run = svc.reloadGroup('spoke');
    await new Promise((r) => setTimeout(r, 10));

    expect(run.status).toBe('failed');
    expect(applySpy).not.toHaveBeenCalled();
    expect(pc.restart).not.toHaveBeenCalled();
  });

  it('reloadGroup proceeds (applyOverlay runs) when desired === applied', async () => {
    const { svc, rendered, overlay } = makeService([]);
    withApplied('baremetal');
    vi.spyOn(overlay, 'fleetMode').mockReturnValue('baremetal');
    const applySpy = vi.spyOn(rendered, 'applyOverlay').mockResolvedValue('/repo/cfg.yaml');
    vi.spyOn(rendered, 'catalog').mockResolvedValue(new Map());

    svc.reloadGroup('spoke');
    await new Promise((r) => setTimeout(r, 10));

    expect(applySpy).toHaveBeenCalled();
  });
});

describe('RedeployService — overlay apply is abort-on-throw', () => {
  beforeEach(() => {
    withApplied('vm');
  });
  afterEach(() => {
    delete process.env.LOCAL_STATE;
  });

  it('redeploy hot path: applyOverlay rejection fails the run and issues no restarts', async () => {
    const { svc, pc, rendered, overlay } = makeService([proc({ name: 'hub-api' }), proc({ name: 'spoke' })]);
    vi.spyOn(overlay, 'fleetMode').mockReturnValue('vm');
    vi.spyOn(rendered, 'applyOverlay').mockRejectedValue(new Error('nix eval failed'));

    const run = svc.redeploy();
    await new Promise((r) => setTimeout(r, 10));

    expect(run.status).toBe('failed');
    expect(pc.restart).not.toHaveBeenCalled();
    expect(pc.start).not.toHaveBeenCalled();
    expect(pc.stop).not.toHaveBeenCalled();
  });

  it('reloadGroup: applyOverlay rejection fails the run and issues no restarts', async () => {
    const { svc, pc, rendered } = makeService([proc({ name: 'spoke' })]);
    vi.spyOn(rendered, 'applyOverlay').mockRejectedValue(new Error('nix eval failed'));

    const run = svc.reloadGroup('spoke');
    await new Promise((r) => setTimeout(r, 10));

    expect(run.status).toBe('failed');
    expect(pc.restart).not.toHaveBeenCalled();
    expect(pc.start).not.toHaveBeenCalled();
    expect(pc.stop).not.toHaveBeenCalled();
  });

  it('redeploy hot path: a null applyOverlay is not a failure — restarts run and the run passes', async () => {
    const { svc, pc, rendered } = makeService([proc({ name: 'hub-api' }), proc({ name: 'spoke' })]);
    vi.spyOn(rendered, 'applyOverlay').mockResolvedValue(null);
    vi.spyOn(rendered, 'catalog').mockResolvedValue(catalogOf({ 'hub-api': 'hub', spoke: 'spoke' }));

    const run = svc.redeploy();
    await new Promise((r) => setTimeout(r, 10));

    expect(run.status).toBe('passed');
    expect(pc.restart).toHaveBeenCalledWith('hub-api');
    expect(pc.restart).toHaveBeenCalledWith('spoke');
  });

  it('reloadGroup: a null applyOverlay is not a failure — the group restarts and the run passes', async () => {
    const { svc, pc, rendered } = makeService([proc({ name: 'spoke' }), proc({ name: 'hub-api' })]);
    vi.spyOn(rendered, 'applyOverlay').mockResolvedValue(null);
    vi.spyOn(rendered, 'catalog').mockResolvedValue(catalogOf({ 'hub-api': 'hub', spoke: 'spoke' }));

    const run = svc.reloadGroup('spoke');
    await new Promise((r) => setTimeout(r, 10));

    expect(run.status).toBe('passed');
    expect(pc.restart).toHaveBeenCalledWith('spoke');
    expect(pc.restart).not.toHaveBeenCalledWith('hub-api');
  });

  it('redeploy hot path: overlay apply then rollable roster restart passes', async () => {
    const { svc, pc, rendered } = makeService([proc({ name: 'hub-api' }), proc({ name: 'postgres' })]);
    vi.spyOn(rendered, 'applyOverlay').mockResolvedValue('/repo/cfg.yaml');
    vi.spyOn(rendered, 'catalog').mockResolvedValue(catalogOf({ 'hub-api': 'hub', postgres: 'datastore' }));

    const run = svc.redeploy();
    await new Promise((r) => setTimeout(r, 10));

    expect(run.status).toBe('passed');
    expect(pc.restart).toHaveBeenCalledWith('hub-api');
    expect(pc.restart).not.toHaveBeenCalledWith('postgres');
  });
});

describe('RedeployService — rebind path delegates to StackRestartService', () => {
  const origDevenvRoot = process.env.DEVENV_ROOT;
  beforeEach(() => {
    process.env.DEVENV_ROOT = mkdtempSync(join(tmpdir(), 'lab-rebind-'));
    spawnMock.mockReset();
    withApplied('vm');
  });
  afterEach(() => {
    if (origDevenvRoot === undefined) delete process.env.DEVENV_ROOT;
    else process.env.DEVENV_ROOT = origDevenvRoot;
    delete process.env.LOCAL_STATE;
  });

  it('delegates with the bind reason and no wipe, then clears the latch and passes the run', async () => {
    const { svc, overlay, stackRestart } = makeService([]);
    overlay.armRebindPending();
    const detach = vi.spyOn(stackRestart, 'restartStackDetached').mockResolvedValue();

    const run = svc.redeploy();
    await new Promise((r) => setTimeout(r, 10));

    expect(detach).toHaveBeenCalledWith(run, expect.objectContaining({ reason: 'datastore/LAN bind changed' }));
    expect(detach.mock.calls[0][1].wipe).toBeUndefined();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(run.status).toBe('passed');
    expect(overlay.isRebindPending()).toBe(false);
  });

  it('forwards the slot-change reason and reslot wipe when armed for a slot change', async () => {
    const { svc, overlay, stackRestart } = makeService([]);
    overlay.armRebindPending('slot change', 'stack-reslot');
    const detach = vi.spyOn(stackRestart, 'restartStackDetached').mockResolvedValue();

    const run = svc.redeploy();
    await new Promise((r) => setTimeout(r, 10));

    expect(detach).toHaveBeenCalledWith(
      run,
      expect.objectContaining({ reason: 'slot change', wipe: 'stack-reslot' }),
    );
    expect(run.status).toBe('passed');
    expect(overlay.isRebindPending()).toBe(false);
    expect(overlay.rebindWipeKind()).toBeUndefined();
  });

  it('a no-arg re-arm keeps an earlier slot-change wipe intact', async () => {
    const { overlay } = makeService([]);
    overlay.armRebindPending('slot change', 'stack-reslot');
    overlay.armRebindPending();
    expect(overlay.rebindReasonText()).toBe('slot change');
    expect(overlay.rebindWipeKind()).toBe('stack-reslot');
  });

  it('leaves the latch armed and does not re-finalize when the service refuses', async () => {
    const { svc, overlay, stackRestart, runner } = makeService([]);
    overlay.armRebindPending();
    vi.spyOn(stackRestart, 'restartStackDetached').mockImplementation(async (r) => {
      runner.emit(r, 'refused\n');
      runner.finalize(r, 1);
    });

    const run = svc.redeploy();
    await new Promise((r) => setTimeout(r, 10));

    expect(run.status).toBe('failed');
    expect(overlay.isRebindPending()).toBe(true);
  });

  it('re-arms the rebind latch through the onLaunchFailure hook it passes', async () => {
    const { svc, overlay, stackRestart } = makeService([]);
    overlay.armRebindPending();
    let hook: (() => void) | undefined;
    vi.spyOn(stackRestart, 'restartStackDetached').mockImplementation(async (_r, opts) => {
      hook = opts.onLaunchFailure;
    });

    const run = svc.redeploy();
    await new Promise((r) => setTimeout(r, 10));
    expect(overlay.isRebindPending()).toBe(false);

    hook?.();

    expect(overlay.isRebindPending()).toBe(true);
    expect(run.status).toBe('passed');
  });
});

describe('RedeployService — run bookkeeping', () => {
  beforeEach(() => {
    withApplied('vm');
  });
  afterEach(() => {
    delete process.env.LOCAL_STATE;
  });

  it('registers stack-section runs with redeploy and reload op ids', async () => {
    const { svc, rendered, runner } = makeService([]);
    vi.spyOn(rendered, 'applyOverlay').mockResolvedValue(null);
    vi.spyOn(rendered, 'catalog').mockResolvedValue(new Map());

    svc.redeploy();
    svc.reloadGroup('hub');
    await new Promise((r) => setTimeout(r, 10));

    const opIds = runner.list('stack').map((r) => r.opId);
    expect(opIds).toContain('redeploy');
    expect(opIds).toContain('reload-hub');
  });

  it('a force-finalized (cancelled) run stops at the next phase boundary', async () => {
    const { svc, pc, rendered, runner } = makeService([proc({ name: 'hub-api' })]);
    let release: (v: string | null) => void = () => undefined;
    vi.spyOn(rendered, 'applyOverlay').mockReturnValue(new Promise((r) => (release = r)));

    const run = svc.redeploy();
    run.cancelled = true;
    runner.finalize(run, null);
    release(null);
    await new Promise((r) => setTimeout(r, 10));

    expect(run.status).toBe('cancelled');
    expect(pc.restart).not.toHaveBeenCalled();
  });
});
