import { dump as dumpYaml, load as loadYaml } from 'js-yaml';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { APPLY_SCOPE_ALL, applyScopeNamespaces } from '../apply-scope';
import type { PcProcessConfig, ProcessComposeClient } from '../process-compose.client';
import { featuresFromEnv, RenderedConfigService } from '../rendered-config.service';
import { scratchTmpDir, useScratchState } from './isolated-state';

function makeService() {
  const pc = {
    listAll: vi.fn(async () => []),
    projectUpdate: vi.fn(async () => undefined),
  };
  const svc = new RenderedConfigService(pc as unknown as ProcessComposeClient);
  return { svc, pc };
}

describe('RenderedConfigService.dependsGraph — failure caching + dedup', () => {
  it('does not rebuild within the cooldown after a failure', async () => {
    const { svc } = makeService();
    const build = vi.spyOn(svc, 'renderedConfigPath').mockRejectedValue(new Error('no devenv'));

    expect(await svc.dependsGraph()).toEqual({});
    expect(await svc.dependsGraph()).toEqual({});
    expect(await svc.dependsGraph()).toEqual({});

    expect(build).toHaveBeenCalledTimes(1);
  });

  it('shares a single build across concurrent callers', async () => {
    const { svc } = makeService();
    let release!: (path: string) => void;
    const build = vi.spyOn(svc, 'renderedConfigPath').mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );

    const all = Promise.all([svc.dependsGraph(), svc.dependsGraph(), svc.dependsGraph()]);
    release('/nonexistent/process-compose.yaml');
    await all;

    expect(build).toHaveBeenCalledTimes(1);
  });

  it('retries after the cooldown elapses', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { svc } = makeService();
    const build = vi.spyOn(svc, 'renderedConfigPath').mockRejectedValue(new Error('no devenv'));

    await svc.dependsGraph();
    expect(build).toHaveBeenCalledTimes(1);

    vi.setSystemTime(31_000);
    await svc.dependsGraph();
    expect(build).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('discards a graph from a build that straddled an applyOverlay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lab-deps-'));
    const stalePath = join(dir, 'stale.yaml');
    const freshPath = join(dir, 'fresh.yaml');
    const throwaway = join(dir, 'cfg.yaml');
    writeFileSync(stalePath, 'processes:\n  a:\n    depends_on:\n      b: {}\n');
    writeFileSync(freshPath, 'processes:\n  a:\n    depends_on:\n      c: {}\n');
    writeFileSync(throwaway, 'processes: {}\n');

    const { svc } = makeService();
    let releaseStale!: (path: string) => void;
    const build = vi
      .spyOn(svc, 'renderedConfigPath')
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            releaseStale = resolve;
          }),
      )
      .mockImplementationOnce(async () => throwaway)
      .mockImplementationOnce(async () => freshPath);

    const poll = svc.dependsGraph();
    await svc.applyOverlay();
    releaseStale(stalePath);
    await poll;

    expect(await svc.dependsGraph()).toEqual({ a: ['c'] });
    expect(build).toHaveBeenCalledTimes(3);
  });
});

describe('RenderedConfigService.catalog — failure handling', () => {
  it('throws on read failure and negatively-caches (no rebuild within the cooldown)', async () => {
    const { svc } = makeService();
    const build = vi.spyOn(svc, 'renderedConfigPath').mockRejectedValue(new Error('no devenv'));

    await expect(svc.catalog()).rejects.toThrow();
    await expect(svc.catalog()).rejects.toThrow();

    expect(build).toHaveBeenCalledTimes(1);
  });

  it('catalogOrEmpty degrades to an empty map (no throw) for the render paths', async () => {
    const { svc } = makeService();
    vi.spyOn(svc, 'renderedConfigPath').mockRejectedValue(new Error('no devenv'));

    await expect(svc.catalogOrEmpty()).resolves.toEqual(new Map());
  });
});

