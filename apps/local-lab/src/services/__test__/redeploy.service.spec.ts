import { load as loadYaml } from 'js-yaml';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, vi } from 'vitest';

import type { FleetPlanes } from '@repo/local-lab-contract';

import { NULL_RUN_SINK } from '../../runner/run-sink';
import { VM_ONLY } from '../applied-manifest';
import { RunnerService } from '../../runner/runner.service';
import { SudoService } from '../../sudo/sudo.service';
import { OverlayStoreService } from '../overlay-store';
import type { PcProcess, PcProcessConfig, ProcessComposeClient } from '../process-compose.client';
import { RedeployService } from '../redeploy.service';
import { RenderedConfigService, type CatalogEntry } from '../rendered-config.service';
import { StackRestartService } from '../stack-restart.service';
import { useScratchState } from './isolated-state';

const { spawnMock, seedStdout } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  seedStdout: JSON.stringify({
    portGroups: { editable: ['postgres'], readOnly: [] },
    ports: { postgres: 5432 },
    portDefaults: { postgres: 5432 },
    configModel: {
      catalog: [
        {
          path: 'telemetry.enable',
          label: 'Telemetry',
          group: 'Observability',
          description: 'Local OTEL sink toggle.',
          kind: 'bool',
          choices: [],
          default: 'false',
          editable: true,
          danger: false,
          secret: false,
          alias: [],
          overrideFrom: null,
        },
        {
          path: 'ports.postgres',
          label: 'Postgres',
          group: 'Datastores',
          description: 'Postgres listener port.',
          kind: 'port',
          choices: [],
          default: 5432,
          editable: true,
          danger: false,
          secret: false,
          alias: [],
          overrideFrom: null,
        },
      ],
      values: [
        { path: 'telemetry.enable', value: 'false' },
        { path: 'ports.postgres', value: 5432 },
      ],
      provenance: [],
    },
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

const BOTH_PLANES: FleetPlanes = { vm: true, baremetal: true };

const withApplied = (planes: FleetPlanes): void => {
  const dir = mkdtempSync(join(tmpdir(), 'lab-applied-'));
  process.env.LOCAL_STATE = dir;
  mkdirSync(join(dir, 'state', 'run'), { recursive: true });
  const manifest = {
    nodes: planes.vm ? [{ name: 'gpu-1' }] : [],
    bmNodes: planes.baremetal ? [{ name: 'metal-1' }] : [],
  };
  writeFileSync(join(dir, 'state', 'run', 'fleet-applied.json'), JSON.stringify(manifest));
};

function makeService(procs: PcProcess[]) {
  const pc = {
    list: vi.fn(async () => procs.filter((p) => p.status !== 'Disabled')),
    listAll: vi.fn(async () => procs),
    start: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    restartAndWait: vi.fn(async (_name: string) => true),
    waitUntilDepReady: vi.fn(async (_name: string) => true),
    stop: vi.fn(async () => undefined),
    ensureRunning: vi.fn(async () => undefined),
    ensureStopped: vi.fn(async () => undefined),
    tailError: vi.fn(() => undefined),
    projectUpdate: vi.fn(async () => undefined),
    processInfo: vi.fn(async (_name: string): Promise<PcProcessConfig> => ({})),
  };
  const rendered = new RenderedConfigService(pc as unknown as ProcessComposeClient);
  const overlay = new OverlayStoreService(rendered);
  vi.spyOn(overlay, 'planes').mockReturnValue(VM_ONLY);
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

    overlay.setStackConfig({ entries: { 'telemetry.enable': 'true' } });
    overlay.setStackConfig({ entries: { 'telemetry.enable': 'false' } });

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

    overlay.setStackConfig({ entries: { 'telemetry.enable': 'true' } });
    await new Promise((r) => setTimeout(r, 10));
    applyOverlay.mockClear();
    pc.ensureRunning.mockClear();
    pc.ensureStopped.mockClear();
    pc.restart.mockClear();
    pc.restartAndWait.mockClear();

    overlay.setStackConfig({ entries: { 'telemetry.enable': 'false', 'ports.postgres': '5555' } });
    await new Promise((r) => setTimeout(r, 10));

    expect(overlay.isRebindPending()).toBe(true);
    expect(pc.ensureStopped).toHaveBeenCalledTimes(4);
    expect(applyOverlay).not.toHaveBeenCalled();
    expect(pc.restart).not.toHaveBeenCalled();
    expect(pc.restartAndWait).not.toHaveBeenCalled();
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

    expect(pc.ensureRunning).toHaveBeenCalledTimes(4);
    for (const n of ['otel-collector', 'tempo', 'loki', 'grafana']) expect(pc.ensureRunning).toHaveBeenCalledWith(n);
    expect(pc.stop).not.toHaveBeenCalled();
    expect(pc.restartAndWait).toHaveBeenCalledWith('hub-api');
    expect(pc.restartAndWait).toHaveBeenCalledWith('hub-api-1');
    expect(pc.restartAndWait).toHaveBeenCalledWith('spoke');
    expect(pc.restartAndWait).toHaveBeenCalledWith('spoke-zone2');
    expect(pc.restartAndWait).not.toHaveBeenCalledWith('hub-web');
    expect(pc.restartAndWait).not.toHaveBeenCalledWith('hub-admin');
    expect(pc.restartAndWait).not.toHaveBeenCalledWith('spoke-telegraf');
    expect(pc.restartAndWait).toHaveBeenCalledTimes(4);
  });

  it('scopes its overlay apply to the sink and the processes it reloads', async () => {
    const { svc, rendered } = makeService(roster());
    const overlay = vi.spyOn(rendered, 'applyOverlay').mockResolvedValue(null);

    await applyTelemetry(svc, true);

    expect(overlay).toHaveBeenCalledWith(undefined, {
      kind: 'namespaces',
      namespaces: ['observability', 'hub', 'spoke'],
    });
  });

  it('stops the sink when disabling (tolerantly, via ensureStopped)', async () => {
    const { svc, pc, rendered } = makeService([proc({ name: 'hub-api' })]);
    vi.spyOn(rendered, 'applyOverlay').mockResolvedValue(null);

    await applyTelemetry(svc, false);

    expect(pc.ensureStopped).toHaveBeenCalledTimes(4);
    for (const n of ['otel-collector', 'tempo', 'loki', 'grafana']) expect(pc.ensureStopped).toHaveBeenCalledWith(n);
    expect(pc.ensureRunning).not.toHaveBeenCalled();
  });

  it('when deferred, stops the sink on disable but holds the hub/spoke reload + overlay', async () => {
    const { svc, pc, rendered } = makeService(roster());
    const overlay = vi.spyOn(rendered, 'applyOverlay').mockResolvedValue(null);

    await applyTelemetry(svc, false, true);

    expect(pc.ensureStopped).toHaveBeenCalledTimes(4);
    expect(pc.restart).not.toHaveBeenCalled();
    expect(pc.restartAndWait).not.toHaveBeenCalled();
    expect(pc.ensureRunning).not.toHaveBeenCalled();
    expect(overlay).not.toHaveBeenCalled();
  });

  it('skips the hub/spoke reload when applyOverlay fails', async () => {
    const { svc, pc, rendered } = makeService(roster());
    vi.spyOn(rendered, 'applyOverlay').mockRejectedValue(new Error('nix eval failed'));

    await applyTelemetry(svc, true);

    expect(pc.ensureRunning).toHaveBeenCalledTimes(4);
    expect(pc.restart).not.toHaveBeenCalled();
    expect(pc.restartAndWait).not.toHaveBeenCalled();
  });

  it('when deferred, an enable is a no-op (waits for the Redeploy)', async () => {
    const { svc, pc, rendered } = makeService(roster());
    const overlay = vi.spyOn(rendered, 'applyOverlay').mockResolvedValue(null);

    await applyTelemetry(svc, true, true);

    expect(pc.ensureRunning).not.toHaveBeenCalled();
    expect(pc.stop).not.toHaveBeenCalled();
    expect(pc.restart).not.toHaveBeenCalled();
    expect(pc.restartAndWait).not.toHaveBeenCalled();
    expect(overlay).not.toHaveBeenCalled();
  });
});

