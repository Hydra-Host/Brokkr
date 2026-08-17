import { ConflictException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OverlayStoreService } from '../overlay-store';
import { ProcessComposeClient } from '../process-compose.client';
import { RenderedConfigService } from '../rendered-config.service';
import { StackRegistryClient } from '../stack-registry-client';

const EVAL_SEED = {
  portGroups: {
    editable: [
      'mailpitSmtp',
      'mailpitWeb',
      'nginx',
      'postgres',
      'redfish',
      'redis',
      'thanosGrpc',
      'thanosHttp',
      'thanosRemoteWrite',
    ],
    readOnly: ['grafana', 'otlpGrpc', 'otlpHttp', 'tempoHttp'],
  },
  ports: {
    mailpitSmtp: 1025,
    mailpitWeb: 8025,
    nginx: 8888,
    postgres: 5432,
    redfish: 8443,
    redis: 6379,
    thanosGrpc: 10901,
    thanosHttp: 10902,
    thanosRemoteWrite: 19291,
    grafana: 4300,
    otlpGrpc: 4317,
    otlpHttp: 4318,
    tempoHttp: 3200,
  },
  portDefaults: {
    mailpitSmtp: 1025,
    mailpitWeb: 8025,
    nginx: 8888,
    postgres: 5432,
    redfish: 8443,
    redis: 6379,
    thanosGrpc: 10901,
    thanosHttp: 10902,
    thanosRemoteWrite: 19291,
  },
  stackDefaults: {
    hub: { LOG_LEVEL: 'debug', LOCAL_SIMULATION_ENABLED: 'false', VITE_LOCAL_SIMULATION_ENABLED: 'true' },
    spoke: { LIFECYCLE_WORKER_CONCURRENCY: '7' },
    hubKnobEnv: { AUTH_BYPASS_ENABLED: ['LOCAL_SIMULATION_ENABLED', 'VITE_LOCAL_SIMULATION_ENABLED'] },
  },
  labBridges: [
    { proc: 'spoke', zone: 'sim-zone', replica: 0, port: 8000, grpc: 9082 },
    { proc: 'spoke-edge', zone: 'edge-zone', replica: 0, port: 8100, grpc: 9182 },
  ],
  identity: { pg: { user: 'labpg', password: 'labpass', db: 'labdb' }, orgId: 'org-uuid' },
  osLayerCache: { originHost: 'brokkr.assets.hydra.host', resolvers: '1.1.1.1 8.8.8.8' },
};
const evalSeedJson = (extra: Record<string, unknown> = {}): string => JSON.stringify({ ...EVAL_SEED, ...extra });

const { nicState, seedEval } = vi.hoisted(() => ({
  nicState: { value: {} as Record<string, { family: string; address: string; internal: boolean }[]> },
  seedEval: { stdout: '{}', error: null as Error | null },
}));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, networkInterfaces: () => nicState.value };
});
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (
      _file: string,
      _args: string[],
      _opts: object,
      cb: (err: Error | null, out: { stdout: string; stderr: string }) => void,
    ) => cb(seedEval.error, { stdout: seedEval.stdout, stderr: '' }),
  };
});

function makeOverlay(): OverlayStoreService {
  return new OverlayStoreService(new RenderedConfigService(new ProcessComposeClient()));
}

const origDevenvRoot = process.env.DEVENV_ROOT;
const createdDirs: string[] = [];
beforeEach(() => {
  seedEval.stdout = evalSeedJson();
  seedEval.error = null;
});
afterEach(() => {
  if (origDevenvRoot === undefined) delete process.env.DEVENV_ROOT;
  else process.env.DEVENV_ROOT = origDevenvRoot;
  nicState.value = {};
  seedEval.stdout = evalSeedJson();
  seedEval.error = null;
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
  createdDirs.length = 0;
});

function setupUnseeded(): { overlay: OverlayStoreService; dir: string } {
  process.env.DEVENV_ROOT = mkdtempSync(join(tmpdir(), 'lab-overlay-'));
  createdDirs.push(process.env.DEVENV_ROOT);
  return { overlay: makeOverlay(), dir: process.env.DEVENV_ROOT };
}

async function setupWithRoot(): Promise<{ overlay: OverlayStoreService; dir: string }> {
  const ctx = setupUnseeded();
  await ctx.overlay.reseed();
  return ctx;
}

