import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { vi } from 'vitest';

import { PORTS } from '../../ports';
import { OverlayStoreService, type LabBridge } from '../overlay-store';
import type { PcProcess, PcProcessConfig, ProcessComposeClient } from '../process-compose.client';
import { RenderedConfigService } from '../rendered-config.service';
import { RosterService } from '../roster.service';

const proc = (over: Partial<PcProcess>): PcProcess => ({ name: 'x', status: 'Running', ...over });

const LAB_BRIDGES: LabBridge[] = [
  { proc: 'spoke', zone: 'sim-zone', replica: 0, port: PORTS.spoke.base, grpc: PORTS.spokeGrpc.base },
];

function makeRoster(procs: PcProcess[]) {
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
  const roster = new RosterService(pc as unknown as ProcessComposeClient, rendered, overlay);
  return { roster, pc, rendered, overlay };
}

describe('RosterService catalog-driven membership', () => {
  const writeCfg = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'lab-catalog-'));
    const cfgPath = join(dir, 'process-compose.yaml');
    writeFileSync(
      cfgPath,
      [
        'processes:',
        '  hub-api:',
        '    namespace: hub',
        '    description: Brokkr API',
        '    readiness_probe:',
        '      http_get:',
        '        port: 3000',
        '  lab:',
        '    namespace: control',
        '    description: Control Center API',
        '    readiness_probe:',
        '      http_get:',
        '        port: 3002',
        '  observability:',
        '    namespace: observability',
        '    description: Observability',
        '    readiness_probe:',
        '      http_get:',
        '        port: 9999',
        '  postgres:',
        '    namespace: datastore',
        '    description: Postgres',
        '  hub-admin:',
        '    namespace: hub',
        '    description: Hub Admin API',
        '    disabled: true',
        '',
      ].join('\n'),
    );
    return cfgPath;
  };

  it('parses namespace/label/port/disabled from the rendered config', async () => {
    const { rendered } = makeRoster([]);
    vi.spyOn(rendered, 'renderedConfigPath').mockResolvedValue(writeCfg());

    const catalog = await rendered.catalog();

    expect(catalog.get('lab')).toEqual({
      namespace: 'control',
      label: 'Control Center API',
      port: 3002,
      disabled: false,
      features: [],
    });
    expect(catalog.get('postgres')).toEqual({
      namespace: 'datastore',
      label: 'Postgres',
      port: null,
      disabled: false,
      features: [],
    });
    expect(catalog.get('hub-admin')?.disabled).toBe(true);
  });

  it('derives group/label/port from the catalog — incl. a novel namespace + a hub-api replica — and excludes datastores', async () => {
    const { roster, rendered } = makeRoster([
      proc({ name: 'hub-api', status: 'Running', is_ready: 'Ready' }),
      proc({ name: 'hub-api-1', status: 'Running', is_ready: 'Ready' }),
      proc({ name: 'lab', status: 'Running', is_ready: 'Ready' }),
      proc({ name: 'observability', status: 'Running', is_ready: 'Ready' }),
      proc({ name: 'postgres', status: 'Running', is_ready: 'Ready' }),
    ]);
    vi.spyOn(rendered, 'renderedConfigPath').mockResolvedValue(writeCfg());

    const services = await roster.list();
    const byId = new Map(services.map((s) => [s.id, s]));

    expect(byId.get('lab')).toMatchObject({
      group: 'control',
      label: 'Control Center API',
      port: 3002,
      canStop: false,
    });
    expect(byId.get('hub-api')).toMatchObject({ group: 'hub', port: 3000, canStop: true });
    expect(byId.get('hub-api-1')).toMatchObject({
      group: 'hub',
      label: 'Brokkr API 1',
      port: 3000 + PORTS.hubApi.step,
    });
    expect(byId.get('observability')).toMatchObject({ group: 'observability', label: 'Observability', port: 9999 });
    expect(byId.has('postgres')).toBe(false);
  });

  const writeSpokeCfg = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'lab-telegraf-'));
    const cfgPath = join(dir, 'process-compose.yaml');
    writeFileSync(
      cfgPath,
      [
        'processes:',
        '  spoke:',
        '    namespace: spoke',
        '    description: Bridge',
        '    readiness_probe:',
        '      http_get:',
        '        port: 8000',
        '  spoke-telegraf:',
        '    namespace: spoke',
        '    description: Telegraf',
        '',
      ].join('\n'),
    );
    return cfgPath;
  };

  it('renders a telegraf sibling as a spoke card in the live roster', async () => {
    const { roster, rendered } = makeRoster([
      proc({ name: 'spoke', status: 'Running', is_ready: 'Ready' }),
      proc({ name: 'spoke-telegraf', status: 'Running', is_ready: 'Ready' }),
    ]);
    vi.spyOn(rendered, 'renderedConfigPath').mockResolvedValue(writeSpokeCfg());

    const byId = new Map((await roster.list()).map((s) => [s.id, s]));

    expect(byId.get('spoke-telegraf')).toMatchObject({ group: 'spoke', label: 'Telegraf' });
    expect(byId.has('spoke')).toBe(true);
  });

  it('nests the telegraf sibling under its bridge zone (inherits zone from the labBridges roster)', async () => {
    const { roster, rendered, overlay } = makeRoster([
      proc({ name: 'spoke', status: 'Running', is_ready: 'Ready' }),
      proc({ name: 'spoke-telegraf', status: 'Running', is_ready: 'Ready' }),
    ]);
    vi.spyOn(rendered, 'renderedConfigPath').mockResolvedValue(writeSpokeCfg());
    vi.spyOn(overlay, 'labBridges').mockReturnValue(LAB_BRIDGES);

    const byId = new Map((await roster.list()).map((s) => [s.id, s]));

    expect(byId.get('spoke')?.zone).toBe('sim-zone');
    expect(byId.get('spoke-telegraf')?.zone).toBe('sim-zone');
  });

  it('includes the telegraf sibling in the offline defs() roster without double-emitting the bridge', async () => {
    const { roster, pc, rendered } = makeRoster([]);
    pc.listAll.mockRejectedValue(new Error('pc down'));
    vi.spyOn(rendered, 'renderedConfigPath').mockResolvedValue(writeSpokeCfg());

    const roll = await roster.list();

    expect(roll.filter((s) => s.id === 'spoke-telegraf')).toEqual([
      expect.objectContaining({ group: 'spoke', label: 'Telegraf', health: 'missing' }),
    ]);
    expect(roll.filter((s) => s.id === 'spoke')).toHaveLength(1);
  });
});