describe('RedeployService planes-pending guards — D1.6', () => {
  afterEach(() => {
    delete process.env.LOCAL_STATE;
  });

  it('redeploy is blocked (failed run, no restart) while the desired planes differ from the applied ones', async () => {
    const { svc, pc, overlay } = makeService([proc({ name: 'hub-api', status: 'Running' })]);
    withApplied(VM_ONLY);
    vi.spyOn(overlay, 'planes').mockReturnValue(BOTH_PLANES);
    const restartSpy = vi.spyOn(svc, 'restart');

    const run = svc.redeploy();
    await new Promise((r) => setTimeout(r, 10));

    expect(run.status).toBe('failed');
    expect(run.lines.some((l) => l.includes('fleet plane change is pending'))).toBe(true);
    expect(pc.restart).not.toHaveBeenCalled();
    expect(pc.restartAndWait).not.toHaveBeenCalled();
    expect(restartSpy).not.toHaveBeenCalled();
  });

  it('reloadGroup is blocked (no applyOverlay, no restart) while the desired planes differ from the applied ones', async () => {
    const { svc, pc, rendered, overlay } = makeService([]);
    withApplied(VM_ONLY);
    vi.spyOn(overlay, 'planes').mockReturnValue(BOTH_PLANES);
    const applySpy = vi.spyOn(rendered, 'applyOverlay');

    const run = svc.reloadGroup('spoke');
    await new Promise((r) => setTimeout(r, 10));

    expect(run.status).toBe('failed');
    expect(applySpy).not.toHaveBeenCalled();
    expect(pc.restart).not.toHaveBeenCalled();
    expect(pc.restartAndWait).not.toHaveBeenCalled();
  });

  it('reloadGroup proceeds (applyOverlay runs) when the desired planes equal the applied ones', async () => {
    const { svc, rendered, overlay } = makeService([]);
    withApplied(BOTH_PLANES);
    vi.spyOn(overlay, 'planes').mockReturnValue(BOTH_PLANES);
    const applySpy = vi.spyOn(rendered, 'applyOverlay').mockResolvedValue('/repo/cfg.yaml');
    vi.spyOn(rendered, 'catalog').mockResolvedValue(new Map());

    svc.reloadGroup('spoke');
    await new Promise((r) => setTimeout(r, 10));

    expect(applySpy).toHaveBeenCalled();
  });
});