describe('OverlayStoreService — telemetry + rebind latch', () => {
  it('writes telemetry.enable into the stack.local.nix overlay', async () => {
    const { overlay, dir } = await setupWithRoot();
    await overlay.setStackConfig({ hub: {}, spoke: {}, telemetry: { enable: true } });
    expect(readFileSync(join(dir, 'stack.local.nix'), 'utf8')).toContain('telemetry.enable = true;');
  });

  it('invokes the registered apply hook only when telemetry.enable changes', async () => {
    const { overlay } = await setupWithRoot();
    const hook = vi.fn();
    overlay.registerTelemetryApplyHook(hook);
    await overlay.setStackConfig({ hub: {}, spoke: {}, telemetry: { enable: true } });
    expect(hook).toHaveBeenCalledTimes(1);
    hook.mockClear();
    await overlay.setStackConfig({ hub: {}, spoke: {}, telemetry: { enable: true } });
    expect(hook).not.toHaveBeenCalled();
  });

  it('surfaces telemetry + read-only observability ports from stackConfig()', async () => {
    const { overlay } = await setupWithRoot();
    await overlay.setStackConfig({ hub: {}, spoke: {}, telemetry: { enable: true } });

    const cfg = overlay.stackConfig();
    expect(cfg.telemetry).toEqual({ enable: true });
    expect(cfg.servicePorts.find((p) => p.key === 'grafana')).toMatchObject({ readOnly: true, value: 4300 });

    await overlay.setStackConfig({ hub: {}, spoke: {}, telemetry: { enable: false } });
    expect(overlay.stackConfig().telemetry).toEqual({ enable: false });
  });

  it('arms the rebind latch on a datastore-port change', async () => {
    const { overlay } = await setupWithRoot();
    await overlay.setStackConfig({ hub: {}, spoke: {}, ports: { postgres: 5433 } });
    expect(overlay.isRebindPending()).toBe(true);
  });

  it('arms the rebind latch on a LAN-bind change', async () => {
    const { overlay } = await setupWithRoot();
    await overlay.setStackConfig({ hub: {}, spoke: {}, lan: { expose: true } });
    expect(overlay.isRebindPending()).toBe(true);
  });

  it('does not arm the latch for a telemetry-only save (but still invokes the hook)', async () => {
    const { overlay } = await setupWithRoot();
    const hook = vi.fn();
    overlay.registerTelemetryApplyHook(hook);
    await overlay.setStackConfig({ hub: {}, spoke: {}, telemetry: { enable: true } });
    expect(overlay.isRebindPending()).toBe(false);
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('does not invoke the hook for a rebind-only save (telemetry unchanged)', async () => {
    const { overlay } = await setupWithRoot();
    const hook = vi.fn();
    overlay.registerTelemetryApplyHook(hook);
    await overlay.setStackConfig({ hub: {}, spoke: {}, ports: { postgres: 5433 } });
    expect(hook).not.toHaveBeenCalled();
    expect(overlay.isRebindPending()).toBe(true);
  });

  it('writes stack.local.nix atomically via tmp+rename, leaving no .tmp residue', async () => {
    const { overlay, dir } = await setupWithRoot();
    await overlay.setStackConfig({ hub: {}, spoke: {}, telemetry: { enable: true } });
    const finalPath = join(dir, 'stack.local.nix');
    expect(renameSync).toHaveBeenCalledWith(`${finalPath}.tmp`, finalPath);
    expect(readFileSync(finalPath, 'utf8')).toContain('telemetry.enable = true;');
    expect(readdirSync(dir)).toEqual(['stack.local.nix']);
  });

  it('propagates a renameSync failure (writeOverlay has no try/catch)', async () => {
    const { overlay } = await setupWithRoot();
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error('rename boom');
    });
    await expect(overlay.setStackConfig({ hub: {}, spoke: {}, telemetry: { enable: true } })).rejects.toThrow('rename boom');
  });
});