describe('RosterService.list — process telemetry', () => {
  const writeTelemetryCfg = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'lab-telemetry-'));
    const cfgPath = join(dir, 'process-compose.yaml');
    writeFileSync(
      cfgPath,
      [
        'processes:',
        '  hub-api:',
        '    namespace: hub',
        '    description: Brokkr API',
        '    readiness_probe:',
        '      http_get:',
        '        port: 3000',
        '',
      ].join('\n'),
    );
    return cfgPath;
  };

  it('maps cpu/mem/system_time onto a running service', async () => {
    const { roster, rendered } = makeRoster([
      proc({ name: 'hub-api', status: 'Running', is_ready: 'Ready', cpu: 1.25, mem: 152174592, system_time: '2d5h' }),
    ]);
    vi.spyOn(rendered, 'renderedConfigPath').mockResolvedValue(writeTelemetryCfg());

    const svc = (await roster.list()).find((s) => s.id === 'hub-api');

    expect(svc).toMatchObject({ cpuPct: 1.25, memBytes: 152174592, age: '2d5h' });
  });

  it('maps telemetry on a running bridge service', async () => {
    const { roster, rendered, overlay } = makeRoster([
      proc({ name: 'spoke', status: 'Running', is_ready: 'Ready', cpu: 0.5, mem: 1024, system_time: '3h' }),
    ]);
    vi.spyOn(rendered, 'renderedConfigPath').mockResolvedValue(writeTelemetryCfg());
    vi.spyOn(overlay, 'labBridges').mockReturnValue(LAB_BRIDGES);

    const svc = (await roster.list()).find((s) => s.id === 'spoke');

    expect(svc).toMatchObject({ cpuPct: 0.5, memBytes: 1024, age: '3h' });
  });

  it('omits telemetry when the process is stopped', async () => {
    const { roster, rendered } = makeRoster([
      proc({ name: 'hub-api', status: 'Completed', cpu: 1.25, mem: 152174592, system_time: '2d5h' }),
    ]);
    vi.spyOn(rendered, 'renderedConfigPath').mockResolvedValue(writeTelemetryCfg());

    const svc = (await roster.list()).find((s) => s.id === 'hub-api');

    expect(svc?.cpuPct).toBeUndefined();
    expect(svc?.memBytes).toBeUndefined();
    expect(svc?.age).toBeUndefined();
  });

  it('omits telemetry fields that are null or absent', async () => {
    const { roster, rendered } = makeRoster([
      proc({ name: 'hub-api', status: 'Running', is_ready: 'Ready', cpu: null, system_time: null }),
    ]);
    vi.spyOn(rendered, 'renderedConfigPath').mockResolvedValue(writeTelemetryCfg());

    const svc = (await roster.list()).find((s) => s.id === 'hub-api');

    expect(svc?.cpuPct).toBeUndefined();
    expect(svc?.memBytes).toBeUndefined();
    expect(svc?.age).toBeUndefined();
  });
});