describe('RedeployService — overlay apply is abort-on-throw', () => {
  beforeEach(() => {
    withApplied(VM_ONLY);
  });
  afterEach(() => {
    delete process.env.LOCAL_STATE;
  });

  it('redeploy hot path: applyOverlay rejection fails the run and issues no restarts', async () => {
    const { svc, pc, rendered, overlay } = makeService([proc({ name: 'hub-api' }), proc({ name: 'spoke' })]);
    vi.spyOn(overlay, 'planes').mockReturnValue(VM_ONLY);
    vi.spyOn(rendered, 'applyOverlay').mockRejectedValue(new Error('nix eval failed'));

    const run = svc.redeploy();
    await new Promise((r) => setTimeout(r, 10));

    expect(run.status).toBe('failed');
    expect(pc.restart).not.toHaveBeenCalled();
    expect(pc.restartAndWait).not.toHaveBeenCalled();
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
    expect(pc.restartAndWait).not.toHaveBeenCalled();
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
    expect(pc.restartAndWait).toHaveBeenCalledWith('hub-api');
    expect(pc.restartAndWait).toHaveBeenCalledWith('spoke');
  });

  it('reloadGroup: a null applyOverlay is not a failure — the group restarts and the run passes', async () => {
    const { svc, pc, rendered } = makeService([proc({ name: 'spoke' }), proc({ name: 'hub-api' })]);
    vi.spyOn(rendered, 'applyOverlay').mockResolvedValue(null);
    vi.spyOn(rendered, 'catalog').mockResolvedValue(catalogOf({ 'hub-api': 'hub', spoke: 'spoke' }));

    const run = svc.reloadGroup('spoke');
    await new Promise((r) => setTimeout(r, 10));

    expect(run.status).toBe('passed');
    expect(pc.restartAndWait).toHaveBeenCalledWith('spoke');
    expect(pc.restartAndWait).not.toHaveBeenCalledWith('hub-api');
  });

  it('reloadGroup tells the overlay which group it restarted, so the pending row clears', async () => {
    const { svc, rendered, overlay } = makeService([proc({ name: 'spoke' }), proc({ name: 'hub-api' })]);
    vi.spyOn(rendered, 'applyOverlay').mockResolvedValue(null);
    vi.spyOn(rendered, 'catalog').mockResolvedValue(catalogOf({ 'hub-api': 'hub', spoke: 'spoke' }));
    const cleared = vi.spyOn(overlay, 'clearSatisfiedBy');

    const run = svc.reloadGroup('hub');
    await new Promise((r) => setTimeout(r, 10));

    expect(run.status).toBe('passed');
    expect(cleared).toHaveBeenCalledWith('reload-hub');
  });

  it('reloadGroup names the spoke class for a spoke reload', async () => {
    const { svc, rendered, overlay } = makeService([proc({ name: 'spoke' }), proc({ name: 'hub-api' })]);
    vi.spyOn(rendered, 'applyOverlay').mockResolvedValue(null);
    vi.spyOn(rendered, 'catalog').mockResolvedValue(catalogOf({ 'hub-api': 'hub', spoke: 'spoke' }));
    const cleared = vi.spyOn(overlay, 'clearSatisfiedBy');

    svc.reloadGroup('spoke');
    await new Promise((r) => setTimeout(r, 10));

    expect(cleared).toHaveBeenCalledWith('reload-spoke');
  });

  it('reloadGroup clears nothing when the group never came back', async () => {
    const { svc, pc, rendered, overlay } = makeService([proc({ name: 'hub-api' })]);
    vi.spyOn(rendered, 'applyOverlay').mockResolvedValue(null);
    vi.spyOn(rendered, 'catalog').mockResolvedValue(catalogOf({ 'hub-api': 'hub' }));
    pc.restartAndWait.mockResolvedValue(false);
    const cleared = vi.spyOn(overlay, 'clearSatisfiedBy');

    const run = svc.reloadGroup('hub');
    await new Promise((r) => setTimeout(r, 10));

    expect(run.status).toBe('failed');
    expect(cleared).not.toHaveBeenCalled();
  });

  it('redeploy attempts every service even when one never comes back', async () => {
    const { svc, pc, rendered } = makeService([proc({ name: 'hub-api' }), proc({ name: 'spoke' })]);
    vi.spyOn(rendered, 'applyOverlay').mockResolvedValue(null);
    vi.spyOn(rendered, 'catalog').mockResolvedValue(catalogOf({ 'hub-api': 'hub', spoke: 'spoke' }));
    pc.restartAndWait.mockImplementation(async (name: string) => name !== 'spoke');

    const run = svc.redeploy();
    await new Promise((r) => setTimeout(r, 10));

    expect(run.status).toBe('failed');
    expect(pc.restartAndWait).toHaveBeenCalledWith('hub-api');
    expect(pc.restartAndWait).toHaveBeenCalledWith('spoke');
  });

  it('redeploy names the service that did not restart, not just the count', async () => {
    const { svc, pc, rendered, runner } = makeService([proc({ name: 'hub-api' }), proc({ name: 'spoke' })]);
    vi.spyOn(rendered, 'applyOverlay').mockResolvedValue(null);
    vi.spyOn(rendered, 'catalog').mockResolvedValue(catalogOf({ 'hub-api': 'hub', spoke: 'spoke' }));
    const emitted: string[] = [];
    vi.spyOn(runner, 'emit').mockImplementation((_run, line: string) => {
      emitted.push(line);
    });
    pc.restartAndWait.mockImplementation(async (name: string) => name !== 'spoke');

    svc.redeploy();
    await new Promise((r) => setTimeout(r, 10));

    expect(emitted.join('')).toContain('did not restart: spoke');
    expect(emitted.join('')).toContain('hub-api restarted');
  });

  it('redeploy keeps a rejected restart from abandoning its siblings', async () => {
    const { svc, pc, rendered } = makeService([proc({ name: 'hub-api' }), proc({ name: 'spoke' })]);
    vi.spyOn(rendered, 'applyOverlay').mockResolvedValue(null);
    vi.spyOn(rendered, 'catalog').mockResolvedValue(catalogOf({ 'hub-api': 'hub', spoke: 'spoke' }));
    pc.restartAndWait.mockImplementation(async (name: string) => {
      if (name === 'spoke') throw new Error('socket hung up');
      return true;
    });

    const run = svc.redeploy();
    await new Promise((r) => setTimeout(r, 10));

    expect(run.status).toBe('failed');
    expect(pc.restartAndWait).toHaveBeenCalledWith('hub-api');
  });

  it('reloadGroup fails the run when a group member does not restart', async () => {
    const { svc, pc, rendered } = makeService([proc({ name: 'spoke' })]);
    vi.spyOn(rendered, 'applyOverlay').mockResolvedValue(null);
    vi.spyOn(rendered, 'catalog').mockResolvedValue(catalogOf({ spoke: 'spoke' }));
    pc.restartAndWait.mockImplementation(async () => false);

    const run = svc.reloadGroup('spoke');
    await new Promise((r) => setTimeout(r, 10));

    expect(run.status).toBe('failed');
  });

  it('redeploy hot path: overlay apply then rollable roster restart passes', async () => {
    const { svc, pc, rendered } = makeService([proc({ name: 'hub-api' }), proc({ name: 'postgres' })]);
    vi.spyOn(rendered, 'applyOverlay').mockResolvedValue('/repo/cfg.yaml');
    vi.spyOn(rendered, 'catalog').mockResolvedValue(catalogOf({ 'hub-api': 'hub', postgres: 'datastore' }));

    const run = svc.redeploy();
    await new Promise((r) => setTimeout(r, 10));

    expect(run.status).toBe('passed');
    expect(pc.restartAndWait).toHaveBeenCalledWith('hub-api');
    expect(pc.restartAndWait).not.toHaveBeenCalledWith('postgres');
  });
});