describe('RenderedConfigService.buildRenderedConfig — W2 forced render bypasses cache + in-flight', () => {
  type Internals = {
    loadRenderedConfigPath(opts?: { refreshEvalCache?: boolean }): Promise<string>;
    renderedConfigPath(): Promise<string>;
  };

  it('passes refreshEvalCache and bypasses the cached rendered-config path', async () => {
    const { svc } = makeService();
    const t = svc as unknown as Internals;
    const load = vi.spyOn(t, 'loadRenderedConfigPath').mockResolvedValue('/nix/store/stale-cached');
    await t.renderedConfigPath();

    load.mockResolvedValue('/nix/store/fresh-forced');
    const path = await svc.buildRenderedConfig({ refreshEvalCache: true });

    expect(path).toBe('/nix/store/fresh-forced');
    expect(load).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenLastCalledWith({ refreshEvalCache: true });
    await expect(t.renderedConfigPath()).resolves.toBe('/nix/store/fresh-forced');
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('RenderedConfigService.applyOverlay — scoped blast radius', () => {
  const stateDir = useScratchState();

  const RENDERED_HASH = '1111111111111111111111111111111a';
  const LIVE_HASH = '2222222222222222222222222222222b';
  const cmd = (hash: string, name: string): string =>
    `exec /nix/store/zzz-devenv-tasks/bin/devenv-tasks run --task-file /nix/store/${hash}-tasks.json ${name}`;

  const live: Record<string, PcProcessConfig> = {
    'hub-api': {
      command: cmd(LIVE_HASH, 'hub-api'),
      environment: ['HUB_PORT=3000'],
      dependsOn: { redis: { condition: 'process_healthy' } },
      namespace: 'hub',
    },
    redis: {
      command: cmd(LIVE_HASH, 'redis'),
      environment: ['REDIS_PORT=6379'],
      dependsOn: {},
      namespace: 'datastore',
    },
    lab: { command: cmd(LIVE_HASH, 'lab'), environment: ['LAB_PORT=3002'], dependsOn: {}, namespace: 'control' },
  };

  const procBlocks: Record<string, string[]> = {
    'hub-api': [
      '  hub-api:',
      '    namespace: hub',
      `    command: ${cmd(RENDERED_HASH, 'hub-api')}`,
      '    environment:',
      '      - HUB_PORT=3010',
      '    depends_on:',
      '      redis:',
      '        condition: process_healthy',
    ],
    redis: [
      '  redis:',
      '    namespace: datastore',
      `    command: ${cmd(RENDERED_HASH, 'redis')}`,
      '    environment:',
      '      - REDIS_PORT=6380',
    ],
    lab: [
      '  lab:',
      '    namespace: control',
      `    command: ${cmd(RENDERED_HASH, 'lab')}`,
      '    environment:',
      '      - LAB_PORT=3012',
    ],
  };

  const writeCfg = (omit: string[] = []): string => {
    const dir = mkdtempSync(join(tmpdir(), 'lab-scope-'));
    const cfgPath = join(dir, 'process-compose.yaml');
    const body = Object.entries(procBlocks)
      .filter(([name]) => !omit.includes(name))
      .flatMap(([, lines]) => lines);
    writeFileSync(cfgPath, ['processes:', ...body, ''].join('\n'));
    return cfgPath;
  };

  const scopedService = (over: Partial<Record<string, () => Promise<PcProcessConfig>>> = {}) => {
    const pc = {
      listAll: vi.fn(async () => Object.keys(live).map((name) => ({ name, status: 'Running' }))),
      processInfo: vi.fn((name: string) => (over[name] ? over[name]!() : Promise.resolve(live[name]))),
      projectUpdate: vi.fn(async (_path: string) => undefined),
    };
    const svc = new RenderedConfigService(pc as unknown as ProcessComposeClient);
    return { svc, pc };
  };

  const submittedPath = (pc: { projectUpdate: { mock: { calls: unknown[][] } } }, i = 0): unknown =>
    pc.projectUpdate.mock.calls[i][0];

  const submitted = (pc: {
    projectUpdate: { mock: { calls: unknown[][] } };
  }): Record<string, Record<string, unknown>> => {
    const path = pc.projectUpdate.mock.calls[0][0];
    if (typeof path !== 'string') throw new Error('projectUpdate was not called with a path');
    const doc = loadYaml(readFileSync(path, 'utf8'));
    if (!doc || typeof doc !== 'object' || !('processes' in doc)) throw new Error('submitted config has no processes');
    const procs = doc.processes;
    if (!procs || typeof procs !== 'object') throw new Error('submitted config has no processes');
    return JSON.parse(JSON.stringify(procs));
  };

  it('submits a process the render adds inside the scope, since an unsupervised one kills nothing', async () => {
    const { svc, pc } = scopedService({ 'hub-api-2': () => Promise.reject(new Error('no such process')) });
    const dir = mkdtempSync(join(tmpdir(), 'lab-scope-'));
    const cfgPath = join(dir, 'process-compose.yaml');
    writeFileSync(
      cfgPath,
      [
        'processes:',
        ...Object.values(procBlocks).flat(),
        '  hub-api-2:',
        '    namespace: hub',
        `    command: ${cmd(RENDERED_HASH, 'hub-api-2')}`,
        '    environment:',
        '      - HUB_PORT=3020',
        '',
      ].join('\n'),
    );

    await svc.applyOverlay(cfgPath, applyScopeNamespaces('hub'));

    expect(submitted(pc)['hub-api-2']).toBeDefined();
  });

  it('submits a process the render adds outside the scope too, since pinning it has no running spec', async () => {
    const { svc, pc } = scopedService({ 'spoke-zone-1': () => Promise.reject(new Error('no such process')) });
    const dir = mkdtempSync(join(tmpdir(), 'lab-scope-'));
    const cfgPath = join(dir, 'process-compose.yaml');
    writeFileSync(
      cfgPath,
      [
        'processes:',
        ...Object.values(procBlocks).flat(),
        '  spoke-zone-1:',
        '    namespace: spoke',
        `    command: ${cmd(RENDERED_HASH, 'spoke-zone-1')}`,
        '    environment:',
        '      - PORT=8001',
        '',
      ].join('\n'),
    );

    await svc.applyOverlay(cfgPath, applyScopeNamespaces('hub'));

    expect(submitted(pc)['spoke-zone-1']).toBeDefined();
  });

  it('serialises concurrent applies so each submits its own pin', async () => {
    const { svc, pc } = scopedService();
    const seen: string[] = [];
    pc.projectUpdate.mockImplementation(async (path: string) => {
      seen.push(readFileSync(path, 'utf8'));
    });

    await Promise.all([
      svc.applyOverlay(writeCfg(), applyScopeNamespaces('hub')),
      svc.applyOverlay(writeCfg(), applyScopeNamespaces('datastore')),
    ]);

    expect(seen).toHaveLength(2);
    expect(new Set(seen).size).toBe(2);
    expect(seen.some((y) => y.includes(cmd(LIVE_HASH, 'redis')) && y.includes(cmd(RENDERED_HASH, 'hub-api')))).toBe(
      true,
    );
    expect(seen.some((y) => y.includes(cmd(LIVE_HASH, 'hub-api')) && y.includes(cmd(RENDERED_HASH, 'redis')))).toBe(
      true,
    );
  });

  it('refuses when process-compose reports no supervised processes', async () => {
    const { svc, pc } = scopedService();
    pc.listAll.mockResolvedValue([]);

    await expect(svc.applyOverlay(writeCfg(), applyScopeNamespaces('hub'))).rejects.toThrow(
      /no supervised processes/,
    );
    expect(pc.projectUpdate).not.toHaveBeenCalled();
  });

  it('refuses a config that declares no processes map', async () => {
    const { svc, pc } = scopedService();
    const dir = mkdtempSync(join(tmpdir(), 'lab-noproc-'));
    const cfgPath = join(dir, 'process-compose.yaml');
    writeFileSync(cfgPath, 'version: "0.5"\n');

    await expect(svc.applyOverlay(cfgPath, applyScopeNamespaces('hub'))).rejects.toThrow(
      /declares no processes map/,
    );
    expect(pc.projectUpdate).not.toHaveBeenCalled();
  });

  it('refuses when the submitted config no longer matches the running out-of-scope spec', async () => {
    const seen = new Map<string, number>();
    const { svc, pc } = scopedService({
      redis: () => {
        const n = (seen.get('redis') ?? 0) + 1;
        seen.set('redis', n);
        return Promise.resolve(n < 3 ? live.redis : { ...live.redis, command: cmd(LIVE_HASH, 'redis-moved') });
      },
    });

    await expect(svc.applyOverlay(writeCfg(), applyScopeNamespaces('hub'))).rejects.toThrow(/the pin did not take/);
    expect(pc.projectUpdate).not.toHaveBeenCalled();
  });

  it('leaves every out-of-scope process spec identical to the one it is running', async () => {
    const { svc, pc } = scopedService();

    await svc.applyOverlay(writeCfg(), applyScopeNamespaces('hub'));

    const procs = submitted(pc);
    expect(procs.redis.command).toBe(live.redis.command);
    expect(procs.redis.environment).toEqual(live.redis.environment);
    expect(procs.redis.namespace).toBe('datastore');
    expect(procs.lab.command).toBe(live.lab.command);
    expect(procs.lab.environment).toEqual(live.lab.environment);
  });

  it('still applies the rendered spec to the in-scope namespace', async () => {
    const { svc, pc } = scopedService();

    await svc.applyOverlay(writeCfg(), applyScopeNamespaces('hub'));

    const procs = submitted(pc);
    expect(procs['hub-api'].command).toBe(cmd(RENDERED_HASH, 'hub-api'));
    expect(procs['hub-api'].environment).toEqual(['HUB_PORT=3010']);
  });

  it('pins the control namespace even under the widest scope', async () => {
    const { svc, pc } = scopedService();

    await svc.applyOverlay(writeCfg(), APPLY_SCOPE_ALL);

    const procs = submitted(pc);
    expect(procs.lab.command).toBe(live.lab.command);
    expect(procs.lab.environment).toEqual(live.lab.environment);
    expect(procs.redis.command).toBe(cmd(RENDERED_HASH, 'redis'));
  });

  it('keeps an out-of-scope process disabled when the rendered config would enable it', async () => {
    const { svc, pc } = scopedService();
    pc.processInfo.mockImplementation((name: string) =>
      Promise.resolve(name === 'redis' ? { ...live.redis, disabled: true } : live[name]),
    );

    await svc.applyOverlay(writeCfg(), applyScopeNamespaces('hub'));

    expect(submitted(pc).redis.disabled).toBe(true);
  });

  it('fails the apply when a running spec cannot be read, rather than swapping the process', async () => {
    const { svc, pc } = scopedService({ redis: () => Promise.reject(new Error('HTTP 404')) });

    await expect(svc.applyOverlay(writeCfg(), applyScopeNamespaces('hub'))).rejects.toThrow(/redis/);
    expect(pc.projectUpdate).not.toHaveBeenCalled();
  });

  it('fails the apply when a running spec reports no command', async () => {
    const { svc, pc } = scopedService({ redis: () => Promise.resolve({ environment: [] }) });

    await expect(svc.applyOverlay(writeCfg(), applyScopeNamespaces('hub'))).rejects.toThrow(/redis/);
    expect(pc.projectUpdate).not.toHaveBeenCalled();
  });

  const applied = (state: string, specs: Record<string, unknown>): void => {
    mkdirSync(join(state, 'lab'), { recursive: true });
    writeFileSync(join(state, 'lab', 'overlay-process-compose.yaml'), dumpYaml({ processes: specs }));
  };

  const appliedRedis = (state: string, over: Record<string, unknown> = {}): void =>
    applied(state, {
      redis: {
        command: live.redis.command,
        environment: live.redis.environment,
        namespace: 'datastore',
        readiness_probe: { exec: { command: 'redis-cli ping' } },
        availability: { restart: 'always' },
        shutdown: { signal: 15 },
        ...over,
      },
    });

  it('writes the submitted config to one reused state-dir path, leaving no temp directory behind', async () => {
    const cfgA = writeCfg();
    const cfgB = writeCfg();
    scratchTmpDir();
    const { svc, pc } = scopedService();

    await svc.applyOverlay(cfgA, applyScopeNamespaces('hub'));
    await svc.applyOverlay(cfgB, applyScopeNamespaces('hub'));

    const expected = join(stateDir(), 'lab', 'overlay-process-compose.yaml');
    expect(submittedPath(pc, 0)).toBe(expected);
    expect(submittedPath(pc, 1)).toBe(expected);
    expect(readdirSync(tmpdir())).toEqual([]);
  });

  it('leaves no temp directory behind when the apply is refused', async () => {
    const cfg = writeCfg();
    scratchTmpDir();
    const { svc, pc } = scopedService({ redis: () => Promise.reject(new Error('HTTP 404')) });

    await expect(svc.applyOverlay(cfg, applyScopeNamespaces('hub'))).rejects.toThrow(/redis/);

    expect(pc.projectUpdate).not.toHaveBeenCalled();
    expect(readdirSync(tmpdir())).toEqual([]);
  });

  it('keeps a supervised out-of-scope process the new render no longer declares', async () => {
    appliedRedis(stateDir());
    const { svc, pc } = scopedService();

    await svc.applyOverlay(writeCfg(['redis']), applyScopeNamespaces('hub'));

    const procs = submitted(pc);
    expect(procs.redis.command).toBe(live.redis.command);
    expect(procs.redis.environment).toEqual(live.redis.environment);
    expect(procs.redis.namespace).toBe('datastore');
  });

  it('revives it with the readiness_probe, availability and shutdown the last apply gave it', async () => {
    appliedRedis(stateDir());
    const { svc, pc } = scopedService();

    await svc.applyOverlay(writeCfg(['redis']), applyScopeNamespaces('hub'));

    const procs = submitted(pc);
    expect(procs.redis.readiness_probe).toEqual({ exec: { command: 'redis-cli ping' } });
    expect(procs.redis.availability).toEqual({ restart: 'always' });
    expect(procs.redis.shutdown).toEqual({ signal: 15 });
  });

  it('refuses to revive a dropped process when no applied config can source its spec', async () => {
    const { svc, pc } = scopedService();

    await expect(svc.applyOverlay(writeCfg(['redis']), applyScopeNamespaces('hub'))).rejects.toThrow(/redis/);
    expect(pc.projectUpdate).not.toHaveBeenCalled();
  });

  it('refuses to revive from an applied config that no longer describes the running process', async () => {
    appliedRedis(stateDir(), { command: 'exec redis-server --port 9999' });
    const { svc, pc } = scopedService();

    await expect(svc.applyOverlay(writeCfg(['redis']), applyScopeNamespaces('hub'))).rejects.toThrow(/redis/);
    expect(pc.projectUpdate).not.toHaveBeenCalled();
  });

  it('refuses to revive from an applied config that is silent about the process', async () => {
    applied(stateDir(), { postgres: { command: 'exec postgres', environment: [] } });
    const { svc, pc } = scopedService();

    await expect(svc.applyOverlay(writeCfg(['redis']), applyScopeNamespaces('hub'))).rejects.toThrow(/redis/);
    expect(pc.projectUpdate).not.toHaveBeenCalled();
  });

  it('lets a supervised in-scope process the new render no longer declares go', async () => {
    const { svc, pc } = scopedService();

    await svc.applyOverlay(writeCfg(['redis']), applyScopeNamespaces('datastore'));

    expect(pc.projectUpdate).toHaveBeenCalled();
    expect(submitted(pc).redis).toBeUndefined();
  });

  it('refuses a dropped out-of-scope process whose depends_on cannot be re-declared', async () => {
    const { svc, pc } = scopedService({
      redis: () => Promise.resolve({ ...live.redis, dependsOn: { postgres: { condition: 3 } } }),
    });

    await expect(svc.applyOverlay(writeCfg(['redis']), applyScopeNamespaces('hub'))).rejects.toThrow(/redis/);
    expect(pc.projectUpdate).not.toHaveBeenCalled();
  });

  it('refuses to submit a config that would delete a supervised out-of-scope process', async () => {
    const { svc, pc } = scopedService();
    vi.spyOn(
      svc as unknown as { pinOutOfScope(cfgPath: string): Promise<{ path: string; namespaces: Map<string, string> }> },
      'pinOutOfScope',
    ).mockImplementation(async (cfgPath: string) => ({
      path: cfgPath,
      namespaces: new Map([
        ['hub-api', 'hub'],
        ['redis', 'datastore'],
        ['lab', 'control'],
      ]),
    }));

    await expect(svc.applyOverlay(writeCfg(['redis']), applyScopeNamespaces('hub'))).rejects.toThrow(/redis/);
    expect(pc.projectUpdate).not.toHaveBeenCalled();
  });

  it('refuses to submit a config that would still recreate an out-of-scope process', async () => {
    const { svc, pc } = scopedService();
    vi.spyOn(
      svc as unknown as { pinOutOfScope(cfgPath: string): Promise<{ path: string; namespaces: Map<string, string> }> },
      'pinOutOfScope',
    ).mockImplementation(async (cfgPath: string) => ({
      path: cfgPath,
      namespaces: new Map([
        ['hub-api', 'hub'],
        ['redis', 'datastore'],
        ['lab', 'control'],
      ]),
    }));

    await expect(svc.applyOverlay(writeCfg(), applyScopeNamespaces('hub'))).rejects.toThrow(/redis/);
    expect(pc.projectUpdate).not.toHaveBeenCalled();
  });
});

describe('featuresFromEnv', () => {
  it('derives no badge from LOCAL_SIMULATION_ENABLED', () => {
    const env = new Map([
      ['LOCAL_SIMULATION_ENABLED', 'true'],
      ['TFTP_ENABLED', 'true'],
    ]);

    expect(featuresFromEnv(env)).toEqual(['TFTP']);
  });
});
