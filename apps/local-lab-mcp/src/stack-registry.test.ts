import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultRegistryDir,
  findEntryByCheckout,
  findEntryBySlot,
  hostStackCandidates,
  isSameRepoCheckout,
  labBaseUrlForCheckout,
  labPortOf,
  pidAlive,
  readStackRegistry,
  repoRootOfCwd,
} from './stack-registry.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function fixtureDir(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'lab-mcp-registry-'));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}

function stackEntry(slot: number, checkout: string, labPort: number) {
  return {
    slot,
    checkout,
    pcSock: `/tmp/pc-${slot}.sock`,
    pcDaemonPid: 4242,
    state: 'up',
    ports: { lab: labPort, labWeb: labPort + 3173 },
  };
}

describe('readStackRegistry', () => {
  it('returns the entries sorted by slot', () => {
    const dir = fixtureDir({
      'stack-2.json': stackEntry(2, '/checkouts/two', 21002),
      'stack-0.json': stackEntry(0, '/checkouts/zero', 3002),
    });
    expect(readStackRegistry(dir).map((e) => e.slot)).toEqual([0, 2]);
    expect(readStackRegistry(dir).map((e) => e.checkout)).toEqual(['/checkouts/zero', '/checkouts/two']);
  });

  it('returns an empty list when the registry directory does not exist', () => {
    expect(readStackRegistry(join(tmpdir(), 'lab-mcp-registry-absent-9e1f'))).toEqual([]);
  });

  it('ignores files that are not slot entries', () => {
    const dir = fixtureDir({
      'stack-1.json': stackEntry(1, '/checkouts/one', 20502),
      'stack-x.json': stackEntry(1, '/checkouts/bogus', 1),
      'stacks.json': stackEntry(2, '/checkouts/bogus', 2),
      'notes.txt': 'not json',
    });
    expect(readStackRegistry(dir).map((e) => e.checkout)).toEqual(['/checkouts/one']);
  });

  it('skips an unparseable entry and reports it instead of throwing', () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const dir = fixtureDir({
      'stack-0.json': '{ not json',
      'stack-1.json': { slot: 'one', checkout: '/checkouts/one' },
      'stack-2.json': stackEntry(2, '/checkouts/two', 21002),
    });
    expect(readStackRegistry(dir).map((e) => e.slot)).toEqual([2]);
    expect(stderr).toHaveBeenCalledTimes(2);
  });

  it('keeps unknown entry fields', () => {
    const dir = fixtureDir({ 'stack-0.json': { ...stackEntry(0, '/checkouts/zero', 3002), branch: 'master' } });
    expect(readStackRegistry(dir)[0]?.branch).toBe('master');
  });
});

describe('labBaseUrlForCheckout', () => {
  it('returns the lab port recorded by the entry owning the checkout', () => {
    const dir = fixtureDir({
      'stack-0.json': stackEntry(0, '/checkouts/zero', 3002),
      'stack-3.json': stackEntry(3, '/checkouts/three', 21502),
    });
    expect(labBaseUrlForCheckout('/checkouts/three', dir)).toBe('http://127.0.0.1:21502');
    expect(labBaseUrlForCheckout('/checkouts/zero', dir)).toBe('http://127.0.0.1:3002');
  });

  it('returns null for a checkout no entry owns', () => {
    const dir = fixtureDir({ 'stack-0.json': stackEntry(0, '/checkouts/zero', 3002) });
    expect(labBaseUrlForCheckout('/checkouts/other', dir)).toBeNull();
  });

  it('returns null when the owning entry records no lab port', () => {
    const dir = fixtureDir({ 'stack-0.json': { slot: 0, checkout: '/checkouts/zero', ports: { labWeb: 5175 } } });
    expect(labBaseUrlForCheckout('/checkouts/zero', dir)).toBeNull();
  });

  it('returns null when the registry directory does not exist', () => {
    expect(labBaseUrlForCheckout('/checkouts/zero', join(tmpdir(), 'lab-mcp-registry-absent-9e1f'))).toBeNull();
  });
});

describe('findEntryBySlot', () => {
  it('returns the entry for that slot and null for an unclaimed one', () => {
    const dir = fixtureDir({
      'stack-0.json': stackEntry(0, '/checkouts/zero', 3002),
      'stack-3.json': stackEntry(3, '/checkouts/three', 21502),
    });
    expect(findEntryBySlot(3, dir)?.checkout).toBe('/checkouts/three');
    expect(findEntryBySlot(41, dir)).toBeNull();
  });
});

