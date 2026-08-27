import { ConflictException, Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { KnobCatalogEntry } from '../../common/pc-schemas';
import { OverlayStoreService } from '../overlay-store';
import { ProcessComposeClient } from '../process-compose.client';
import { RenderedConfigService } from '../rendered-config.service';
import { StackRegistryClient } from '../stack-registry-client';

const knob = (over: Partial<KnobCatalogEntry> & { path: string }): KnobCatalogEntry => ({
  label: 'Label',
  group: 'Group',
  description: 'Why this knob exists.',
  kind: 'text',
  choices: [],
  default: null,
  editable: true,
  danger: false,
  secret: false,
  alias: [],
  overrideFrom: null,
  ...over,
});

const PORT_DEFAULTS: Record<string, number> = {
  mailpitSmtp: 1025,
  mailpitWeb: 8025,
  nginx: 8888,
  postgres: 5432,
  redfish: 8443,
  redis: 6379,
  thanosGrpc: 10901,
  thanosHttp: 10902,
  thanosRemoteWrite: 19291,
};

const READ_ONLY_PORT_DEFAULTS: Record<string, number> = {
  grafana: 4300,
  otlpGrpc: 4317,
  otlpHttp: 4318,
  tempoHttp: 3200,
};
const KNOB_CATALOG: KnobCatalogEntry[] = [
  ...Object.entries(PORT_DEFAULTS).map(([key, value]) =>
    knob({ path: `ports.${key}`, kind: 'port', default: value, label: key }),
  ),
  ...Object.entries(READ_ONLY_PORT_DEFAULTS).map(([key, value]) =>
    knob({ path: `ports.${key}`, kind: 'port', default: value, label: key, editable: false }),
  ),
  knob({
    path: 'stackDefaults.hub.AUTH_BYPASS_ENABLED',
    kind: 'bool',
    default: 'false',
    danger: true,
    overrideFrom: 'stackOverrides.hub',
  }),
  knob({
    path: 'stackDefaults.hub.DATABASE_URL',
    default: 'postgresql://brokkr:password@127.0.0.1:5432/brokkr',
    overrideFrom: 'stackOverrides.hub',
  }),
  knob({ path: 'stackDefaults.hub.HUB_REPO_PATH', default: null, overrideFrom: 'stackOverrides.hub' }),
  knob({ path: 'fleet.autoStart', kind: 'bool', default: 'true' }),
  knob({
    path: 'stackDefaults.hub.LOG_LEVEL',
    kind: 'select',
    choices: ['debug', 'info', 'warn', 'error'],
    default: 'debug',
    overrideFrom: 'stackOverrides.hub',
  }),
  knob({
    path: 'stackDefaults.spoke.LIFECYCLE_WORKER_CONCURRENCY',
    kind: 'number',
    default: '7',
    overrideFrom: 'stackOverrides.spoke',
  }),
  knob({
    path: 'stackDefaults.spoke.LOG_LEVEL',
    kind: 'select',
    choices: ['debug', 'info', 'warning', 'error'],
    default: 'debug',
    overrideFrom: 'stackOverrides.spoke',
  }),
  knob({ path: 'identity.pg.user', label: 'Postgres user', default: 'brokkr' }),
  knob({ path: 'identity.pg.password', label: 'Postgres password', default: 'password', secret: true }),
  knob({ path: 'identity.pg.db', label: 'Postgres database', default: 'brokkr' }),
  knob({ path: 'identity.orgId', label: 'Org UUID', default: 'org-0' }),
  knob({ path: 'osLayerCache.originHost', label: 'OS layer origin', default: '' }),
  knob({ path: 'osLayerCache.resolvers', label: 'OS layer resolvers', default: '' }),
  knob({ path: 'lan.expose', kind: 'bool', default: false }),
  knob({ path: 'telemetry.enable', kind: 'bool', default: 'false' }),
  knob({ path: 'stack.slot', kind: 'number', default: '0', editable: false }),
  knob({ path: 'stackCounts.spoke', kind: 'number', default: '1' }),
  knob({ path: 'stackCounts.hub', kind: 'number', default: '1' }),
  knob({ path: 'stack.fleetNodeCount', kind: 'number', default: '4' }),
  knob({ path: 'spoke.watch', kind: 'bool', default: 'true' }),
  knob({ path: 'fleet.mode', label: 'Fleet mode', default: 'vm' }),
  knob({ path: 'redisAcl.enable', kind: 'bool', default: 'true' }),
  knob({ path: 'vrrpSim.enable', kind: 'bool', default: 'false' }),
  knob({ path: 'zoneCrypto.hubPrivateKey', label: 'Hub private key', secret: true, danger: true, editable: false }),
  knob({
    path: 'zoneCrypto.bridgeAtRestKey',
    label: 'Bridge at-rest key',
    secret: true,
    danger: true,
    editable: false,
  }),
];

const KNOB_VALUES = KNOB_CATALOG.map((entry) => ({ path: entry.path, value: entry.default ?? null }));

const KNOB_PROVENANCE = [
  { path: 'ports.postgres', files: ['devenv/modules/ports.nix'], perKey: {} },
  { path: 'identity.pg.password', files: ['devenv/modules/overrides.nix'], perKey: {} },
  { path: 'stackDefaults.hub', files: ['devenv/modules/hub.nix'], perKey: { LOG_LEVEL: ['devenv/modules/hub.nix'] } },
  { path: 'stackDefaults.hub.LOG_LEVEL', files: ['devenv/modules/hub.nix'], perKey: {} },
  {
    path: 'stackOverrides.hub',
    files: ['devenv/modules/overrides.nix'],
    perKey: { LOG_LEVEL: ['devenv/stack.local.nix'] },
  },
];

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
  configModel: { catalog: KNOB_CATALOG, values: KNOB_VALUES, provenance: KNOB_PROVENANCE },
  labBridges: [
    { proc: 'spoke', zone: 'sim-zone', replica: 0, port: 8000, grpc: 9082 },
    { proc: 'spoke-edge', zone: 'edge-zone', replica: 0, port: 8100, grpc: 9182 },
  ],
  identity: { pg: { user: 'labpg', password: 'labpass', db: 'labdb' }, orgId: 'org-uuid' },
  osLayerCache: { originHost: 'brokkr.assets.hydra.host', resolvers: '1.1.1.1 8.8.8.8' },
};
const evalSeedJson = (extra: Record<string, unknown> = {}): string => {
  const { envPins, ...rest } = extra;
  const pins =
    envPins && !Array.isArray(envPins)
      ? { envPins: Object.entries(envPins as Record<string, string>).map(([path, v]) => ({ path, var: v })) }
      : envPins
        ? { envPins }
        : {};
  return JSON.stringify({ ...EVAL_SEED, ...rest, ...pins });
};

