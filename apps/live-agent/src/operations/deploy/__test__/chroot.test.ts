import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../exec', () => ({
  run: vi.fn(),
}));

import { clearOperationsForTests, getHandler } from '../../../dispatch/registry';
import { run } from '../../../exec';
import { registerChrootOps } from '.././chroot';

const runMock = vi.mocked(run);

const ctx = {} as never;

const ok = { exit_code: 0, stdout: '', stderr: '', duration_ms: 0 };
const fail = (stderr = ''): { exit_code: number; stdout: string; stderr: string; duration_ms: number } => ({
  exit_code: 1,
  stdout: '',
  stderr,
  duration_ms: 0,
});

function mountUmountCalls(): Array<[string, readonly string[]]> {
  return runMock.mock.calls
    .filter(([cmd]) => cmd === 'mount' || cmd === 'umount')
    .map(([cmd, args]) => [cmd as string, (args ?? []) as readonly string[]]);
}

function mockAllSucceedExceptMountpoint(): void {
  runMock.mockImplementation(async (cmd, _args) => {
    if (cmd === 'mountpoint') return fail();
    return ok;
  });
}

beforeEach(() => {
  runMock.mockReset();
  clearOperationsForTests();
  registerChrootOps();
});

describe('deploy.mountChroot', () => {
  it('mounts all six points in the expected order + make-private each', async () => {
    mockAllSucceedExceptMountpoint();
    const handler = getHandler('deploy.mountChroot')!.handler;

    const result = await handler({ target_path: '/target' }, ctx);

    expect(result).toEqual({
      mounted_points: [
        '/target/dev',
        '/target/proc',
        '/target/sys',
        '/target/run',
        '/target/dev/pts',
        '/target/sys/firmware/efi/efivars',
      ],
    });

    const calls = mountUmountCalls();
    expect(calls.filter(([c]) => c === 'mount')).toHaveLength(12);
    expect(calls.filter(([c]) => c === 'umount')).toHaveLength(0);

    expect(calls[0]).toEqual(['mount', ['--bind', '/dev', '/target/dev']]);
    expect(calls[1]).toEqual(['mount', ['--make-private', '/target/dev']]);
    expect(calls[2]).toEqual(['mount', ['-t', 'proc', 'proc', '/target/proc']]);
    expect(calls[3]).toEqual(['mount', ['--make-private', '/target/proc']]);
    expect(calls[4]).toEqual(['mount', ['-t', 'sysfs', 'sys', '/target/sys']]);
    expect(calls[5]).toEqual(['mount', ['--make-private', '/target/sys']]);
  });

  it('creates each target directory before mounting', async () => {
    mockAllSucceedExceptMountpoint();
    const handler = getHandler('deploy.mountChroot')!.handler;

    await handler({ target_path: '/target' }, ctx);

    const mkdirCalls = runMock.mock.calls.filter(([c]) => c === 'mkdir');
    expect(mkdirCalls).toHaveLength(6);
    expect(mkdirCalls[0]![1]).toEqual(['-p', '/target/dev']);
    expect(mkdirCalls[5]![1]).toEqual(['-p', '/target/sys/firmware/efi/efivars']);
  });

  it('skips already-mounted points (idempotent)', async () => {
    runMock.mockImplementation(async (cmd, args) => {
      if (cmd === 'mountpoint') {
        const path = (args ?? [])[1];
        return path === '/target/dev' ? ok : fail();
      }
      return ok;
    });
    const handler = getHandler('deploy.mountChroot')!.handler;

    const result = await handler({ target_path: '/target' }, ctx);

    expect(result).toEqual({
      mounted_points: [
        '/target/dev',
        '/target/proc',
        '/target/sys',
        '/target/run',
        '/target/dev/pts',
        '/target/sys/firmware/efi/efivars',
      ],
    });
    const bindDev = runMock.mock.calls.find(
      ([c, a]) => c === 'mount' && (a ?? []).includes('--bind') && (a ?? []).includes('/dev'),
    );
    expect(bindDev).toBeUndefined();
    const privateDev = runMock.mock.calls.find(
      ([c, a]) => c === 'mount' && (a ?? [])[0] === '--make-private' && (a ?? [])[1] === '/target/dev',
    );
    expect(privateDev).toBeUndefined();
  });

  it('rolls back (unmounts in reverse) when a mid-sequence mount fails', async () => {
    const mounted = new Set<string>();
    let mountCount = 0;
    runMock.mockImplementation(async (cmd, args) => {
      if (cmd === 'mountpoint') {
        const path = (args ?? [])[1] ?? '';
        return mounted.has(path) ? ok : fail();
      }
      if (cmd === 'mkdir') return ok;
      if (cmd === 'umount') {
        const path = (args ?? [])[0] ?? '';
        mounted.delete(path);
        return ok;
      }
      if (cmd === 'mount') {
        const isPrivate = (args ?? [])[0] === '--make-private';
        if (isPrivate) return ok;
        mountCount += 1;
        if (mountCount === 3) return fail('mock-failure');
        const target = (args ?? [])[(args ?? []).length - 1] ?? '';
        mounted.add(target);
        return ok;
      }
      return ok;
    });
    const handler = getHandler('deploy.mountChroot')!.handler;

    await expect(handler({ target_path: '/target' }, ctx)).rejects.toThrow(/mount .* failed/);

    const umountCalls = runMock.mock.calls.filter(([c]) => c === 'umount').map(([, a]) => (a ?? [])[0]);
    expect(umountCalls).toEqual(['/target/proc', '/target/dev']);
  });

  it('rolls back including the just-bound path when make-private fails', async () => {
    const mounted = new Set<string>();
    let privateCount = 0;
    runMock.mockImplementation(async (cmd, args) => {
      if (cmd === 'mountpoint') {
        const path = (args ?? [])[1] ?? '';
        return mounted.has(path) ? ok : fail();
      }
      if (cmd === 'mkdir') return ok;
      if (cmd === 'umount') {
        const path = (args ?? [])[0] ?? '';
        mounted.delete(path);
        return ok;
      }
      if (cmd === 'mount') {
        const isPrivate = (args ?? [])[0] === '--make-private';
        if (isPrivate) {
          privateCount += 1;
          if (privateCount === 2) return fail('private-fail');
          return ok;
        }
        const target = (args ?? [])[(args ?? []).length - 1] ?? '';
        mounted.add(target);
        return ok;
      }
      return ok;
    });
    const handler = getHandler('deploy.mountChroot')!.handler;

    await expect(handler({ target_path: '/target' }, ctx)).rejects.toThrow(/make-private/);

    const umountCalls = runMock.mock.calls.filter(([c]) => c === 'umount').map(([, a]) => (a ?? [])[0]);
    expect(umountCalls).toEqual(['/target/proc', '/target/dev']);
  });
});

