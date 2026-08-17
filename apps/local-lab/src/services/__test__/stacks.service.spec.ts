import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { STACK_SLOT } from '../../ports';
import { StackRegistryClient } from '../stack-registry-client';
import { NOT_LIVE, StacksService, type StackProbe } from '../stacks.service';

const DEAD_PID = 4_000_000;

const createdDirs: string[] = [];
function newTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stacks-service-'));
  createdDirs.push(dir);
  return dir;
}

function registryDir(root: string): string {
  const dir = join(root, 'brokkr-local', 'stacks');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeEntry(dir: string, slot: number, entry: Record<string, unknown>): void {
  writeFileSync(join(dir, `stack-${slot}.json`), JSON.stringify({ slot, ...entry }));
}

const liveProbe =
  (running: number, total: number): StackProbe =>
  async () => ({ live: true, running, total });

afterEach(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
  createdDirs.length = 0;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('StacksService', () => {
  it('returns an empty list when the registry dir does not exist yet', async () => {
    const svc = new StacksService(new StackRegistryClient(join(newTmpDir(), 'brokkr-local', 'stacks')), liveProbe(0, 0));
    await expect(svc.listStacks()).resolves.toEqual({ stacks: [], selfSlot: STACK_SLOT });
  });

  it('reports the slot this stack itself owns as selfSlot', async () => {
    vi.stubEnv('STACK_SLOT', '3');
    vi.resetModules();
    const { StacksService: Reloaded } = await import('../stacks.service');
    const svc = new Reloaded(new StackRegistryClient(join(newTmpDir(), 'brokkr-local', 'stacks')), liveProbe(0, 0));
    await expect(svc.listStacks()).resolves.toEqual({ stacks: [], selfSlot: 3 });
  });

  it('marks entries with dead sockets as not live', async () => {
    const dir = registryDir(newTmpDir());
    writeEntry(dir, 0, { checkout: newTmpDir(), state: 'up' });
    const svc = new StacksService(new StackRegistryClient(dir), async () => NOT_LIVE);
    const [s] = (await svc.listStacks()).stacks;
    expect(s.live).toBe(false);
    expect(s.processes).toEqual({ running: 0, total: 0 });
  });

  it('derives urls from the entry ports and the rollup from the probe', async () => {
    const dir = registryDir(newTmpDir());
    const checkout = newTmpDir();
    writeEntry(dir, 2, {
      checkout,
      state: 'up',
      pcDaemonPid: 0,
      ports: { lab: 21002, labWeb: 21005, hubApi: { base: 21100, step: 2 }, hubWeb: 21003 },
    });
    const svc = new StacksService(new StackRegistryClient(dir), liveProbe(12, 14));
    const [s] = (await svc.listStacks()).stacks;
    expect(s).toEqual({
      slot: 2,
      checkout,
      state: 'up',
      live: true,
      hubUrl: 'http://localhost:21100',
      webUrl: 'http://localhost:21003',
      labUrl: 'http://localhost:21002',
      labWebUrl: 'http://localhost:21005',
      processes: { running: 12, total: 14 },
      healthLine: null,
    });
  });

  it('derives the health line from the sibling lab status snapshot', async () => {
    const dir = registryDir(newTmpDir());
    writeEntry(dir, 3, {
      checkout: newTmpDir(),
      state: 'up',
      pcDaemonPid: 0,
      ports: { lab: 21002, labWeb: 21005, hubApi: { base: 21100, step: 2 }, hubWeb: 21003 },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ datastores: { postgres: true, redis: true }, fleetSummary: { on: 1, total: 1 } }),
      })),
    );
    const svc = new StacksService(new StackRegistryClient(dir), liveProbe(11, 11));
    const [s] = (await svc.listStacks()).stacks;
    expect(s.healthLine).toBe('pg up · redis up · fleet 1/1 on');
  });

  it('leaves the health line null when the sibling lab does not answer', async () => {
    const dir = registryDir(newTmpDir());
    writeEntry(dir, 4, {
      checkout: newTmpDir(),
      state: 'up',
      pcDaemonPid: 0,
      ports: { lab: 21002, labWeb: 21005, hubApi: { base: 21100, step: 2 }, hubWeb: 21003 },
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    const svc = new StacksService(new StackRegistryClient(dir), liveProbe(3, 5));
    const [s] = (await svc.listStacks()).stacks;
    expect(s.healthLine).toBeNull();
  });

  it('probes the sibling status endpoint with a deadline past its slow tail', async () => {
    const dir = registryDir(newTmpDir());
    writeEntry(dir, 5, {
      checkout: newTmpDir(),
      state: 'up',
      pcDaemonPid: 0,
      ports: { lab: 21002, labWeb: 21005, hubApi: { base: 21100, step: 2 }, hubWeb: 21003 },
    });
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    await new StacksService(new StackRegistryClient(dir), liveProbe(3, 5)).listStacks();
    expect(timeout).toHaveBeenCalledWith(5_000);
  });

  it('serves the cached health line to the next poll instead of refetching', async () => {
    const dir = registryDir(newTmpDir());
    writeEntry(dir, 6, {
      checkout: newTmpDir(),
      state: 'up',
      pcDaemonPid: 0,
      ports: { lab: 21002, labWeb: 21005, hubApi: { base: 21100, step: 2 }, hubWeb: 21003 },
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ datastores: { postgres: true, redis: true } }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const svc = new StacksService(new StackRegistryClient(dir), liveProbe(11, 11));
    await svc.listStacks();
    const [s] = (await svc.listStacks()).stacks;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(s.healthLine).toBe('pg up · redis up');
  });

  it('reports null urls until the entry carries denormalized ports', async () => {
    const dir = registryDir(newTmpDir());
    writeEntry(dir, 1, { checkout: newTmpDir(), state: 'up', ports: {} });
    const svc = new StacksService(new StackRegistryClient(dir), liveProbe(1, 1));
    const [s] = (await svc.listStacks()).stacks;
    expect(s.hubUrl).toBeNull();
    expect(s.webUrl).toBeNull();
    expect(s.labUrl).toBeNull();
    expect(s.labWebUrl).toBeNull();
  });

  it('does not probe an entry whose checkout is gone', async () => {
    const dir = registryDir(newTmpDir());
    writeEntry(dir, 3, { checkout: join(newTmpDir(), 'deleted'), state: 'up', pcDaemonPid: DEAD_PID });
    let probed = 0;
    const svc = new StacksService(new StackRegistryClient(dir), async () => {
      probed += 1;
      return { live: true, running: 1, total: 1 };
    });
    const [s] = (await svc.listStacks()).stacks;
    expect(probed).toBe(0);
    expect(s.live).toBe(false);
  });

  it("defaults a missing state to 'unknown'", async () => {
    const dir = registryDir(newTmpDir());
    writeEntry(dir, 4, { checkout: newTmpDir() });
    const svc = new StacksService(new StackRegistryClient(dir), async () => NOT_LIVE);
    const [s] = (await svc.listStacks()).stacks;
    expect(s.state).toBe('unknown');
  });
});