describe('RedeployService — rebind path delegates to StackRestartService', () => {
  const origDevenvRoot = process.env.DEVENV_ROOT;
  beforeEach(() => {
    process.env.DEVENV_ROOT = mkdtempSync(join(tmpdir(), 'lab-rebind-'));
    spawnMock.mockReset();
    withApplied(VM_ONLY);
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

    expect(detach).toHaveBeenCalledWith(run, expect.objectContaining({ reason: 'slot change', wipe: 'stack-reslot' }));
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
    withApplied(VM_ONLY);
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
    expect(pc.restartAndWait).not.toHaveBeenCalled();
  });
});

describe('RedeployService.reloadGroup — apply blast radius', () => {
  useScratchState();

  const RENDERED_HASH = '1111111111111111111111111111111a';
  const LIVE_HASH = '2222222222222222222222222222222b';
  const cmd = (hash: string, name: string): string =>
    `exec /nix/store/zzz-devenv-tasks/bin/devenv-tasks run --task-file /nix/store/${hash}-tasks.json ${name}`;

  const live: Record<string, PcProcessConfig> = {
    'hub-api': { command: cmd(LIVE_HASH, 'hub-api'), environment: ['HUB_PORT=3000'], dependsOn: {}, namespace: 'hub' },
    redis: { command: cmd(LIVE_HASH, 'redis'), environment: ['REDIS_PORT=6379'], dependsOn: {}, namespace: 'datastore' },
    lab: { command: cmd(LIVE_HASH, 'lab'), environment: ['LAB_PORT=3002'], dependsOn: {}, namespace: 'control' },
    'lab-web': {
      command: cmd(LIVE_HASH, 'lab-web'),
      environment: ['LAB_WEB_PORT=5175'],
      dependsOn: {},
      namespace: 'control',
    },
  };

  const writeCfg = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'lab-reload-'));
    const cfgPath = join(dir, 'process-compose.yaml');
    const lines = ['processes:'];
    for (const [name, spec] of Object.entries(live)) {
      lines.push(
        `  ${name}:`,
        `    namespace: ${spec.namespace}`,
        `    command: ${cmd(RENDERED_HASH, name)}`,
        '    environment:',
        `      - ${(spec.environment ?? [])[0]?.split('=')[0]}=9999`,
      );
    }
    writeFileSync(cfgPath, `${lines.join('\n')}\n`);
    return cfgPath;
  };

  beforeEach(() => {
    withApplied(VM_ONLY);
  });
  afterEach(() => {
    delete process.env.LOCAL_STATE;
  });

  const setup = () => {
    const made = makeService(Object.keys(live).map((name) => proc({ name, status: 'Running', is_ready: 'Ready' })));
    made.pc.processInfo.mockImplementation(async (name: string) => live[name]);
    vi.spyOn(made.overlay, 'planes').mockReturnValue(VM_ONLY);
    vi.spyOn(made.rendered, 'renderedConfigPath').mockResolvedValue(writeCfg());
    return made;
  };

  const submittedProcs = (path: unknown): Record<string, Record<string, unknown>> => {
    if (typeof path !== 'string') throw new Error('projectUpdate was not called with a path');
    const doc = loadYaml(readFileSync(path, 'utf8'));
    if (!doc || typeof doc !== 'object' || !('processes' in doc)) throw new Error('submitted config has no processes');
    return JSON.parse(JSON.stringify(doc.processes));
  };

  it('submits a config whose control-namespace specs match what is running', async () => {
    const { svc, pc } = setup();

    const run = svc.reloadGroup('hub');
    await new Promise((r) => setTimeout(r, 20));

    expect(run.status).toBe('passed');
    const procs = submittedProcs(pc.projectUpdate.mock.calls.at(0)?.at(0));
    for (const name of ['lab', 'lab-web']) {
      expect(procs[name].command).toBe(live[name].command);
      expect(procs[name].environment).toEqual(live[name].environment);
    }
  });

  it('leaves the datastore namespace running its own spec and restarts only the hub group', async () => {
    const { svc, pc } = setup();

    svc.reloadGroup('hub');
    await new Promise((r) => setTimeout(r, 20));

    const procs = submittedProcs(pc.projectUpdate.mock.calls.at(0)?.at(0));
    expect(procs.redis.command).toBe(live.redis.command);
    expect(procs['hub-api'].command).toBe(cmd(RENDERED_HASH, 'hub-api'));
    expect(pc.restartAndWait.mock.calls.map(([name]) => name)).toEqual(['hub-api']);
  });
});