describe('deploy.unmountChroot', () => {
  it("unmounts in reverse order; skips paths that aren't mounted", async () => {
    const mountedPaths = new Set(['/target/dev', '/target/sys']);
    runMock.mockImplementation(async (cmd, args) => {
      if (cmd === 'mountpoint') {
        const path = (args ?? [])[1] ?? '';
        return mountedPaths.has(path) ? ok : fail();
      }
      if (cmd === 'umount') {
        const path = (args ?? [])[0] ?? '';
        mountedPaths.delete(path);
        return ok;
      }
      return ok;
    });
    const handler = getHandler('deploy.unmountChroot')!.handler;

    const result = await handler({ target_path: '/target' }, ctx);

    expect(result).toEqual({
      unmounted: ['/target/sys', '/target/dev'],
    });
  });

  it('best-effort: a failed umount does not stop the sequence', async () => {
    const mountedPaths = new Set(['/target/dev', '/target/proc', '/target/sys']);
    runMock.mockImplementation(async (cmd, args) => {
      if (cmd === 'mountpoint') {
        const path = (args ?? [])[1] ?? '';
        return mountedPaths.has(path) ? ok : fail();
      }
      if (cmd === 'umount') {
        const path = (args ?? [])[0] ?? '';
        if (path === '/target/sys') return fail('busy');
        mountedPaths.delete(path);
        return ok;
      }
      return ok;
    });
    const handler = getHandler('deploy.unmountChroot')!.handler;

    const result = await handler({ target_path: '/target' }, ctx);

    expect(result).toEqual({ unmounted: ['/target/proc', '/target/dev'] });
  });
});