describe('RosterService.list — catalog degradation', () => {
  it('list() degrades (no throw, empty roster) when the catalog is unavailable but pc has processes', async () => {
    const { roster, rendered } = makeRoster([proc({ name: 'hub-api', status: 'Running', is_ready: 'Ready' })]);
    vi.spyOn(rendered, 'renderedConfigPath').mockRejectedValue(new Error('no devenv'));
    vi.spyOn(rendered, 'dependsGraph').mockResolvedValue({});

    await expect(roster.list()).resolves.toEqual([]);
  });
});

describe('RosterService — web-UI catalog markers + app links', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const writeCfg = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'lab-webui-'));
    const cfgPath = join(dir, 'process-compose.yaml');
    writeFileSync(
      cfgPath,
      [
        'processes:',
        '  hub-web:',
        '    namespace: hub',
        '    description: Hub',
        '    readiness_probe:',
        '      http_get:',
        '        port: 5173',
        '    environment:',
        '      - LAB_WEB_UI=Hub',
        '  hub-api:',
        '    namespace: hub',
        '    description: Hub API',
        '    readiness_probe:',
        '      http_get:',
        '        port: 3000',
        '    environment:',
        '      - LAB_WEB_UI=Hub Swagger',
        '      - LAB_WEB_PATH=/api/swagger',
        '  mailpit:',
        '    namespace: datastore',
        '    description: Mailpit',
        '    environment:',
        '      - LAB_WEB_UI=Mailpit',
        '      - LAB_WEB_PORT=8025',
        '  grafana:',
        '    namespace: observability',
        '    description: Grafana',
        '    readiness_probe:',
        '      http_get:',
        '        port: 4300',
        '    environment:',
        '      - LAB_WEB_UI=Grafana',
        '      - LAB_WEB_LOOPBACK=true',
        '  postgres:',
        '    namespace: datastore',
        '    description: Postgres',
        '',
      ].join('\n'),
    );
    return cfgPath;
  };

  it('extracts webUi from LAB_WEB_UI markers (spaces in label, explicit path, port override, absent)', async () => {
    const { rendered } = makeRoster([]);
    vi.spyOn(rendered, 'renderedConfigPath').mockResolvedValue(writeCfg());

    const catalog = await rendered.catalog();

    expect(catalog.get('hub-web')?.webUi).toEqual({ label: 'Hub', path: '/', port: 5173, loopback: false });
    expect(catalog.get('hub-api')?.webUi).toEqual({
      label: 'Hub Swagger',
      path: '/api/swagger',
      port: 3000,
      loopback: false,
    });
    expect(catalog.get('mailpit')?.webUi).toEqual({ label: 'Mailpit', path: '/', port: 8025, loopback: false });
    expect(catalog.get('grafana')?.webUi).toEqual({ label: 'Grafana', path: '/', port: 4300, loopback: true });
    expect(catalog.get('postgres')?.webUi).toBeUndefined();
  });

  it('derives app links (readiness via listAll, loopback for the sink), omitting unmarked + disabled', async () => {
    const { roster, rendered } = makeRoster([
      proc({ name: 'hub-web', status: 'Running', is_ready: 'Ready' }),
      proc({ name: 'hub-api', status: 'Running', is_ready: 'Not Ready' }),
      proc({ name: 'mailpit', status: 'Running', is_ready: '-' }),
      proc({ name: 'grafana', status: 'Disabled' }),
      proc({ name: 'postgres', status: 'Running', is_ready: 'Ready' }),
    ]);
    vi.spyOn(rendered, 'renderedConfigPath').mockResolvedValue(writeCfg());

    const links = await roster.listAppLinks();
    const byId = new Map(links.map((l) => [l.id, l]));

    expect(byId.get('hub-web')).toEqual({
      id: 'hub-web',
      label: 'Hub',
      path: '/',
      port: 5173,
      ready: true,
      loopback: false,
    });
    expect(byId.get('hub-api')).toEqual({
      id: 'hub-api',
      label: 'Hub Swagger',
      path: '/api/swagger',
      port: 3000,
      ready: false,
      loopback: false,
    });
    expect(byId.get('mailpit')).toEqual({
      id: 'mailpit',
      label: 'Mailpit',
      path: '/',
      port: 8025,
      ready: true,
      loopback: false,
    });
    expect(byId.has('grafana')).toBe(false);
    expect(byId.has('postgres')).toBe(false);
    expect(links.map((l) => l.port)).toEqual([3000, 5173, 8025]);
  });

  it('degrades to catalog-derived links (all not-ready) when process-compose is unreachable', async () => {
    const { roster, pc, rendered } = makeRoster([]);
    pc.listAll.mockRejectedValueOnce(new Error('pc down'));
    vi.spyOn(rendered, 'renderedConfigPath').mockResolvedValue(writeCfg());

    const links = await roster.listAppLinks();
    const byId = new Map(links.map((l) => [l.id, l]));

    expect(byId.get('hub-web')).toMatchObject({ id: 'hub-web', ready: false });
    expect(byId.get('mailpit')).toMatchObject({ id: 'mailpit', ready: false });
    expect(byId.has('postgres')).toBe(false);
  });

  it('reuses the last successful roster when a later process-compose call fails', async () => {
    const { roster, pc, rendered } = makeRoster([
      proc({ name: 'hub-web', status: 'Running', is_ready: 'Ready' }),
      proc({ name: 'mailpit', status: 'Running', is_ready: '-' }),
    ]);
    vi.spyOn(rendered, 'renderedConfigPath').mockResolvedValue(writeCfg());

    await roster.listAppLinks();
    pc.listAll.mockRejectedValue(new Error('pc down'));
    const links = await roster.listAppLinks();
    const byId = new Map(links.map((l) => [l.id, l]));

    expect(byId.get('hub-web')).toMatchObject({ id: 'hub-web', ready: true });
    expect(byId.get('mailpit')).toMatchObject({ id: 'mailpit', ready: true });
    expect(byId.has('hub-api')).toBe(false);
  });

  it('falls back to catalog-derived links once the reused roster goes stale', async () => {
    const { roster, pc, rendered } = makeRoster([proc({ name: 'hub-web', status: 'Running', is_ready: 'Ready' })]);
    vi.spyOn(rendered, 'renderedConfigPath').mockResolvedValue(writeCfg());
    const startedAt = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(startedAt);

    await roster.listAppLinks();
    pc.listAll.mockRejectedValue(new Error('pc down'));
    vi.setSystemTime(startedAt + 31_000);
    const links = await roster.listAppLinks();
    const byId = new Map(links.map((l) => [l.id, l]));

    expect(byId.get('hub-web')).toMatchObject({ id: 'hub-web', ready: false });
    expect(byId.get('hub-api')).toMatchObject({ id: 'hub-api', ready: false });
  });

  it('marks the running observability sink loopback and reflects its readiness', async () => {
    const { roster, rendered } = makeRoster([proc({ name: 'grafana', status: 'Running', is_ready: 'Ready' })]);
    vi.spyOn(rendered, 'renderedConfigPath').mockResolvedValue(writeCfg());

    const grafana = (await roster.listAppLinks()).find((l) => l.id === 'grafana');

    expect(grafana).toEqual({ id: 'grafana', label: 'Grafana', path: '/', port: 4300, ready: true, loopback: true });
  });

  it('omits a UI whose resolved port is outside the valid TCP range (never leaks past AppLinkSchema)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lab-badport-'));
    const cfgPath = join(dir, 'process-compose.yaml');
    writeFileSync(
      cfgPath,
      [
        'processes:',
        '  bad-ui:',
        '    namespace: hub',
        '    description: Bad',
        '    environment:',
        '      - LAB_WEB_UI=Bad',
        '      - LAB_WEB_PORT=99999',
        '',
      ].join('\n'),
    );
    const { roster, rendered } = makeRoster([proc({ name: 'bad-ui', status: 'Running', is_ready: 'Ready' })]);
    vi.spyOn(rendered, 'renderedConfigPath').mockResolvedValue(cfgPath);

    expect(await roster.listAppLinks()).toEqual([]);
  });

  it('normalizes a LAB_WEB_PATH without a leading slash to an absolute path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lab-webpath-'));
    const cfgPath = join(dir, 'process-compose.yaml');
    writeFileSync(
      cfgPath,
      [
        'processes:',
        '  hub-web:',
        '    namespace: hub',
        '    description: Hub',
        '    readiness_probe:',
        '      http_get:',
        '        port: 5173',
        '    environment:',
        '      - LAB_WEB_UI=Hub',
        '      - LAB_WEB_PATH=console',
        '',
      ].join('\n'),
    );
    const { rendered } = makeRoster([]);
    vi.spyOn(rendered, 'renderedConfigPath').mockResolvedValue(cfgPath);

    expect((await rendered.catalog()).get('hub-web')?.webUi).toEqual({
      label: 'Hub',
      path: '/console',
      port: 5173,
      loopback: false,
    });
  });

  it('omits a marked process whose port resolves to 0 and warns only once across polls', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lab-webzero-'));
    const cfgPath = join(dir, 'process-compose.yaml');
    writeFileSync(
      cfgPath,
      [
        'processes:',
        '  brokenui:',
        '    namespace: hub',
        '    description: Broken',
        '    environment:',
        '      - LAB_WEB_UI=Broken',
        '  hub-web:',
        '    namespace: hub',
        '    description: Hub',
        '    readiness_probe:',
        '      http_get:',
        '        port: 5173',
        '    environment:',
        '      - LAB_WEB_UI=Hub',
        '',
      ].join('\n'),
    );
    const { roster, rendered } = makeRoster([
      proc({ name: 'brokenui', status: 'Running', is_ready: 'Ready' }),
      proc({ name: 'hub-web', status: 'Running', is_ready: 'Ready' }),
    ]);
    vi.spyOn(rendered, 'renderedConfigPath').mockResolvedValue(cfgPath);
    const warn = vi.spyOn(roster['log'], 'warn').mockImplementation(() => undefined);

    const links = await roster.listAppLinks();
    expect(links.map((l) => l.id)).toEqual(['hub-web']);

    await roster.listAppLinks();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