const { nicState, seedEval } = vi.hoisted(() => ({
  nicState: { value: {} as Record<string, { family: string; address: string; internal: boolean }[]> },
  seedEval: { stdout: '{}', error: null as Error | null, calls: 0 },
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
    ) => {
      seedEval.calls += 1;
      cb(seedEval.error, { stdout: seedEval.stdout, stderr: '' });
    },
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
  vi.unstubAllEnvs();
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
    await overlay.setStackConfig({ entries: { 'telemetry.enable': 'true' } });
    expect(readFileSync(join(dir, 'stack.local.nix'), 'utf8')).toContain('telemetry.enable = true;');
  });

  it('invokes the registered apply hook only when telemetry.enable changes', async () => {
    const { overlay } = await setupWithRoot();
    const hook = vi.fn();
    overlay.registerTelemetryApplyHook(hook);
    await overlay.setStackConfig({ entries: { 'telemetry.enable': 'true' } });
    expect(hook).toHaveBeenCalledTimes(1);
    hook.mockClear();
    await overlay.setStackConfig({ entries: { 'telemetry.enable': 'true' } });
    expect(hook).not.toHaveBeenCalled();
  });

  it('surfaces telemetry + read-only observability ports from stackConfig()', async () => {
    const { overlay } = await setupWithRoot();
    await overlay.setStackConfig({ entries: { 'telemetry.enable': 'true' } });

    const cfg = overlay.stackConfig();
    expect(cfg.telemetry).toEqual({ enable: true });
    expect(cfg.servicePorts.find((p) => p.key === 'grafana')).toMatchObject({ readOnly: true, value: 4300 });

    await overlay.setStackConfig({ entries: { 'telemetry.enable': 'false' } });
    expect(overlay.stackConfig().telemetry).toEqual({ enable: false });
  });

  it('arms the rebind latch on a datastore-port change', async () => {
    const { overlay } = await setupWithRoot();
    await overlay.setStackConfig({ entries: { 'ports.postgres': '5433' } });
    expect(overlay.isRebindPending()).toBe(true);
  });

  it('arms the rebind latch on a LAN-bind change', async () => {
    const { overlay } = await setupWithRoot();
    await overlay.setStackConfig({ entries: { 'lan.expose': 'true' } });
    expect(overlay.isRebindPending()).toBe(true);
  });

  it('does not arm the latch for a telemetry-only save (but still invokes the hook)', async () => {
    const { overlay } = await setupWithRoot();
    const hook = vi.fn();
    overlay.registerTelemetryApplyHook(hook);
    await overlay.setStackConfig({ entries: { 'telemetry.enable': 'true' } });
    expect(overlay.isRebindPending()).toBe(false);
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('does not invoke the hook for a rebind-only save (telemetry unchanged)', async () => {
    const { overlay } = await setupWithRoot();
    const hook = vi.fn();
    overlay.registerTelemetryApplyHook(hook);
    await overlay.setStackConfig({ entries: { 'ports.postgres': '5433' } });
    expect(hook).not.toHaveBeenCalled();
    expect(overlay.isRebindPending()).toBe(true);
  });

  it('writes stack.local.nix atomically via tmp+rename, leaving no .tmp residue', async () => {
    const { overlay, dir } = await setupWithRoot();
    await overlay.setStackConfig({ entries: { 'telemetry.enable': 'true' } });
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
    await expect(overlay.setStackConfig({ entries: { 'telemetry.enable': 'true' } })).rejects.toThrow('rename boom');
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

  it('resolves the spoke lifecycle concurrency from the knob catalog', async () => {
    const { overlay } = await setupWithRoot();

    expect(overlay.stackConfig().knobs.spoke.find((k) => k.env === 'LIFECYCLE_WORKER_CONCURRENCY')?.default).toBe('7');
    expect(overlay.stackSummary().lifecycleWorkerConcurrency).toBe(7);
  });

  it('resolves the AUTH_BYPASS_ENABLED default the catalog reports through its aliases', async () => {
    const { overlay } = await setupWithRoot();

    expect(overlay.stackConfig().knobs.hub.find((k) => k.env === 'AUTH_BYPASS_ENABLED')?.default).toBe('false');
  });

  it('derives the Postgres URL default from the saved identity and port', async () => {
    const { overlay } = await setupWithRoot();
    await overlay.setStackConfig({
      entries: {
        'identity.pg.user': 'lab',
        'identity.pg.password': 'sekrit',
        'identity.pg.db': 'labdb',
        'ports.postgres': '5433',
      },
    });

    expect(overlay.stackConfig().knobs.hub.find((k) => k.env === 'DATABASE_URL')?.default).toBe(
      'postgresql://lab:sekrit@127.0.0.1:5433/labdb',
    );
  });

  it('renders only the knobs the catalog carries', async () => {
    const { overlay } = await setupWithRoot();

    expect(overlay.stackConfig().knobs.hub.map((k) => k.env)).toEqual([
      'AUTH_BYPASS_ENABLED',
      'DATABASE_URL',
      'HUB_REPO_PATH',
      'LOG_LEVEL',
    ]);
  });

  it('drops a knob the catalog stops carrying', async () => {
    seedEval.stdout = evalSeedJson({
      configModel: {
        catalog: KNOB_CATALOG.filter((e) => !e.path.endsWith('.LOG_LEVEL')),
        values: KNOB_VALUES,
        provenance: KNOB_PROVENANCE,
      },
    });
    const { overlay } = await setupWithRoot();

    expect(overlay.stackConfig().knobs.hub.map((k) => k.env)).not.toContain('LOG_LEVEL');
  });

  it('reports the catalog as the source and marks only the recomputed knobs derived', async () => {
    vi.stubEnv('HUB_REPO_PATH', '');
    const { overlay } = await setupWithRoot();
    const hub = overlay.stackConfig().knobs.hub;

    expect(hub.find((k) => k.env === 'LOG_LEVEL')?.source).toBe('nix');
    expect(hub.find((k) => k.env === 'DATABASE_URL')?.source).toBe('derived');
    expect(hub.find((k) => k.env === 'HUB_REPO_PATH')).toMatchObject({ source: 'lab', default: null });
  });

  it('marks the hub repo path derived once the lab process carries one', async () => {
    vi.stubEnv('HUB_REPO_PATH', '/checkouts/boss');
    const { overlay } = await setupWithRoot();

    expect(overlay.stackConfig().knobs.hub.find((k) => k.env === 'HUB_REPO_PATH')).toMatchObject({
      source: 'derived',
      default: '/checkouts/boss',
    });
  });

  it('names the pinning variable on a knob config.envPins holds', async () => {
    seedEval.stdout = evalSeedJson({ envPins: { 'stackDefaults.hub.LOG_LEVEL': 'BROKKR_HUB_LOG_LEVEL' } });
    const { overlay } = await setupWithRoot();
    const hub = overlay.stackConfig().knobs.hub;

    expect(hub.find((k) => k.env === 'LOG_LEVEL')?.pinnedBy).toBe('BROKKR_HUB_LOG_LEVEL');
    expect(hub.find((k) => k.env === 'DATABASE_URL')).not.toHaveProperty('pinnedBy');
  });

  it('reads a list-shaped envPins the same as a keyed one', async () => {
    seedEval.stdout = evalSeedJson({
      envPins: [{ path: 'stackDefaults.hub.LOG_LEVEL', var: 'BROKKR_CFG_stackDefaults__hub__LOG_LEVEL' }],
    });
    const { overlay } = await setupWithRoot();

    expect(overlay.stackConfig().knobs.hub.find((k) => k.env === 'LOG_LEVEL')?.pinnedBy).toBe(
      'BROKKR_CFG_stackDefaults__hub__LOG_LEVEL',
    );
  });

  it('surfaces the labBridges roster instead of re-deriving zone/replica port math', async () => {
    const { overlay } = await setupWithRoot();

    expect(overlay.labBridges()).toEqual([
      { proc: 'spoke', zone: 'sim-zone', replica: 0, port: 8000, grpc: 9082 },
      { proc: 'spoke-edge', zone: 'edge-zone', replica: 0, port: 8100, grpc: 9182 },
    ]);
  });

  it('keeps a field the patch omits entirely', async () => {
    const { overlay } = await setupWithRoot();
    await overlay.setStackConfig({ entries: { 'telemetry.enable': 'true' } });

    expect(overlay.stackConfig().identity.pg.user).toBe('labpg');
  });

  it('reverts a field to its declared default when the patch sends null', async () => {
    const { overlay } = await setupWithRoot();
    await overlay.setStackConfig({ entries: { 'identity.pg.user': null } });

    expect(overlay.stackConfig().identity.pg.user).toBe('brokkr');
  });

  it('takes a blank as a value now, rather than as a second way to revert', async () => {
    const { overlay } = await setupWithRoot();
    const res = await overlay.setStackConfig({ entries: { 'identity.pg.user': '' } });

    expect(res.applied).toContain('identity.pg.user');
    expect(overlay.stackConfig().identity.pg.user).toBe('');
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

    await overlay.setStackConfig({ entries: { 'ports.postgres': '5433' } });

    expect(readFileSync(path, 'utf8')).toContain('ports.postgres = 5433;');
  });

  it('drops a pre-existing pin when the operator restores the port to its Nix default', async () => {
    const { overlay, path } = await setupPrePinned();

    await overlay.setStackConfig({ entries: { 'ports.postgres': '5432' } });

    expect(readFileSync(path, 'utf8')).not.toContain('ports.postgres');
  });

  it('drops the pin when a port overridden in this session is restored', async () => {
    const { overlay, dir } = await setupWithRoot();
    const path = join(dir, 'stack.local.nix');

    await overlay.setStackConfig({ entries: { 'ports.postgres': '5433' } });
    expect(readFileSync(path, 'utf8')).toContain('ports.postgres = 5433;');

    await overlay.setStackConfig({ entries: { 'ports.postgres': '5432' } });
    expect(readFileSync(path, 'utf8')).not.toContain('ports.postgres');
  });

  it('shows the pinned value in servicePorts rather than the Nix default', async () => {
    const { overlay } = await setupPrePinned();

    expect(overlay.stackConfig().servicePorts.find((p) => p.key === 'postgres')?.value).toBe(5433);
  });

  it('keeps the pin when the patch omits the port, because absent means untouched', async () => {
    const { overlay, path } = await setupPrePinned();

    await overlay.setStackConfig({ entries: {} });

    expect(readFileSync(path, 'utf8')).toContain('ports.postgres = 5433;');
  });

  it('drops the pin when the patch reverts the port explicitly', async () => {
    const { overlay, path } = await setupPrePinned();

    await overlay.setStackConfig({ entries: { 'ports.postgres': null } });

    expect(readFileSync(path, 'utf8')).not.toContain('ports.postgres');
    expect(overlay.stackConfig().servicePorts.find((p) => p.key === 'postgres')?.value).toBe(5432);
  });

  it('refuses an out-of-range port and leaves the pin it already had alone', async () => {
    const { overlay, path } = await setupPrePinned();

    const res = await overlay.setStackConfig({ entries: { 'ports.postgres': '99999' } });

    expect(res.rejected).toEqual([{ path: 'ports.postgres', reason: 'not-coercible', detail: 'port' }]);
    expect(readFileSync(path, 'utf8')).toContain('ports.postgres = 5433;');
  });

  it('refuses a port that is not a number at all', async () => {
    const { overlay } = await setupPrePinned();

    const res = await overlay.setStackConfig({ entries: { 'ports.postgres': 'later' } });

    expect(res.rejected[0]).toMatchObject({ reason: 'not-coercible' });
  });

  it('keeps the pin on a save that carries no ports object at all', async () => {
    const { overlay, path } = await setupPrePinned();

    await overlay.setStackConfig({ entries: { 'telemetry.enable': 'true' } });

    expect(readFileSync(path, 'utf8')).toContain('ports.postgres = 5433;');
  });

  it('reports a pre-existing pin as applied and a default-valued port as neither', async () => {
    const { overlay } = await setupPrePinned();

    const res = await overlay.setStackConfig({ entries: { 'ports.postgres': '5433', 'ports.redis': '6379' } });

    expect(res.applied).toContain('ports.postgres');
    expect(res.applied).not.toContain('ports.redis');
    expect(res.rejected.map((r) => r.path)).toEqual([]);
  });
});

describe('OverlayStoreService.configTree', () => {
  it('publishes the raw nix path, which is the one devenv eval and BROKKR_CFG_ both resolve', async () => {
    const { overlay } = await setupWithRoot();
    const paths = overlay.configTree().entries.map((e) => e.path);

    expect(paths).toContain('stackDefaults.hub.LOG_LEVEL');
    expect(paths).toContain('ports.postgres');
    expect(paths).not.toContain('hub.LOG_LEVEL');
  });

  it('publishes an apply class for every writable entry, so no saveable row is unclassified', async () => {
    const { overlay } = await setupWithRoot();

    const unclassified = overlay.configTree().entries.filter((e) => e.writable && e.applyClass === null);

    expect(unclassified.map((e) => e.path)).toEqual([]);
  });

  it('reports the effective value against the pre-override default', async () => {
    const { overlay } = await setupWithRoot();
    await overlay.setStackConfig({ entries: { 'stackDefaults.hub.LOG_LEVEL': 'warn', 'ports.postgres': '5433' } });

    const entries = overlay.configTree().entries;

    expect(entries.find((e) => e.path === 'stackDefaults.hub.LOG_LEVEL')).toMatchObject({
      value: 'warn',
      default: 'debug',
    });
    expect(entries.find((e) => e.path === 'ports.postgres')).toMatchObject({ value: '5433', default: '5432' });
  });

  it('reports the same value for a knob as the stack editor does', async () => {
    const { overlay } = await setupWithRoot();
    const tree = new Map(overlay.configTree().entries.map((e) => [e.path, e.value]));

    for (const group of ['hub', 'spoke'] as const) {
      for (const k of overlay.stackConfig().knobs[group]) {
        expect(tree.get(k.path)).toBe(k.default);
      }
    }
  });

  it('resolves a derived path the eval declares no value for', async () => {
    vi.stubEnv('HUB_REPO_PATH', '/checkouts/boss');
    const { overlay } = await setupWithRoot();

    expect(overlay.configTree().entries.find((e) => e.path === 'stackDefaults.hub.HUB_REPO_PATH')?.value).toBe(
      '/checkouts/boss',
    );
  });

  it('reads an option path from its own provenance files', async () => {
    const { overlay } = await setupWithRoot();

    expect(overlay.configTree().entries.find((e) => e.path === 'ports.postgres')?.definedIn).toEqual([
      'devenv/modules/ports.nix',
    ]);
  });

  it('keeps the pinned fleet.mode instead of persisting a value the pin discards', async () => {
    seedEval.stdout = evalSeedJson({ envPins: { 'fleet.mode': 'BROKKR_FLEET_MODE' } });
    const { overlay, dir } = await setupWithRoot();

    overlay.setFleetConfig({ nodes: [], mode: 'baremetal' });

    expect(readFileSync(join(dir, 'stack.local.nix'), 'utf8')).not.toContain('fleet.mode = "baremetal"');
  });

  it('reports fleet.autoStart from the eval, not the catalog default', async () => {
    seedEval.stdout = evalSeedJson({ fleet: { autoStart: false } });
    const { overlay } = await setupWithRoot();

    const entry = overlay.configTree().entries.find((e) => e.path === 'fleet.autoStart');
    expect(entry?.value).toBe('false');
    expect(entry?.value).not.toBe(String(entry?.default));
  });

  it('reads an env knob from both the defaults block and the overrides block', async () => {
    const { overlay } = await setupWithRoot();

    expect(overlay.configTree().entries.find((e) => e.path === 'stackDefaults.hub.LOG_LEVEL')?.definedIn).toEqual([
      'devenv/modules/hub.nix',
      'devenv/stack.local.nix',
    ]);
  });

  it('masks a secret in both the value and the default', async () => {
    const { overlay } = await setupWithRoot();

    expect(overlay.configTree().entries.find((e) => e.path === 'identity.pg.password')).toMatchObject({
      secret: true,
      value: '***',
      default: '***',
    });
  });

  it('names the pinning variable and leaves it off the unpinned rows', async () => {
    seedEval.stdout = evalSeedJson({ envPins: { 'lan.expose': 'BROKKR_LAN_EXPOSE' } });
    const { overlay } = await setupWithRoot();
    const entries = overlay.configTree().entries;

    expect(entries.find((e) => e.path === 'lan.expose')?.pinnedBy).toBe('BROKKR_LAN_EXPOSE');
    expect(entries.find((e) => e.path === 'ports.postgres')).not.toHaveProperty('pinnedBy');
  });

  it('returns an empty tree rather than catalog guesses while unseeded', async () => {
    seedEval.error = new Error('devenv eval failed');
    const { overlay } = setupUnseeded();
    await overlay.reseed();

    expect(overlay.configTree()).toEqual({ seeded: false, entries: [] });
  });
});

describe('OverlayStoreService.setStackConfig — applied/rejected reporting', () => {
  it('reports an unknown hub env key as rejected', async () => {
    const { overlay } = await setupWithRoot();
    const res = await overlay.setStackConfig({ entries: { 'stackDefaults.hub.NOPE': 'x' } });
    expect(res.rejected.map((r) => r.path)).toContain('stackDefaults.hub.NOPE');
    expect(res.applied).not.toContain('stackDefaults.hub.NOPE');
  });

  it('applies a known non-blank hub env key', async () => {
    const { overlay } = await setupWithRoot();
    const res = await overlay.setStackConfig({ entries: { 'stackDefaults.hub.LOG_LEVEL': 'info' } });
    expect(res.applied).toContain('stackDefaults.hub.LOG_LEVEL');
  });

  it('reports a write that lands back on the declared default in neither array', async () => {
    const { overlay } = await setupWithRoot();
    const res = await overlay.setStackConfig({ entries: { 'identity.pg.user': null } });
    expect(res.applied).not.toContain('identity.pg.user');
    expect(res.rejected.map((r) => r.path)).not.toContain('identity.pg.user');
  });

  it('reports an env key the patch set as applied, whatever the value', async () => {
    const { overlay } = await setupWithRoot();
    const res = await overlay.setStackConfig({ entries: { 'stackDefaults.hub.LOG_LEVEL': '   ' } });
    expect(res.applied).toEqual(['stackDefaults.hub.LOG_LEVEL']);
  });

  it('applies a known non-blank spoke env key and rejects an unknown spoke key', async () => {
    const { overlay } = await setupWithRoot();
    const res = await overlay.setStackConfig({
      entries: { 'stackDefaults.spoke.LIFECYCLE_WORKER_CONCURRENCY': '5', 'stackDefaults.spoke.NOPE': 'x' },
    });
    expect(res.applied).toContain('stackDefaults.spoke.LIFECYCLE_WORKER_CONCURRENCY');
    expect(res.rejected.map((r) => r.path)).toContain('stackDefaults.spoke.NOPE');
  });

  it('rejects a blank number knob rather than storing the zero the type would coerce it to', async () => {
    const { overlay } = await setupWithRoot();
    const res = await overlay.setStackConfig({ entries: { 'stackDefaults.spoke.LIFECYCLE_WORKER_CONCURRENCY': '' } });
    expect(res.rejected).toContainEqual({
      path: 'stackDefaults.spoke.LIFECYCLE_WORKER_CONCURRENCY',
      reason: 'not-coercible',
      detail: 'number',
    });
    expect(res.applied).not.toContain('stackDefaults.spoke.LIFECYCLE_WORKER_CONCURRENCY');
  });

  it('rejects a blank port rather than binding nothing on port zero', async () => {
    const { overlay } = await setupWithRoot();
    const res = await overlay.setStackConfig({ entries: { 'ports.postgres': '' } });
    expect(res.rejected).toContainEqual({ path: 'ports.postgres', reason: 'not-coercible', detail: 'port' });
    expect(res.applied).not.toContain('ports.postgres');
  });

  it('applies a valid editable port', async () => {
    const { overlay } = await setupWithRoot();
    const res = await overlay.setStackConfig({ entries: { 'ports.postgres': '5433' } });
    expect(res.applied).toContain('ports.postgres');
  });

  it('lists a default-valued editable port in neither array', async () => {
    const { overlay } = await setupWithRoot();
    const res = await overlay.setStackConfig({ entries: { 'ports.postgres': '5432' } });
    expect(res.applied).not.toContain('ports.postgres');
    expect(res.rejected.map((r) => r.path)).not.toContain('ports.postgres');
  });

  it('rejects a read-only observability port and an unknown port key', async () => {
    const { overlay } = await setupWithRoot();
    const res = await overlay.setStackConfig({ entries: { 'ports.grafana': '4300', 'ports.bogus': '1234' } });
    expect(res.rejected.map((r) => r.path)).toEqual(expect.arrayContaining(['ports.grafana', 'ports.bogus']));
    expect(res.applied).not.toContain('ports.grafana');
  });

  it('rejects a pinned env key and leaves it out of the overlay', async () => {
    seedEval.stdout = evalSeedJson({ envPins: { 'stackDefaults.hub.LOG_LEVEL': 'BROKKR_HUB_LOG_LEVEL' } });
    const { overlay, dir } = await setupWithRoot();

    const res = await overlay.setStackConfig({ entries: { 'stackDefaults.hub.LOG_LEVEL': 'info' } });

    expect(res.rejected.map((r) => r.path)).toContain('stackDefaults.hub.LOG_LEVEL');
    expect(res.applied).not.toContain('stackDefaults.hub.LOG_LEVEL');
    expect(readFileSync(join(dir, 'stack.local.nix'), 'utf8')).not.toContain('LOG_LEVEL');
  });

  it('still writes the unpinned siblings of a pinned env key', async () => {
    seedEval.stdout = evalSeedJson({ envPins: { 'stackDefaults.hub.LOG_LEVEL': 'BROKKR_HUB_LOG_LEVEL' } });
    const { overlay, dir } = await setupWithRoot();

    const res = await overlay.setStackConfig({
      entries: { 'stackDefaults.hub.LOG_LEVEL': 'info', 'stackDefaults.hub.AUTH_BYPASS_ENABLED': 'false' },
    });

    expect(res.applied).toEqual(['stackDefaults.hub.AUTH_BYPASS_ENABLED']);
    expect(readFileSync(join(dir, 'stack.local.nix'), 'utf8')).toContain('"AUTH_BYPASS_ENABLED" = "false";');
  });

  it('rejects a pinned port and keeps its effective value', async () => {
    seedEval.stdout = evalSeedJson({ envPins: { 'ports.postgres': 'BROKKR_PORT_POSTGRES' } });
    const { overlay, dir } = await setupWithRoot();

    const res = await overlay.setStackConfig({ entries: { 'ports.postgres': '5433' } });

    expect(res.rejected.map((r) => r.path)).toContain('ports.postgres');
    expect(readFileSync(join(dir, 'stack.local.nix'), 'utf8')).not.toContain('ports.postgres');
    expect(overlay.stackConfig().servicePorts.find((p) => p.key === 'postgres')?.value).toBe(5432);
  });

  it('writes no line for a pinned fixed-shape field it refused to change', async () => {
    seedEval.stdout = evalSeedJson({ envPins: { 'lan.expose': 'BROKKR_LAN_EXPOSE' } });
    const { overlay, dir } = await setupWithRoot();

    const res = await overlay.setStackConfig({ entries: { 'lan.expose': 'true' } });

    expect(res.rejected.map((r) => r.path)).toContain('lan.expose');
    expect(readFileSync(join(dir, 'stack.local.nix'), 'utf8')).not.toContain('lan.expose');
  });

  it('writes a line for a fixed-shape field only once it differs from the declared default', async () => {
    const { overlay, dir } = await setupWithRoot();

    await overlay.setStackConfig({ entries: { 'lan.expose': 'true' } });

    expect(readFileSync(join(dir, 'stack.local.nix'), 'utf8')).toContain('lan.expose = true;');
  });

  it('rejects a pinned path and names the variable holding it', async () => {
    seedEval.stdout = evalSeedJson({ envPins: { 'lan.expose': 'BROKKR_LAN_EXPOSE' } });
    const { overlay } = await setupWithRoot();

    const res = await overlay.setStackConfig({ entries: { 'lan.expose': 'true' } });

    expect(res.rejected).toEqual([{ path: 'lan.expose', reason: 'pinned', detail: 'BROKKR_LAN_EXPOSE' }]);
    expect(res.applied).toEqual([]);
  });

  it('reports a telemetry save as applied, the same rule every other family follows', async () => {
    const { overlay } = await setupWithRoot();
    const res = await overlay.setStackConfig({ entries: { 'telemetry.enable': 'true' } });
    expect(res.applied).toEqual(['telemetry.enable']);
    expect(res.rejected).toEqual([]);
  });

  it('reports a telemetry save that restores the default in neither array', async () => {
    const { overlay } = await setupWithRoot();
    const res = await overlay.setStackConfig({ entries: { 'telemetry.enable': 'false' } });
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

    await expect(overlay.setStackConfig({ entries: { 'telemetry.enable': 'true' } })).rejects.toThrow(
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

    await expect(overlay.setStackConfig({ entries: { 'telemetry.enable': 'true' } })).rejects.toThrow(
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

    expect(overlay.stackConfig().topology).toEqual({ zones: 0, bridges: 0 });
    expect(overlay.counts()).toEqual({ hub: 1, spoke: 1 });
    expect(overlay.fleetConfig()).toBeNull();
    expect(overlay.fleetZones()).toEqual(['sim-zone']);
    expect(overlay.labBridges()).toEqual([]);
    expect(overlay.stackSummary().lifecycleWorkerConcurrency).toBe(1);
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

    await overlay.setStackConfig({ entries: { 'telemetry.enable': 'true' } });

    expect(readFileSync(path, 'utf8')).toContain('telemetry.enable = true;');
  });

  it('recovers from the read path alone, with no write attempted', async () => {
    const { overlay, path } = await setupFailedSeed();
    seedEval.error = null;

    overlay.stackConfig();
    await vi.waitFor(() => expect(overlay.stackConfig().seeded).toBe(true));

    await overlay.setStackConfig({ entries: { 'telemetry.enable': 'true' } });
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

    await overlay.setStackConfig({ entries: { 'telemetry.enable': 'true' } });

    expect(readFileSync(path, 'utf8')).not.toContain('fleet.');
  });

  it('still writes no fleet line on a second save', async () => {
    const { overlay, path } = await setupBaremetalBase();
    await overlay.setStackConfig({ entries: { 'telemetry.enable': 'true' } });

    await overlay.setStackConfig({ entries: { 'telemetry.enable': 'false' } });

    expect(readFileSync(path, 'utf8')).not.toContain('fleet.');
    expect(overlay.fleetCustomized()).toBe(false);
  });

  it('round-trips fleet.mode + the bare-metal section on a plain save of an owned baremetal fleet', async () => {
    const { overlay, path } = await setupOwnedBaremetal();

    await overlay.setStackConfig({ entries: { 'telemetry.enable': 'true' } });

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

    await overlay.setStackConfig({ entries: { 'telemetry.enable': 'true' } });

    expect(overlay.fleetCustomized()).toBe(false);
    expect(readFileSync(path, 'utf8')).not.toContain('fleet.zones');
  });

  it('still adopts ownership from an overlay that declares fleet.zones', async () => {
    const { overlay, path } = await seedAgainst(
      '{ ... }:\n{\n  fleet.zones."sim-zone".nodes."gpu-1" = { "cpus" = 4; };\n}\n',
    );

    await overlay.setStackConfig({ entries: { 'telemetry.enable': 'true' } });

    expect(overlay.fleetCustomized()).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('fleet.zones."sim-zone".nodes."gpu-1"');
  });

  it('still adopts ownership from a hand-written fleet.nodes overlay', async () => {
    const { overlay, path } = await seedAgainst('{ ... }:\n{\n  fleet.nodes."gpu-1" = { "cpus" = 4; };\n}\n');

    await overlay.setStackConfig({ entries: { 'telemetry.enable': 'true' } });

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

    const res = await overlay.setStackConfig({ entries: {}, slot: 4 });

    expect(res.applied).toContain('stack.slot');
    expect(readFileSync(path, 'utf8')).toContain('stack.slot = 4;');
    expect(overlay.isRebindPending()).toBe(true);
  });

  it('names the entries a save that also moves the slot dropped, rather than silently losing them', async () => {
    const { overlay, path } = await setupOwned();

    const res = await overlay.setStackConfig({ entries: { 'ports.postgres': '5433' }, slot: 2 });

    const text = readFileSync(path, 'utf8');
    expect(text).toContain('stack.slot = 2;');
    expect(text).not.toContain('ports.postgres');
    expect(res.rejected).toEqual([{ path: 'ports.postgres', reason: 'slot-move-drops-entries' }]);
  });

  it('writes no stack.slot line for a save that leaves the slot unchanged', async () => {
    const { overlay, path } = await setupOwned();

    await overlay.setStackConfig({ entries: { 'telemetry.enable': 'true' } });

    expect(readFileSync(path, 'utf8')).not.toContain('stack.slot');
  });

  it('surfaces the seeded slot on the config catalog', async () => {
    const { overlay } = await setupOwned({ slot: 5 });

    expect(overlay.slot()).toBe(5);
    expect(overlay.stackConfig().slot).toBe(5);
  });
});

describe('OverlayStoreService — the pg password never reaches the client', () => {
  it('masks the password on the stack config read and keeps every other identity field', async () => {
    const { overlay } = await setupWithRoot();

    const { identity } = overlay.stackConfig();

    expect(identity.pg.password).toBe('***');
    expect(identity.pg.user).toBe('labpg');
    expect(identity.pg.db).toBe('labdb');
    expect(identity.orgId).toBe('org-uuid');
  });

  it('leaves an unset password empty instead of masking it into a value', () => {
    const { overlay } = setupUnseeded();

    expect(overlay.stackConfig().identity.pg.password).toBe('');
  });
});

describe('OverlayStoreService — a write leaves provenance stale until the tree reads again', () => {
  it('re-evaluates once on the first tree read after a write', async () => {
    const { overlay } = await setupWithRoot();
    overlay.configTree();
    const before = seedEval.calls;

    await overlay.setStackConfig({ entries: { 'telemetry.enable': 'true' } });
    overlay.configTree();

    expect(seedEval.calls).toBe(before + 1);
  });

  it('does not re-evaluate on a tree read with no write in between', async () => {
    const { overlay } = await setupWithRoot();
    overlay.configTree();
    const before = seedEval.calls;

    overlay.configTree();
    overlay.configTree();

    expect(seedEval.calls).toBe(before);
  });
});

describe('OverlayStoreService.stackPending', () => {
  const idle = { status: 'idle' as const };

  it('reports a clean stack with no strongest class rather than a placeholder one', async () => {
    const { overlay } = await setupWithRoot();

    const pending = overlay.stackPending(idle);

    expect(pending.savedNotApplied).toEqual({ paths: [], classes: [] });
    expect(pending.strongestClass).toBeNull();
    expect(pending.rebindArmed).toBe(false);
  });

  it('accumulates what a save wrote and names the strongest class among it', async () => {
    const { overlay } = await setupWithRoot();

    await overlay.setStackConfig({ entries: { 'stackDefaults.hub.LOG_LEVEL': 'warn', 'ports.postgres': '5433' } });
    const pending = overlay.stackPending(idle);

    expect(pending.savedNotApplied.paths).toEqual(['ports.postgres', 'stackDefaults.hub.LOG_LEVEL']);
    expect(pending.strongestClass).toBe('rebind-recreate');
  });

  it('arms the latch from the declared class rather than by comparing port values', async () => {
    const { overlay } = await setupWithRoot();

    await overlay.setStackConfig({ entries: { 'ports.postgres': '5433' } });

    expect(overlay.stackPending(idle).rebindArmed).toBe(true);
  });

  it('leaves the latch alone for a save that only reloads a service', async () => {
    const { overlay } = await setupWithRoot();

    await overlay.setStackConfig({ entries: { 'stackDefaults.hub.LOG_LEVEL': 'warn' } });

    expect(overlay.stackPending(idle).rebindArmed).toBe(false);
  });

  it('names a path needing a datastore reset instead of offering an action for it', async () => {
    const { overlay } = await setupWithRoot();

    await overlay.setStackConfig({ entries: { 'identity.pg.db': 'other' } });

    expect(overlay.stackPending(idle).resetRequired).toEqual(['identity.pg.db']);
  });

  it('forgets the accumulated set once the latch is cleared', async () => {
    const { overlay } = await setupWithRoot();
    await overlay.setStackConfig({ entries: { 'ports.postgres': '5433' } });

    overlay.clearRebindPending();

    expect(overlay.stackPending(idle).savedNotApplied.paths).toEqual([]);
  });

  it('carries the restart marker through, so a failed restart never reads as idle', async () => {
    const { overlay } = await setupWithRoot();

    expect(overlay.stackPending({ status: 'failed', reason: 'boom' }).restart).toEqual({
      status: 'failed',
      reason: 'boom',
    });
  });
});

describe('OverlayStoreService.configTree — secrets', () => {
  it('sends neither value of a secret, only fingerprints of both', async () => {
    const { overlay } = await setupWithRoot();

    const row = overlay.configTree().entries.find((e) => e.path === 'identity.pg.password');

    expect(row?.value).toBe('***');
    expect(row?.default).toBe('***');
    expect(row?.valueDigest).toBeDefined();
    expect(row?.defaultDigest).toBeDefined();
  });

  it('detects an overridden secret from the digests alone', async () => {
    const { overlay } = await setupWithRoot();
    await overlay.setStackConfig({ entries: { 'identity.pg.password': 'different' } });

    const row = overlay.configTree().entries.find((e) => e.path === 'identity.pg.password');

    expect(row?.overridden).toBe(true);
    expect(row?.valueDigest).not.toBe(row?.defaultDigest);
  });

  it('keeps a declared-but-unset knob null rather than collapsing it to a blank', async () => {
    const { overlay } = await setupWithRoot();

    const row = overlay.configTree().entries.find((e) => e.path === 'stackDefaults.hub.HUB_REPO_PATH');

    expect(row?.default).toBeNull();
  });
});

describe('OverlayStoreService — the retired stackCounts phantom', () => {
  it('writes no stackCounts line, so the next save cleans it out of an existing overlay', async () => {
    const { overlay, dir } = await setupWithRoot();

    await overlay.setStackConfig({ entries: { 'telemetry.enable': 'true' } });

    expect(readFileSync(join(dir, 'stack.local.nix'), 'utf8')).not.toContain('stackCounts');
  });

  it('refuses a write to the retired path instead of persisting a number nothing reads', async () => {
    const { overlay } = await setupWithRoot();

    const res = await overlay.setStackConfig({ entries: { 'stackCounts.spoke': '4' } });

    expect(res.rejected).toEqual([{ path: 'stackCounts.spoke', reason: 'no-writer' }]);
  });

  it('reports the measured zone and bridge counts in its place', async () => {
    const { overlay } = await setupWithRoot();

    expect(overlay.stackConfig().topology).toEqual({ zones: 0, bridges: 2 });
  });
});

describe('OverlayStoreService — a knob the option declares no value for', () => {
  it('reports null on both surfaces, so neither one invents a blank', async () => {
    // the derived value would fill both sides in, and turbo does not forward this var, so leaving it
    // to the ambient environment made the check unable to fail
    vi.stubEnv('HUB_REPO_PATH', '');
    const { overlay } = await setupWithRoot();
    const path = 'stackDefaults.hub.HUB_REPO_PATH';

    const treeRow = overlay.configTree().entries.find((e) => e.path === path);
    const knob = overlay.stackConfig().knobs.hub.find((k) => k.path === path);

    expect(treeRow?.default).toBeNull();
    expect(knob?.default).toBeNull();
  });

  it('agrees across both surfaces for every knob, whatever the environment holds', async () => {
    const { overlay } = await setupWithRoot();
    const tree = new Map(overlay.configTree().entries.map((e) => [e.path, e.value]));

    for (const group of ['hub', 'spoke'] as const) {
      for (const knob of overlay.stackConfig().knobs[group]) {
        expect(tree.get(knob.path)).toBe(knob.default);
      }
    }
  });
});

describe('OverlayStoreService — a revert still costs what the change cost', () => {
  const idle = { status: 'idle' as const };

  it('arms the recreate latch when a port is reverted, not only when one is set', async () => {
    const { overlay } = await setupWithRoot();
    await overlay.setStackConfig({ entries: { 'ports.postgres': '5433' } });
    overlay.clearRebindPending();

    await overlay.setStackConfig({ entries: { 'ports.postgres': null } });

    expect(overlay.isRebindPending()).toBe(true);
  });

  it('lists a reverted path as still waiting on an apply', async () => {
    const { overlay } = await setupWithRoot();

    await overlay.setStackConfig({ entries: { 'ports.postgres': null } });

    expect(overlay.stackPending(idle).savedNotApplied.paths).toEqual(['ports.postgres']);
  });

  it('forgets the pending set once a plain apply clears it, not only a recreate', async () => {
    const { overlay } = await setupWithRoot();
    await overlay.setStackConfig({ entries: { 'stackDefaults.hub.LOG_LEVEL': 'warn' } });

    overlay.clearSatisfiedBy('redeploy');

    expect(overlay.stackPending(idle).savedNotApplied.paths).toEqual([]);
  });

  it('keeps a datastore-reset path pending after a redeploy, which does not perform one', async () => {
    const { overlay } = await setupWithRoot();
    await overlay.setStackConfig({ entries: { 'identity.pg.user': 'other', 'stackDefaults.hub.LOG_LEVEL': 'warn' } });

    overlay.clearSatisfiedBy('redeploy');

    const pending = overlay.stackPending(idle);
    expect(pending.savedNotApplied.paths).toEqual(['identity.pg.user']);
    expect(pending.resetRequired).toEqual(['identity.pg.user']);
  });

  it('keeps a datastore-reset path pending after a recreate too, since no apply performs one', async () => {
    const { overlay } = await setupWithRoot();
    await overlay.setStackConfig({ entries: { 'identity.pg.user': 'other' } });

    overlay.clearSatisfiedBy('rebind-recreate');

    expect(overlay.stackPending(idle).resetRequired).toEqual(['identity.pg.user']);
  });

  it('keeps a spoke path pending after a hub reload, which never restarted the spoke', async () => {
    const { overlay } = await setupWithRoot();
    await overlay.setStackConfig({
      entries: { 'stackDefaults.hub.LOG_LEVEL': 'warn', 'stackDefaults.spoke.LOG_LEVEL': 'debug' },
    });

    overlay.clearSatisfiedBy('reload-hub');

    expect(overlay.stackPending(idle).savedNotApplied.paths).toEqual(['stackDefaults.spoke.LOG_LEVEL']);
  });

  it('keeps a service reload pending after a fleet apply, which restarts no service', async () => {
    const { overlay } = await setupWithRoot();
    await overlay.setStackConfig({ entries: { 'stackDefaults.hub.LOG_LEVEL': 'warn' } });

    overlay.clearSatisfiedBy('fleet-op');

    expect(overlay.stackPending(idle).savedNotApplied.paths).toEqual(['stackDefaults.hub.LOG_LEVEL']);
  });

  it('records nothing pending for a class no action can apply', async () => {
    const { overlay } = await setupWithRoot();

    await overlay.setStackConfig({ entries: { 'telemetry.enable': 'false' } });

    expect(overlay.stackPending(idle).savedNotApplied).toEqual({ paths: [], classes: [] });
  });

  it('reports no foreign write when this process wrote every change itself', async () => {
    const { overlay } = await setupWithRoot();

    await overlay.setStackConfig({ entries: { 'stackDefaults.hub.LOG_LEVEL': 'warn' } });

    expect(overlay.stackPending(idle).unknownSince).toBeNull();
  });

  it('reports an overlay write it did not make, rather than a clean-looking stack', async () => {
    const { overlay, dir } = await setupWithRoot();
    const overlayFile = join(dir, 'stack.local.nix');
    await overlay.setStackConfig({ entries: { 'stackDefaults.hub.LOG_LEVEL': 'warn' } });
    overlay.clearSatisfiedBy('reload-hub');

    writeFileSync(overlayFile, '{ }\n');
    const future = new Date(Date.now() + 60_000);
    utimesSync(overlayFile, future, future);

    const pending = overlay.stackPending(idle);
    expect(pending.savedNotApplied.paths).toEqual([]);
    expect(pending.unknownSince).toBe(future.toISOString());
  });

  it('records a saved zone set as outstanding, so a refresh cannot lose the plan', async () => {
    const { overlay } = await setupWithRoot();
    const steps = [{ id: 'sim:seed', label: 'Seed the hub zone', why: 'the uuid derives from the index' }];

    overlay.setZonesConfig({ zones: [{ name: 'edge', index: 1, bridges: 1 }], nodeZones: {}, steps });

    const pending = overlay.stackPending(idle);
    expect(pending.savedNotApplied.classes).toEqual(['zone-apply']);
    expect(pending.zoneSteps).toEqual(steps);
  });

  it('forgets the zone steps once the seed op reports them applied', async () => {
    const { overlay } = await setupWithRoot();
    overlay.setZonesConfig({
      zones: [{ name: 'edge', index: 1, bridges: 1 }],
      nodeZones: {},
      steps: [{ id: 'sim:seed', label: 'x', why: 'y' }],
    });

    overlay.clearSatisfiedBy('zone-apply');

    const pending = overlay.stackPending(idle);
    expect(pending.savedNotApplied.paths).toEqual([]);
    expect(pending.zoneSteps).toEqual([]);
  });

  it('keeps the zone steps after an apply that does not reach them', async () => {
    const { overlay } = await setupWithRoot();
    overlay.setZonesConfig({
      zones: [{ name: 'edge', index: 1, bridges: 1 }],
      nodeZones: {},
      steps: [{ id: 'sim:seed', label: 'x', why: 'y' }],
    });

    overlay.clearSatisfiedBy('reload-hub');

    expect(overlay.stackPending(idle).zoneSteps).toHaveLength(1);
  });

  it('leaves the latch alone for a reverted path whose class is a reload', async () => {
    const { overlay } = await setupWithRoot();

    await overlay.setStackConfig({ entries: { 'stackDefaults.hub.LOG_LEVEL': null } });

    expect(overlay.isRebindPending()).toBe(false);
  });
});

describe('OverlayStoreService — a masked password submitted back is not a new password', () => {
  it('keeps the stored value when the client echoes the mask', async () => {
    const { overlay, dir } = await setupWithRoot();

    await overlay.setStackConfig({ entries: { 'identity.pg.password': '***' } });

    const text = readFileSync(join(dir, 'stack.local.nix'), 'utf8');
    expect(text).toContain('identity.pg.password = "labpass"');
    expect(text).not.toContain('identity.pg.password = "***"');
  });

  it('stores a genuinely new password', async () => {
    const { overlay, dir } = await setupWithRoot();

    await overlay.setStackConfig({ entries: { 'identity.pg.password': 'fresh' } });

    expect(readFileSync(join(dir, 'stack.local.nix'), 'utf8')).toContain('identity.pg.password = "fresh"');
  });
});

describe('OverlayStoreService — recovering an overlay whose own value broke the eval', () => {
  const POISONED = [
    '{ ... }:',
    '{',
    '  ports.postgres = 5433;',
    '  stack.fleetNodeCount = 9999;',
    '  fleet.zones."sim-zone".nodes."gpu-1" = {',
    '    "index" = 0;',
    '  };',
    '}',
    '',
  ].join('\n');

  async function setupPoisoned(): Promise<{ overlay: OverlayStoreService; path: string }> {
    seedEval.error = new Error('devenv eval failed: value 9999 is out of range');
    const { overlay, dir } = setupUnseeded();
    const path = join(dir, 'stack.local.nix');
    writeFileSync(path, POISONED);
    await overlay.reseed();
    return { overlay, path };
  }

  it('drops the line a removal names even though the mirror never seeded', async () => {
    const { overlay, path } = await setupPoisoned();

    const res = await overlay.setStackConfig({ entries: { 'stack.fleetNodeCount': null } });

    expect(res.applied).toEqual(['stack.fleetNodeCount']);
    expect(readFileSync(path, 'utf8')).not.toContain('fleetNodeCount');
    expect(readFileSync(path, 'utf8')).toContain('ports.postgres = 5433;');
  });

  it('refuses a multi-line block outright rather than orphaning its body', async () => {
    const { overlay, path } = await setupPoisoned();
    const before = readFileSync(path);

    const res = await overlay.setStackConfig({ entries: { 'fleet.zones."sim-zone".nodes."gpu-1"': null } });

    expect(res.applied).toEqual([]);
    expect(res.rejected).toEqual([{ path: 'fleet.zones."sim-zone".nodes."gpu-1"', reason: 'no-overlay-line' }]);
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it('names a path that has no line instead of reporting it removed', async () => {
    const { overlay, path } = await setupPoisoned();
    const before = readFileSync(path);

    const res = await overlay.setStackConfig({ entries: { 'telemetry.enable': null } });

    expect(res.applied).toEqual([]);
    expect(res.rejected).toEqual([{ path: 'telemetry.enable', reason: 'no-overlay-line' }]);
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it('still refuses a write that sets a value rather than removing one', async () => {
    const { overlay, path } = await setupPoisoned();
    const before = readFileSync(path);

    await expect(
      overlay.setStackConfig({ entries: { 'stack.fleetNodeCount': null, 'telemetry.enable': 'true' } }),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(readFileSync(path).equals(before)).toBe(true);
  });
});

describe('OverlayStoreService — the overlay file moving underneath', () => {
  it('reseeds after the overlay is removed, so the read stops serving the dropped override', async () => {
    const { overlay, dir } = await setupWithRoot();
    await overlay.setStackConfig({ entries: { 'stackDefaults.hub.LOG_LEVEL': 'warn' } });
    expect(overlay.stackConfig().values.hub).toEqual({ LOG_LEVEL: 'warn' });

    rmSync(join(dir, 'stack.local.nix'));
    overlay.stackConfig();
    await overlay.reseed();

    expect(overlay.stackConfig().values.hub).toEqual({});
  });

  it('reseeds after a foreign edit bumps the mtime', async () => {
    const { overlay, dir } = await setupWithRoot();
    await overlay.setStackConfig({ entries: { 'stackDefaults.hub.LOG_LEVEL': 'warn' } });
    const before = seedEval.calls;

    const later = new Date(Date.now() + 60_000);
    utimesSync(join(dir, 'stack.local.nix'), later, later);
    overlay.stackConfig();
    await overlay.reseed();

    expect(seedEval.calls).toBeGreaterThan(before);
  });

  it('refuses a save after the overlay is deleted instead of rebuilding the dropped override', async () => {
    const { overlay, dir } = await setupWithRoot();
    const path = join(dir, 'stack.local.nix');
    await overlay.setStackConfig({ entries: { 'stackDefaults.hub.LOG_LEVEL': 'warn' } });

    rmSync(path);
    await expect(overlay.setStackConfig({ entries: { 'telemetry.enable': 'true' } })).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(existsSync(path)).toBe(false);

    await overlay.reseed();
    await overlay.setStackConfig({ entries: { 'telemetry.enable': 'true' } });
    expect(readFileSync(path, 'utf8')).not.toContain('LOG_LEVEL');
  });

  it('refuses a save after a foreign edit, leaving stack.local.nix byte-unchanged', async () => {
    const { overlay, dir } = await setupWithRoot();
    const path = join(dir, 'stack.local.nix');
    await overlay.setStackConfig({ entries: { 'stackDefaults.hub.LOG_LEVEL': 'warn' } });

    const later = new Date(Date.now() + 60_000);
    writeFileSync(path, '{ }\n');
    utimesSync(path, later, later);
    const before = readFileSync(path);

    await expect(overlay.setStackConfig({ entries: { 'telemetry.enable': 'true' } })).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it('leaves the mirror alone while the file is still the one it wrote', async () => {
    const { overlay } = await setupWithRoot();
    await overlay.setStackConfig({ entries: { 'stackDefaults.hub.LOG_LEVEL': 'warn' } });
    overlay.configTree();
    await overlay.reseed();
    const before = seedEval.calls;

    overlay.stackConfig();
    overlay.configTree();
    overlay.stackConfig();

    expect(seedEval.calls).toBe(before);
  });
});
