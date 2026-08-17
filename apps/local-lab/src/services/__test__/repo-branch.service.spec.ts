import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RepoBranchService } from '../repo-branch.service';

const ccBuildInfoMock = vi.hoisted(() => vi.fn());
const invalidateCcBuildHeadMock = vi.hoisted(() => vi.fn());
vi.mock('../../common/build-info', () => ({
  ccBuildInfo: ccBuildInfoMock,
  invalidateCcBuildHead: invalidateCcBuildHeadMock,
}));

const h = vi.hoisted(
  (): {
    calls: string[][];
    head: string;
    localExists: boolean;
    originExists: boolean;
    revParseError: string | null;
  } => ({
    calls: [],
    head: 'main',
    localExists: true,
    originExists: false,
    revParseError: null,
  }),
);

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: () => true };
});

vi.mock('node:child_process', () => {
  const custom = Symbol.for('nodejs.util.promisify.custom');
  const execFile = () => undefined;
  Object.defineProperty(execFile, custom, {
    value: async (_cmd: string, args: string[]) => {
      h.calls.push(args);
      if (args.includes('rev-parse')) {
        if (h.revParseError !== null) throw { stderr: h.revParseError };
        return { stdout: `${h.head}\n`, stderr: '' };
      }
      if (args.includes('show-ref')) {
        const ref = args[args.length - 1];
        const ok = ref.startsWith('refs/heads/') ? h.localExists : h.originExists;
        if (ok) return { stdout: '', stderr: '' };
        throw new Error('no such ref');
      }
      return { stdout: '', stderr: '' };
    },
  });
  return { execFile };
});

function makeService(override: string | undefined) {
  return new RepoBranchService({ hubRepoPathOverride: () => override });
}

beforeEach(() => {
  h.calls.length = 0;
  h.head = 'main';
  h.localExists = true;
  h.originExists = false;
  h.revParseError = null;
  delete process.env.HUB_REPO_PATH;
  ccBuildInfoMock.mockReset();
  invalidateCcBuildHeadMock.mockReset();
  ccBuildInfoMock.mockResolvedValue({ sha: 'aaa', builtAt: 1, headSha: 'aaa', stale: false });
});

describe('RepoBranchService.branch', () => {
  it('reports the current branch on the happy path', async () => {
    const svc = makeService('/repo');
    expect(await svc.branch()).toEqual({ branch: 'main', error: null });
  });

  it('reports detached HEAD', async () => {
    h.head = 'HEAD';
    const svc = makeService('/repo');
    expect(await svc.branch()).toEqual({ branch: null, error: 'detached HEAD' });
  });

  it('surfaces the trimmed rev-parse stderr on failure', async () => {
    h.revParseError = '  fatal: not a git repository  ';
    const svc = makeService('/repo');
    expect(await svc.branch()).toEqual({ branch: null, error: 'fatal: not a git repository' });
  });
});

describe('RepoBranchService.checkout branch-name validation', () => {
  const rejected = ['-foo', 'a..b', 'a b', 'x.lock', 'foo/', '@{u}', 'back\\slash', ''];

  for (const name of rejected) {
    it(`rejects ${JSON.stringify(name)} without invoking git`, async () => {
      const svc = makeService(undefined);
      const result = await svc.checkout(name);
      expect(result.error).toMatch(/^invalid branch name/);
      expect(h.calls).toHaveLength(0);
    });
  }

  const accepted = ['feature/foo-1', 'release-1.2', 'fix/a.b'];

  for (const name of accepted) {
    it(`accepts ${JSON.stringify(name)}`, async () => {
      const svc = makeService(undefined);
      const result = await svc.checkout(name);
      expect(result.error).not.toMatch(/invalid branch name/);
    });
  }
});

describe('RepoBranchService.checkout git invocation shape', () => {
  it('appends -- to a local-branch checkout', async () => {
    h.localExists = true;
    const svc = makeService('/repo');
    await svc.checkout('feature/foo-1');
    const call = h.calls.find((a) => a.includes('checkout'));
    expect(call?.slice(-3)).toEqual(['checkout', 'feature/foo-1', '--']);
  });

  it('appends -- when creating from origin', async () => {
    h.localExists = false;
    h.originExists = true;
    const svc = makeService('/repo');
    await svc.checkout('feature/foo-1');
    const call = h.calls.find((a) => a.includes('checkout'));
    expect(call?.slice(-5)).toEqual(['checkout', '-b', 'feature/foo-1', 'origin/feature/foo-1', '--']);
  });

  it('appends -- when creating from HEAD', async () => {
    h.localExists = false;
    h.originExists = false;
    const svc = makeService('/repo');
    await svc.checkout('feature/foo-1');
    const call = h.calls.find((a) => a.includes('checkout'));
    expect(call?.slice(-4)).toEqual(['checkout', '-b', 'feature/foo-1', '--']);
  });
});

describe('RepoBranchService.checkout target', () => {
  it('checks out the requested target', async () => {
    const svc = makeService('/repo');
    await svc.checkout('topic-a');
    const call = h.calls.find((a) => a.includes('checkout'));
    expect(call).toContain('topic-a');
  });

  it('is a no-op when the target is already checked out', async () => {
    h.head = 'topic-a';
    const svc = makeService('/repo');
    const result = await svc.checkout('topic-a');
    expect(result).toEqual({ branch: 'topic-a', error: null, ccRebuildRequired: false });
    expect(h.calls.find((a) => a.includes('checkout'))).toBeUndefined();
  });
});

describe('RepoBranchService.checkout ccRebuildRequired', () => {
  it('flags ccRebuildRequired when the checkout moved HEAD past the running build', async () => {
    ccBuildInfoMock.mockResolvedValue({ sha: 'aaa', builtAt: 1, headSha: 'bbb', stale: true });
    const service = makeService('/repo');
    const result = await service.checkout('topic-a');
    expect(result.ccRebuildRequired).toBe(true);
  });

  it('reports ccRebuildRequired false when the build still matches the checkout', async () => {
    ccBuildInfoMock.mockResolvedValue({ sha: 'aaa', builtAt: 1, headSha: 'aaa', stale: false });
    const service = makeService('/repo');
    const result = await service.checkout('topic-a');
    expect(result.ccRebuildRequired).toBe(false);
  });

  it('attaches ccRebuildRequired even when the checkout fails', async () => {
    ccBuildInfoMock.mockResolvedValue({ sha: 'aaa', builtAt: 1, headSha: 'aaa', stale: false });
    const service = makeService('/repo');
    const result = await service.checkout('-bad');
    expect(result.error).toContain('invalid branch name');
    expect(result.ccRebuildRequired).toBe(false);
  });

  it('invalidates the cached head before consulting ccBuildInfo', async () => {
    const service = makeService('/repo');
    await service.checkout('topic-a');
    const invalidateOrder = invalidateCcBuildHeadMock.mock.invocationCallOrder[0];
    const buildInfoOrder = ccBuildInfoMock.mock.invocationCallOrder[0];
    expect(invalidateOrder).toBeLessThan(buildInfoOrder);
  });
});