describe('OverlayStoreService.stackConfig — the Nix eval is the source', () => {
  it('renders the editable port rows from portGroups.editable, mailpit included', async () => {
    const { overlay } = await setupWithRoot();

    const editable = overlay
      .stackConfig()
      .servicePorts.filter((p) => !p.readOnly)
      .map((p) => [p.key, p.value]);

    expect(editable).toEqual([
      ['mailpitSmtp', 1025],
      ['mailpitWeb', 8025],
      ['nginx', 8888],
      ['postgres', 5432],
      ['redfish', 8443],
      ['redis', 6379],
      ['thanosGrpc', 10901],
      ['thanosHttp', 10902],
      ['thanosRemoteWrite', 19291],
    ]);
  });

  it('resolves the spoke lifecycle concurrency from stackDefaults, not the declared literal', async () => {
    const { overlay } = await setupWithRoot();

    expect(overlay.stackConfig().knobs.spoke.find((k) => k.env === 'LIFECYCLE_WORKER_CONCURRENCY')?.default).toBe('7');
    expect(overlay.stackSummary().lifecycleWorkerConcurrency).toBe(7);
  });

  it('resolves the AUTH_BYPASS_ENABLED default through hubKnobEnv, not the declared literal', async () => {
    const { overlay } = await setupWithRoot();

    expect(overlay.stackConfig().knobs.hub.find((k) => k.env === 'AUTH_BYPASS_ENABLED')?.default).toBe('false');
  });

  it('derives the Postgres URL default from the saved identity and port', async () => {
    const { overlay } = await setupWithRoot();
    await overlay.setStackConfig({
      hub: {},
      spoke: {},
      identity: { pg: { user: 'lab', password: 'sekrit', db: 'labdb' } },
      ports: { postgres: 5433 },
    });

    expect(overlay.stackConfig().knobs.hub.find((k) => k.env === 'DATABASE_URL')?.default).toBe(
      'postgresql://lab:sekrit@127.0.0.1:5433/labdb',
    );
  });

  it('surfaces the labBridges roster instead of re-deriving zone/replica port math', async () => {
    const { overlay } = await setupWithRoot();

    expect(overlay.labBridges()).toEqual([
      { proc: 'spoke', zone: 'sim-zone', replica: 0, port: 8000, grpc: 9082 },
      { proc: 'spoke-edge', zone: 'edge-zone', replica: 0, port: 8100, grpc: 9182 },
    ]);
  });

  it('keeps a blank identity field on its effective value instead of resetting it', async () => {
    const { overlay } = await setupWithRoot();
    await overlay.setStackConfig({ hub: {}, spoke: {}, identity: { pg: { user: '  ' } } });

    expect(overlay.stackConfig().identity.pg.user).toBe('labpg');
  });
});

describe('OverlayStoreService — port pins are diffed against the Nix-published defaults', () => {
  async function setupPrePinned(): Promise<{ overlay: OverlayStoreService; path: string }> {
    process.env.DEVENV_ROOT = mkdtempSync(join(tmpdir(), 'lab-overlay-'));
    createdDirs.push(process.env.DEVENV_ROOT);
    const path = join(process.env.DEVENV_ROOT, 'stack.local.nix');
    writeFileSync(path, '{ ... }:\n{\n  ports.postgres = 5433;\n}\n');
    seedEval.stdout = evalSeedJson({ ports: { ...EVAL_SEED.ports, postgres: 5433 } });
    const overlay = makeOverlay();
    await overlay.reseed();
    return { overlay, path };
  }

  it('preserves an override the overlay already pinned before this process ever ran', async () => {
    const { overlay, path } = await setupPrePinned();

    await overlay.setStackConfig({ hub: {}, spoke: {}, ports: { postgres: 5433 } });

    expect(readFileSync(path, 'utf8')).toContain('ports.postgres = 5433;');
  });

  it('drops a pre-existing pin when the operator restores the port to its Nix default', async () => {
    const { overlay, path } = await setupPrePinned();

    await overlay.setStackConfig({ hub: {}, spoke: {}, ports: { postgres: 5432 } });

    expect(readFileSync(path, 'utf8')).not.toContain('ports.postgres');
  });

  it('drops the pin when a port overridden in this session is restored', async () => {
    const { overlay, dir } = await setupWithRoot();
    const path = join(dir, 'stack.local.nix');

    await overlay.setStackConfig({ hub: {}, spoke: {}, ports: { postgres: 5433 } });
    expect(readFileSync(path, 'utf8')).toContain('ports.postgres = 5433;');

    await overlay.setStackConfig({ hub: {}, spoke: {}, ports: { postgres: 5432 } });
    expect(readFileSync(path, 'utf8')).not.toContain('ports.postgres');
  });

  it('shows the pinned value in servicePorts rather than the Nix default', async () => {
    const { overlay } = await setupPrePinned();

    expect(overlay.stackConfig().servicePorts.find((p) => p.key === 'postgres')?.value).toBe(5433);
  });

  it('drops the pin when the operator blanks the field and the editor omits the key', async () => {
    const { overlay, path } = await setupPrePinned();

    await overlay.setStackConfig({ hub: {}, spoke: {}, ports: {} });

    expect(readFileSync(path, 'utf8')).not.toContain('ports.postgres');
    expect(overlay.stackConfig().servicePorts.find((p) => p.key === 'postgres')?.value).toBe(5432);
  });

  it('drops the pin and reports the key rejected when the value is out of range', async () => {
    const { overlay, path } = await setupPrePinned();

    const res = await overlay.setStackConfig({ hub: {}, spoke: {}, ports: { postgres: 99999 } });

    expect(res.rejected).toContain('ports.postgres');
    expect(readFileSync(path, 'utf8')).not.toContain('ports.postgres');
  });

  it('keeps the pin on a save that carries no ports object at all', async () => {
    const { overlay, path } = await setupPrePinned();

    await overlay.setStackConfig({ hub: {}, spoke: {}, telemetry: { enable: true } });

    expect(readFileSync(path, 'utf8')).toContain('ports.postgres = 5433;');
  });

  it('reports a pre-existing pin as applied and a default-valued port as neither', async () => {
    const { overlay } = await setupPrePinned();

    const res = await overlay.setStackConfig({ hub: {}, spoke: {}, ports: { postgres: 5433, redis: 6379 } });

    expect(res.applied).toContain('ports.postgres');
    expect(res.applied).not.toContain('ports.redis');
    expect(res.rejected).toEqual([]);
  });
});