describe('RedeployService — the reload restarts its group in dependency order', () => {
  const hubGroup = () => [
    proc({ name: 'hub-api' }),
    proc({ name: 'hub-admin' }),
    proc({ name: 'hub-web' }),
    proc({ name: 'hub-web-admin' }),
  ];
  const hubCatalog = () =>
    catalogOf({ 'hub-api': 'hub', 'hub-admin': 'hub', 'hub-web': 'hub', 'hub-web-admin': 'hub' });
  const hubGraph = () => ({
    'hub-web': ['hub-api'],
    'hub-admin': ['hub-api'],
    'hub-web-admin': ['hub-admin'],
    'hub-api': ['redis'],
  });

  const traced = (procs: PcProcess[], graph: Record<string, string[]>) => {
    const made = makeService(procs);
    vi.spyOn(made.rendered, 'applyOverlay').mockResolvedValue(null);
    vi.spyOn(made.rendered, 'catalog').mockResolvedValue(hubCatalog());
    vi.spyOn(made.rendered, 'dependsGraph').mockResolvedValue(graph);
    const order: string[] = [];
    made.pc.restartAndWait.mockImplementation(async (name: string) => {
      order.push(`restart ${name}`);
      return true;
    });
    made.pc.waitUntilDepReady.mockImplementation(async (name: string) => {
      order.push(`ready ${name}`);
      return true;
    });
    return { ...made, order };
  };

  it('holds a dependent until its in-group dependency reports ready', async () => {
    const { svc, order } = traced(hubGroup(), hubGraph());

    const run = svc.reloadGroup('hub');
    await new Promise((r) => setTimeout(r, 20));

    expect(run.status).toBe('passed');
    expect(order.indexOf('ready hub-api')).toBeLessThan(order.indexOf('restart hub-admin'));
    expect(order.indexOf('ready hub-api')).toBeLessThan(order.indexOf('restart hub-web'));
    expect(order.indexOf('ready hub-admin')).toBeLessThan(order.indexOf('restart hub-web-admin'));
  });

  it('restarts independent siblings in one level rather than serialising them', async () => {
    const { svc, order } = traced(hubGroup(), hubGraph());

    svc.reloadGroup('hub');
    await new Promise((r) => setTimeout(r, 20));

    expect(order.indexOf('restart hub-web')).toBeLessThan(order.indexOf('ready hub-admin'));
  });

  it('never restarts a dependent whose dependency did not come back ready', async () => {
    const { svc, pc, order } = traced(hubGroup(), hubGraph());
    pc.waitUntilDepReady.mockImplementation(async (name: string) => {
      order.push(`ready ${name}`);
      return name !== 'hub-api';
    });

    const run = svc.reloadGroup('hub');
    await new Promise((r) => setTimeout(r, 20));

    expect(run.status).toBe('failed');
    expect(order).toEqual(['restart hub-api', 'ready hub-api']);
    expect(pc.restartAndWait).not.toHaveBeenCalledWith('hub-admin');
  });

  it('still restarts a later-level service whose own dependency came back', async () => {
    const procs = [proc({ name: 'hub-api' }), proc({ name: 'hub-admin' }), proc({ name: 'hub-web-admin' })];
    const made = makeService(procs);
    vi.spyOn(made.rendered, 'applyOverlay').mockResolvedValue(null);
    vi.spyOn(made.rendered, 'catalog').mockResolvedValue(
      catalogOf({ 'hub-api': 'hub', 'hub-admin': 'hub', 'hub-web-admin': 'hub' }),
    );
    vi.spyOn(made.rendered, 'dependsGraph').mockResolvedValue({ 'hub-web-admin': ['hub-admin'] });
    made.pc.restartAndWait.mockResolvedValue(true);
    made.pc.waitUntilDepReady.mockImplementation(async (name: string) => name !== 'hub-api');

    const run = made.svc.reloadGroup('hub');
    await new Promise((r) => setTimeout(r, 20));

    expect(run.status).toBe('failed');
    expect(made.pc.restartAndWait).toHaveBeenCalledWith('hub-web-admin');
  });

  it('reports a service held back by a failed dependency as skipped, not as a failed restart', async () => {
    const { svc, pc, runner } = traced(hubGroup(), hubGraph());
    pc.waitUntilDepReady.mockImplementation(async (name: string) => name !== 'hub-api');
    const emitted: string[] = [];
    vi.spyOn(runner, 'emit').mockImplementation((_run, line: string) => {
      emitted.push(line);
    });

    const run = svc.reloadGroup('hub');
    await new Promise((r) => setTimeout(r, 20));

    const log = emitted.join('');
    expect(run.status).toBe('failed');
    expect(log).toContain('hub-admin skipped — a dependency did not come back');
    expect(log).not.toContain('hub-admin did not restart');
    expect(log).toContain('skipped after a dependency failed: ');
    expect(log).toContain('did not restart: hub-api');
  });

  it('names a probe that never passed instead of failing with an empty diagnostic', async () => {
    const { svc, pc, runner } = traced(
      [proc({ name: 'hub-api', status: 'Running', is_ready: '-', has_ready_probe: true })],
      {},
    );
    pc.waitUntilDepReady.mockResolvedValue(false);
    const emitted: string[] = [];
    vi.spyOn(runner, 'emit').mockImplementation((_run, line: string) => {
      emitted.push(line);
    });

    const run = svc.reloadGroup('hub');
    await new Promise((r) => setTimeout(r, 30));

    expect(run.status).toBe('failed');
    expect(emitted.join('')).toContain('hub-api is Running but its readiness probe has not passed');
  });

  it('hands a wedged service to the reconcile ladder and passes when it comes back', async () => {
    const procs = [proc({ name: 'hub-api', status: 'Skipped', is_ready: '-' })];
    const { svc, pc, runner } = traced(procs, {});
    pc.waitUntilDepReady.mockResolvedValue(false);
    const emitted: string[] = [];
    vi.spyOn(runner, 'emit').mockImplementation((_run, line: string) => {
      emitted.push(line);
    });
    const spawn = vi.spyOn(runner, 'spawn').mockImplementation(async () => {
      procs[0].status = 'Running';
      procs[0].is_ready = 'Ready';
      return 0;
    });

    const run = svc.reloadGroup('hub');
    await new Promise((r) => setTimeout(r, 40));

    expect(spawn).toHaveBeenCalledWith(expect.anything(), 'stack-reconcile', []);
    expect(emitted.join('')).toContain('recovered hub-api');
    expect(run.status).toBe('passed');
  });

  it('passes when the reconcile exits non-zero but the services come back', async () => {
    const procs = [proc({ name: 'hub-api', status: 'Skipped', is_ready: '-' })];
    const { svc, pc, runner } = traced(procs, {});
    pc.waitUntilDepReady.mockResolvedValue(false);
    const emitted: string[] = [];
    vi.spyOn(runner, 'emit').mockImplementation((_run, line: string) => {
      emitted.push(line);
    });
    vi.spyOn(runner, 'spawn').mockImplementation(async () => {
      procs[0].status = 'Running';
      procs[0].is_ready = 'Ready';
      return 1;
    });

    const run = svc.reloadGroup('hub');
    await new Promise((r) => setTimeout(r, 40));

    expect(run.status).toBe('passed');
    expect(emitted.join('')).toContain('reconcile exited 1');
    expect(emitted.join('')).toContain('recovered hub-api');
  });

  it('still fails when the reconcile ladder does not bring the wedged service back', async () => {
    const procs = [proc({ name: 'hub-api', status: 'Skipped', is_ready: '-' })];
    const { svc, pc, runner } = traced(procs, {});
    pc.waitUntilDepReady.mockResolvedValue(false);
    const emitted: string[] = [];
    vi.spyOn(runner, 'emit').mockImplementation((_run, line: string) => {
      emitted.push(line);
    });
    vi.spyOn(runner, 'spawn').mockResolvedValue(0);

    const run = svc.reloadGroup('hub');
    await new Promise((r) => setTimeout(r, 40));

    expect(run.status).toBe('failed');
    expect(emitted.join('')).toContain('did not restart: hub-api');
    expect(emitted.join('')).not.toContain('recovered');
  });

  it('does not reconcile when nothing the restart reported is actually down', async () => {
    const { svc, pc, runner } = traced([proc({ name: 'hub-api' })], {});
    pc.waitUntilDepReady.mockResolvedValue(false);
    const spawn = vi.spyOn(runner, 'spawn').mockResolvedValue(0);

    const run = svc.reloadGroup('hub');
    await new Promise((r) => setTimeout(r, 40));

    expect(spawn).not.toHaveBeenCalled();
    expect(run.status).toBe('failed');
  });

  it('treats a restarted-but-never-ready service as failed, not restarted', async () => {
    const { svc, pc, runner } = traced([proc({ name: 'hub-api' })], {});
    pc.waitUntilDepReady.mockResolvedValue(false);
    const emitted: string[] = [];
    vi.spyOn(runner, 'emit').mockImplementation((_run, line: string) => {
      emitted.push(line);
    });

    const run = svc.reloadGroup('hub');
    await new Promise((r) => setTimeout(r, 20));

    expect(run.status).toBe('failed');
    expect(emitted.join('')).toContain('did not restart: hub-api');
  });

  it('ignores a dependency outside the group when ordering the restart', async () => {
    const { svc, order } = traced([proc({ name: 'hub-api' })], hubGraph());

    const run = svc.reloadGroup('hub');
    await new Promise((r) => setTimeout(r, 20));

    expect(run.status).toBe('passed');
    expect(order).toEqual(['restart hub-api', 'ready hub-api']);
  });
});