describe('findEntryByCheckout', () => {
  it('matches the checkout exactly and returns null otherwise', () => {
    const dir = fixtureDir({ 'stack-0.json': stackEntry(0, '/checkouts/zero', 3002) });
    expect(findEntryByCheckout('/checkouts/zero', dir)?.slot).toBe(0);
    expect(findEntryByCheckout('/checkouts/zero/', dir)).toBeNull();
  });
});

describe('labPortOf', () => {
  it('reads ports.lab and returns null when it is absent or not numeric', () => {
    expect(labPortOf({ slot: 0, checkout: '/c', ports: { lab: 3002 } })).toBe(3002);
    expect(labPortOf({ slot: 0, checkout: '/c', ports: {} })).toBeNull();
    expect(labPortOf({ slot: 0, checkout: '/c' })).toBeNull();
  });
});

describe('pidAlive', () => {
  it('treats this process as alive and an unclaimed pid as dead', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(undefined)).toBe(false);
  });

  it('treats pid 0 as alive, because that is the pre-supervisor window', () => {
    expect(pidAlive(0)).toBe(true);
  });

  it('treats a pid no process holds as dead', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    });
    expect(pidAlive(999_999)).toBe(false);
    expect(kill).toHaveBeenCalledWith(999_999, 0);
  });

  it('treats EPERM as alive, since the pid exists under another uid', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });
    expect(pidAlive(999_999)).toBe(true);
  });
});

describe('isSameRepoCheckout', () => {
  it('accepts the repository root and anything under it', () => {
    expect(isSameRepoCheckout('/repo', '/repo')).toBe(true);
    expect(isSameRepoCheckout('/repo/.worktrees/feature', '/repo')).toBe(true);
  });

  it('rejects an unrelated clone and a path that only shares a prefix', () => {
    expect(isSameRepoCheckout('/elsewhere/repo', '/repo')).toBe(false);
    expect(isSameRepoCheckout('/repository', '/repo')).toBe(false);
  });

  it('rejects everything when the repository root is unknown', () => {
    expect(isSameRepoCheckout('/repo', null)).toBe(false);
  });
});

describe('repoRootOfCwd', () => {
  it('is the checkout that owns the git directory shared by every worktree', () => {
    const root = repoRootOfCwd();
    expect(root).not.toBeNull();
    expect(isSameRepoCheckout(process.cwd(), root)).toBe(true);
  });
});

describe('hostStackCandidates', () => {
  it('reports the slot, lab port, liveness and repository relation of each entry', () => {
    const dir = fixtureDir({
      'stack-0.json': { ...stackEntry(0, '/repo/.worktrees/feature', 3002), pcDaemonPid: process.pid },
      'stack-2.json': { ...stackEntry(2, '/elsewhere/clone', 21002), pcDaemonPid: 0, state: 'down' },
    });
    expect(hostStackCandidates(dir, '/repo')).toEqual([
      { slot: 0, checkout: '/repo/.worktrees/feature', labPort: 3002, live: true, state: 'up', sameRepo: true },
      { slot: 2, checkout: '/elsewhere/clone', labPort: 21002, live: true, state: 'down', sameRepo: false },
    ]);
  });

  it('reports a missing lab port as null rather than dropping the entry', () => {
    const dir = fixtureDir({ 'stack-1.json': { slot: 1, checkout: '/repo', ports: {} } });
    expect(hostStackCandidates(dir, '/repo')).toEqual([
      { slot: 1, checkout: '/repo', labPort: null, live: false, state: null, sameRepo: true },
    ]);
  });

  it('returns an empty list when nothing is registered', () => {
    expect(hostStackCandidates(fixtureDir({}), '/repo')).toEqual([]);
  });
});

describe('defaultRegistryDir', () => {
  it('honours XDG_STATE_HOME', () => {
    vi.stubEnv('XDG_STATE_HOME', '/xdg/state');
    expect(defaultRegistryDir()).toBe('/xdg/state/brokkr-local/stacks');
  });

  it('falls back to the home-relative state directory', () => {
    vi.stubEnv('XDG_STATE_HOME', undefined);
    expect(defaultRegistryDir().endsWith('/.local/state/brokkr-local/stacks')).toBe(true);
  });
});