describe('OverlayStoreService.setStackConfig — applied/rejected reporting', () => {
  it('reports an unknown hub env key as rejected', async () => {
    const { overlay } = await setupWithRoot();
    const res = await overlay.setStackConfig({ hub: { NOPE: 'x' }, spoke: {} });
    expect(res.rejected).toContain('hub.NOPE');
    expect(res.applied).not.toContain('hub.NOPE');
  });

  it('applies a known non-blank hub env key', async () => {
    const { overlay } = await setupWithRoot();
    const res = await overlay.setStackConfig({ hub: { LOG_LEVEL: 'info' }, spoke: {} });
    expect(res.applied).toContain('hub.LOG_LEVEL');
  });

  it('lists a blank known env value in neither array', async () => {
    const { overlay } = await setupWithRoot();
    const res = await overlay.setStackConfig({ hub: { LOG_LEVEL: '   ' }, spoke: {} });
    expect(res.applied).not.toContain('hub.LOG_LEVEL');
    expect(res.rejected).not.toContain('hub.LOG_LEVEL');
  });

  it('applies a known non-blank spoke env key and rejects an unknown spoke key', async () => {
    const { overlay } = await setupWithRoot();
    const res = await overlay.setStackConfig({ hub: {}, spoke: { LIFECYCLE_WORKER_CONCURRENCY: '5', NOPE: 'x' } });
    expect(res.applied).toContain('spoke.LIFECYCLE_WORKER_CONCURRENCY');
    expect(res.rejected).toContain('spoke.NOPE');
  });

  it('applies a valid editable port', async () => {
    const { overlay } = await setupWithRoot();
    const res = await overlay.setStackConfig({ hub: {}, spoke: {}, ports: { postgres: 5433 } });
    expect(res.applied).toContain('ports.postgres');
  });

  it('lists a default-valued editable port in neither array', async () => {
    const { overlay } = await setupWithRoot();
    const res = await overlay.setStackConfig({ hub: {}, spoke: {}, ports: { postgres: 5432 } });
    expect(res.applied).not.toContain('ports.postgres');
    expect(res.rejected).not.toContain('ports.postgres');
  });

  it('rejects a read-only observability port and an unknown port key', async () => {
    const { overlay } = await setupWithRoot();
    const res = await overlay.setStackConfig({ hub: {}, spoke: {}, ports: { grafana: 4300, bogus: 1234 } });
    expect(res.rejected).toEqual(expect.arrayContaining(['ports.grafana', 'ports.bogus']));
    expect(res.applied).not.toContain('ports.grafana');
  });

  it('returns empty arrays for a telemetry-only save', async () => {
    const { overlay } = await setupWithRoot();
    const res = await overlay.setStackConfig({ hub: {}, spoke: {}, telemetry: { enable: true } });
    expect(res.applied).toEqual([]);
    expect(res.rejected).toEqual([]);
  });
});

