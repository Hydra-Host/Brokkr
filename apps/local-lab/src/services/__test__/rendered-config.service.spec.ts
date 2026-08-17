import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { ProcessComposeClient } from '../process-compose.client';
import { RenderedConfigService } from '../rendered-config.service';

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