describe('RedeployService — a run is judged on the state it leaves behind', () => {
  const emitting = (procs: PcProcess[], graph: Record<string, string[]> = {}) => {
    const made = makeService(procs);
    vi.spyOn(made.rendered, 'applyOverlay').mockResolvedValue(null);
    vi.spyOn(made.rendered, 'catalog').mockResolvedValue(
      catalogOf(Object.fromEntries(procs.map((p) => [p.name, p.name === 'redis' ? 'datastore' : 'hub']))),
    );
    vi.spyOn(made.rendered, 'dependsGraph').mockResolvedValue(graph);
    const emitted: string[] = [];
    vi.spyOn(made.runner, 'emit').mockImplementation((_run, line: string) => {
      emitted.push(line);
    });
    return { ...made, emitted };
  };

  it('fails a reload whose every restart call succeeded but left the group Skipped', async () => {
    const { svc, pc, emitted } = emitting([
      proc({ name: 'hub-api', status: 'Skipped', is_ready: '-' }),
      proc({ name: 'hub-web', status: 'Skipped', is_ready: '-' }),
    ]);

    const run = svc.reloadGroup('hub');
    await new Promise((r) => setTimeout(r, 20));

    expect(pc.restartAndWait).toHaveBeenCalledWith('hub-api');
    expect(run.status).toBe('failed');
    expect(emitted.join('')).toContain('down after the restart: hub-api, hub-web');
  });

  it('names the out-of-scope dependency and points at Redeploy for a hub-api left Skipped', async () => {
    const { svc, emitted } = emitting([proc({ name: 'hub-api', status: 'Skipped', is_ready: '-' })], {
      'hub-api': ['redis'],
    });

    const run = svc.reloadGroup('hub');
    await new Promise((r) => setTimeout(r, 20));

    expect(run.status).toBe('failed');
    expect(emitted.join('')).toContain('hub-api is Skipped — only restarting redis clears that');
    expect(emitted.join('')).toContain('run Redeploy');
  });

  it('does not blame an out-of-scope dependency when the culprit is inside the group', async () => {
    const { svc, emitted } = emitting(
      [proc({ name: 'hub-api', status: 'Running', is_ready: 'Ready' }), proc({ name: 'hub-web', status: 'Skipped' })],
      { 'hub-web': ['hub-api'] },
    );

    const run = svc.reloadGroup('hub');
    await new Promise((r) => setTimeout(r, 20));

    expect(run.status).toBe('failed');
    expect(emitted.join('')).toContain('hub-web is Skipped');
    expect(emitted.join('')).not.toContain('run Redeploy');
  });

  it('reports a non-Skipped straggler by the status it actually holds', async () => {
    const { svc, emitted } = emitting([proc({ name: 'hub-api', status: 'Error', is_ready: '-' })]);

    const run = svc.reloadGroup('hub');
    await new Promise((r) => setTimeout(r, 20));

    expect(run.status).toBe('failed');
    expect(emitted.join('')).toContain('hub-api is Error');
  });

  it('fails a redeploy that leaves a rollable service down', async () => {
    const { svc, overlay, emitted } = emitting([
      proc({ name: 'hub-api', status: 'Skipped', is_ready: '-' }),
      proc({ name: 'redis', status: 'Running', is_ready: 'Ready' }),
    ]);
    const cleared = vi.spyOn(overlay, 'clearSatisfiedBy');

    const run = svc.redeploy();
    await new Promise((r) => setTimeout(r, 20));

    expect(run.status).toBe('failed');
    expect(emitted.join('')).toContain('down after the restart: hub-api');
    expect(cleared).not.toHaveBeenCalled();
  });
});