describe('OverlayStoreService — a reseed that fails after an earlier success stops trusting the mirror', () => {
  const OWNED_OVERLAY = [
    '{ ... }:',
    '{',
    '  ports.postgres = 5433;',
    '  fleet.zones."sim-zone".nodes."gpu-1" = { "index" = 0; };',
    '}',
    '',
  ].join('\n');

  async function setupSeededThenFailed(): Promise<{ overlay: OverlayStoreService; path: string }> {
    seedEval.stdout = JSON.stringify({ identity: { pg: { user: 'seededuser' } } });
    const { overlay, dir } = setupUnseeded();
    await overlay.reseed();
    const path = join(dir, 'stack.local.nix');
    writeFileSync(path, OWNED_OVERLAY);
    seedEval.error = new Error('devenv eval failed');
    await overlay.reseed();
    return { overlay, path };
  }

  it('refuses the write and leaves stack.local.nix byte-unchanged', async () => {
    const { overlay, path } = await setupSeededThenFailed();
    const before = readFileSync(path);

    await expect(overlay.setStackConfig({ hub: {}, spoke: {}, telemetry: { enable: true } })).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it('keeps serving the last successful values rather than bare defaults', async () => {
    const { overlay } = await setupSeededThenFailed();

    expect(overlay.stackConfig().identity.pg.user).toBe('seededuser');
  });
});

describe('OverlayStoreService — writes are refused while the devenv seed has never succeeded', () => {
  const EXISTING_OVERLAY = [
    '{ ... }:',
    '{',
    '  ports.postgres = 5433;',
    '  fleet.zones."sim-zone".nodes."gpu-1" = { "index" = 0; };',
    '}',
    '',
  ].join('\n');

  async function setupFailedSeed(): Promise<{ overlay: OverlayStoreService; path: string }> {
    seedEval.error = new Error('devenv eval failed: $ devenv init');
    const { overlay, dir } = setupUnseeded();
    const path = join(dir, 'stack.local.nix');
    writeFileSync(path, EXISTING_OVERLAY);
    await overlay.reseed();
    return { overlay, path };
  }

  it('setStackConfig throws ServiceUnavailableException and leaves stack.local.nix byte-unchanged', async () => {
    const { overlay, path } = await setupFailedSeed();
    const before = readFileSync(path);

    await expect(overlay.setStackConfig({ hub: {}, spoke: {}, telemetry: { enable: true } })).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it('setFleetConfig throws ServiceUnavailableException and leaves stack.local.nix byte-unchanged', async () => {
    const { overlay, path } = await setupFailedSeed();
    const before = readFileSync(path);

    expect(() => overlay.setFleetConfig({ nodes: [{ name: 'cpu-1', spec: { cpus: 2 } }] })).toThrow(
      ServiceUnavailableException,
    );
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it('keeps serving defaults on the read paths while refusing the writes', async () => {
    const { overlay } = await setupFailedSeed();

    expect(overlay.stackConfig().counts).toEqual({ hub: 1, spoke: 1 });
    expect(overlay.counts()).toEqual({ hub: 1, spoke: 1 });
    expect(overlay.fleetConfig()).toBeNull();
    expect(overlay.fleetZones()).toEqual(['sim-zone']);
    expect(overlay.labBridges()).toEqual([]);
    expect(overlay.stackSummary().lifecycleWorkerConcurrency).toBe(10);
  });

  it('renders no editable service ports while unseeded rather than inventing Nix defaults', async () => {
    const { overlay } = await setupFailedSeed();

    const cfg = overlay.stackConfig();

    expect(cfg.servicePorts).toEqual([]);
    expect(cfg.identity).toEqual({ pg: { user: '', password: '', db: '' }, orgId: '' });
  });

  it('accepts a save again once a later reseed succeeds', async () => {
    const { overlay, path } = await setupFailedSeed();
    seedEval.error = null;
    await overlay.reseed();

    await overlay.setStackConfig({ hub: {}, spoke: {}, telemetry: { enable: true } });

    expect(readFileSync(path, 'utf8')).toContain('telemetry.enable = true;');
  });

  it('recovers from the read path alone, with no write attempted', async () => {
    const { overlay, path } = await setupFailedSeed();
    seedEval.error = null;

    overlay.stackConfig();
    await vi.waitFor(() => expect(overlay.stackConfig().seeded).toBe(true));

    await overlay.setStackConfig({ hub: {}, spoke: {}, telemetry: { enable: true } });
    expect(readFileSync(path, 'utf8')).toContain('telemetry.enable = true;');
  });
});

describe('OverlayStoreService.renderOverlay — a stack save never pins the committed base fleet', () => {
  const BASE_ZONES = { 'sim-zone': { index: 0, bridges: 1, nodes: { 'gpu-1': { index: 0, cpus: 4 } } } };

  async function setupBaremetalBase(): Promise<{ overlay: OverlayStoreService; path: string }> {
    seedEval.stdout = evalSeedJson({ fleet: { mode: 'baremetal', zones: BASE_ZONES } });
    const { overlay, dir } = await setupWithRoot();
    return { overlay, path: join(dir, 'stack.local.nix') };
  }

  async function setupOwnedBaremetal(): Promise<{ overlay: OverlayStoreService; path: string }> {
    seedEval.stdout = JSON.stringify({
      fleet: {
        mode: 'baremetal',
        zones: BASE_ZONES,
        baremetal: { iface: 'enp35s0', arch: 'amd64', nodes: { 'metal-1': { index: 0, bmc_ip: '10.0.0.1' } } },
      },
    });
    const { overlay, dir } = setupUnseeded();
    const path = join(dir, 'stack.local.nix');
    writeFileSync(path, '{ ... }:\n{\n  fleet.mode = "baremetal";\n  fleet.baremetal.iface = "enp35s0";\n}\n');
    await overlay.reseed();
    return { overlay, path };
  }

  it('writes no fleet line at all on a plain save over an unowned baremetal base', async () => {
    const { overlay, path } = await setupBaremetalBase();

    await overlay.setStackConfig({ hub: {}, spoke: {}, telemetry: { enable: true } });

    expect(readFileSync(path, 'utf8')).not.toContain('fleet.');
  });

  it('still writes no fleet line on a second save', async () => {
    const { overlay, path } = await setupBaremetalBase();
    await overlay.setStackConfig({ hub: {}, spoke: {}, telemetry: { enable: true } });

    await overlay.setStackConfig({ hub: {}, spoke: {}, telemetry: { enable: false } });

    expect(readFileSync(path, 'utf8')).not.toContain('fleet.');
    expect(overlay.fleetCustomized()).toBe(false);
  });

  it('round-trips fleet.mode + the bare-metal section on a plain save of an owned baremetal fleet', async () => {
    const { overlay, path } = await setupOwnedBaremetal();

    await overlay.setStackConfig({ hub: {}, spoke: {}, telemetry: { enable: true } });

    const out = readFileSync(path, 'utf8');
    expect(out).toContain('fleet.mode = "baremetal";');
    expect(out).toContain('fleet.baremetal.iface = "enp35s0";');
    expect(out).toContain('fleet.baremetal.nodes."metal-1"');
    expect(out).toContain('fleet.zones."sim-zone".nodes."gpu-1"');
  });

  it('persists a setFleetConfig mode flip that ships no bare-metal section', async () => {
    const { overlay, path } = await setupBaremetalBase();

    overlay.setFleetConfig({ nodes: [{ name: 'gpu-1', spec: { cpus: 4 } }], mode: 'baremetal' });

    const out = readFileSync(path, 'utf8');
    expect(out).toContain('fleet.mode = "baremetal";');
    expect(out).toContain('fleet.zones."sim-zone".nodes."gpu-1"');
  });
});

describe('OverlayStoreService.seedMirror — ownership is adopted from a topology declaration, not any fleet key', () => {
  const BASE_FLEET = {
    zones: { 'sim-zone': { index: 0, bridges: 1, nodes: { 'gpu-1': { index: 0, cpus: 4 } } } },
  };

  async function seedAgainst(
    overlayText: string,
    mode?: string,
  ): Promise<{ overlay: OverlayStoreService; path: string }> {
    seedEval.stdout = JSON.stringify({ fleet: { ...BASE_FLEET, ...(mode ? { mode } : {}) } });
    const { overlay, dir } = setupUnseeded();
    const path = join(dir, 'stack.local.nix');
    writeFileSync(path, overlayText);
    await overlay.reseed();
    return { overlay, path };
  }

  it('ignores the fleet.mode line an earlier baremetal save left on disk', async () => {
    const { overlay, path } = await seedAgainst('{ ... }:\n{\n  fleet.mode = "baremetal";\n}\n', 'baremetal');

    await overlay.setStackConfig({ hub: {}, spoke: {}, telemetry: { enable: true } });

    expect(overlay.fleetCustomized()).toBe(false);
    expect(readFileSync(path, 'utf8')).not.toContain('fleet.zones');
  });

  it('still adopts ownership from an overlay that declares fleet.zones', async () => {
    const { overlay, path } = await seedAgainst(
      '{ ... }:\n{\n  fleet.zones."sim-zone".nodes."gpu-1" = { "cpus" = 4; };\n}\n',
    );

    await overlay.setStackConfig({ hub: {}, spoke: {}, telemetry: { enable: true } });

    expect(overlay.fleetCustomized()).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('fleet.zones."sim-zone".nodes."gpu-1"');
  });

  it('still adopts ownership from a hand-written fleet.nodes overlay', async () => {
    const { overlay, path } = await seedAgainst('{ ... }:\n{\n  fleet.nodes."gpu-1" = { "cpus" = 4; };\n}\n');

    await overlay.setStackConfig({ hub: {}, spoke: {}, telemetry: { enable: true } });

    expect(overlay.fleetCustomized()).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('fleet.zones."sim-zone".nodes."gpu-1"');
  });
});

describe('OverlayStoreService.bmUplink — W4 uplink resolution', () => {
  it('returns the iface + live IPv4 in bm mode', () => {
    const overlay = makeOverlay();
    vi.spyOn(overlay, 'fleetMode').mockReturnValue('baremetal');
    vi.spyOn(overlay, 'baremetalConfig').mockReturnValue({ nics: ['eth0'], arch: 'amd64', nodes: {} });
    nicState.value = { eth0: [{ family: 'IPv4', address: '10.0.0.5', internal: false }] };
    expect(overlay.bmUplink()).toEqual({ iface: 'eth0', ip: '10.0.0.5' });
  });

  it('is null in vm mode', () => {
    const overlay = makeOverlay();
    vi.spyOn(overlay, 'fleetMode').mockReturnValue('vm');
    vi.spyOn(overlay, 'baremetalConfig').mockReturnValue({ nics: ['eth0'], arch: 'amd64', nodes: {} });
    nicState.value = { eth0: [{ family: 'IPv4', address: '10.0.0.5', internal: false }] };
    expect(overlay.bmUplink()).toBeNull();
  });

  it('is null when no NIC is configured', () => {
    const overlay = makeOverlay();
    vi.spyOn(overlay, 'fleetMode').mockReturnValue('baremetal');
    vi.spyOn(overlay, 'baremetalConfig').mockReturnValue({ nics: [], arch: 'amd64', nodes: {} });
    expect(overlay.bmUplink()).toBeNull();
  });

  it('is null when the NIC has no IPv4', () => {
    const overlay = makeOverlay();
    vi.spyOn(overlay, 'fleetMode').mockReturnValue('baremetal');
    vi.spyOn(overlay, 'baremetalConfig').mockReturnValue({ nics: ['eth0'], arch: 'amd64', nodes: {} });
    nicState.value = { eth0: [] };
    expect(overlay.bmUplink()).toBeNull();
  });
});

describe('OverlayStoreService — abandoned pre-fix overlay', () => {
  it('warns when a stack.local.nix survives at the old devenv/ path', () => {
    const { overlay, dir } = setupUnseeded();
    mkdirSync(join(dir, 'devenv'));
    writeFileSync(join(dir, 'devenv', 'stack.local.nix'), 'stackOverrides.hub = { "LOG_LEVEL" = "debug"; };\n');
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    overlay.onModuleInit();
    expect(warn.mock.calls.flat().join(' ')).toContain(join(dir, 'devenv', 'stack.local.nix'));
    warn.mockRestore();
  });

  it('stays quiet when no old-path overlay exists', () => {
    const { overlay } = setupUnseeded();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    overlay.onModuleInit();
    expect(warn.mock.calls.flat().join(' ')).not.toContain('stale overlay');
    warn.mockRestore();
  });
});

describe('OverlayStoreService.setStackSlot — mirror rebase with registry conflict detection', () => {
  const OWNED_FLEET = { zones: { 'sim-zone': { index: 0, bridges: 1, nodes: { 'gpu-1': { index: 0, cpus: 4 } } } } };

  function emptyRegistry(): StackRegistryClient {
    const dir = mkdtempSync(join(tmpdir(), 'stack-registry-'));
    createdDirs.push(dir);
    return new StackRegistryClient(dir);
  }

  async function setupOwned(opts: { registry?: StackRegistryClient; slot?: number } = {}): Promise<{
    overlay: OverlayStoreService;
    path: string;
    registry: StackRegistryClient;
  }> {
    process.env.DEVENV_ROOT = mkdtempSync(join(tmpdir(), 'lab-overlay-'));
    createdDirs.push(process.env.DEVENV_ROOT);
    const path = join(process.env.DEVENV_ROOT, 'stack.local.nix');
    writeFileSync(
      path,
      '{ ... }:\n{\n  ports.postgres = 5433;\n  fleet.zones."sim-zone".nodes."gpu-1" = { "index" = 0; };\n}\n',
    );
    seedEval.stdout = evalSeedJson({
      'stack.slot': opts.slot ?? 0,
      ports: { ...EVAL_SEED.ports, postgres: 5433 },
      fleet: OWNED_FLEET,
    });
    const registry = opts.registry ?? emptyRegistry();
    const overlay = new OverlayStoreService(new RenderedConfigService(new ProcessComposeClient()), registry);
    await overlay.reseed();
    return { overlay, path, registry };
  }

  it('renders a changed slot as a plain line, drops fleet/port pins, and arms rebind', async () => {
    const { overlay, path } = await setupOwned();

    await overlay.setStackSlot(2);

    const text = readFileSync(path, 'utf8');
    expect(text).toContain('stack.slot = 2;');
    expect(text).not.toContain('ports.postgres');
    expect(text).not.toContain('fleet.zones');
    expect(overlay.slot()).toBe(2);
    expect(overlay.isRebindPending()).toBe(true);
    expect(overlay.rebindReasonText()).toBe('slot change');
    expect(overlay.rebindWipeKind()).toBe('stack-reslot');
    expect(overlay.fleetCustomized()).toBe(false);
  });

  it('rejects a slot owned by a live sibling and writes nothing', async () => {
    const registryDir = mkdtempSync(join(tmpdir(), 'stack-registry-'));
    createdDirs.push(registryDir);
    const sibling = mkdtempSync(join(tmpdir(), 'lab-sibling-'));
    createdDirs.push(sibling);
    writeFileSync(
      join(registryDir, 'stack-2.json'),
      JSON.stringify({ slot: 2, checkout: sibling, pcDaemonPid: 0, state: 'up' }),
    );
    const { overlay, path } = await setupOwned({ registry: new StackRegistryClient(registryDir) });
    const before = readFileSync(path);

    await expect(overlay.setStackSlot(2)).rejects.toThrow(ConflictException);
    await expect(overlay.setStackSlot(2)).rejects.toThrow(`slot 2 already claimed by ${sibling}`);
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(overlay.slot()).toBe(0);
  });

  it('allows a slot whose registry entry is stale', async () => {
    const registryDir = mkdtempSync(join(tmpdir(), 'stack-registry-'));
    createdDirs.push(registryDir);
    writeFileSync(
      join(registryDir, 'stack-3.json'),
      JSON.stringify({ slot: 3, checkout: join(registryDir, 'deleted-checkout'), pcDaemonPid: 0, state: 'up' }),
    );
    const { overlay, path } = await setupOwned({ registry: new StackRegistryClient(registryDir) });

    await overlay.setStackSlot(3);

    expect(readFileSync(path, 'utf8')).toContain('stack.slot = 3;');
  });

  it('routes a changed slot from a config save through the rebase path', async () => {
    const { overlay, path } = await setupOwned();

    const res = await overlay.setStackConfig({ hub: {}, spoke: {}, slot: 4 });

    expect(res.applied).toContain('stack.slot');
    expect(readFileSync(path, 'utf8')).toContain('stack.slot = 4;');
    expect(overlay.isRebindPending()).toBe(true);
  });

  it('ignores the ports object of a save that also moves the slot', async () => {
    const { overlay, path } = await setupOwned();

    await overlay.setStackConfig({ hub: {}, spoke: {}, slot: 2, ports: { postgres: 5433 } });

    const text = readFileSync(path, 'utf8');
    expect(text).toContain('stack.slot = 2;');
    expect(text).not.toContain('ports.postgres');
  });

  it('writes no stack.slot line for a save that leaves the slot unchanged', async () => {
    const { overlay, path } = await setupOwned();

    await overlay.setStackConfig({ hub: {}, spoke: {}, telemetry: { enable: true } });

    expect(readFileSync(path, 'utf8')).not.toContain('stack.slot');
  });

  it('surfaces the seeded slot on the config catalog', async () => {
    const { overlay } = await setupOwned({ slot: 5 });

    expect(overlay.slot()).toBe(5);
    expect(overlay.stackConfig().slot).toBe(5);
  });
});
