import { beforeEach, describe, expect, it, vi } from 'vitest';

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../../../exec', () => ({ run }));

import { checkCcMode } from '.././ccMode';

type RunResult = { stdout: string; stderr: string; exit_code: number };
const ok = (stdout = '', stderr = ''): RunResult => ({ stdout, stderr, exit_code: 0 });

function isPipShow(args: string[]): boolean {
  return args.includes('show');
}
function isPipInstall(args: string[]): boolean {
  return args.includes('install');
}
function isProbe(args: string[]): boolean {
  return args.includes('-c');
}

beforeEach(() => {
  run.mockReset();
});

describe('checkCcMode', () => {
  it('installs against the same interpreter as the probe (python3 -m pip)', async () => {
    run.mockImplementation((_cmd: string, args: string[]) => {
      if (isPipShow(args)) return Promise.resolve({ stdout: '', stderr: '', exit_code: 1 });
      if (isPipInstall(args)) return Promise.resolve(ok());
      if (isProbe(args)) return Promise.resolve(ok('CC_DISABLED'));
      return Promise.resolve(ok());
    });

    await checkCcMode();

    const installCall = run.mock.calls.find(([, args]) => isPipInstall(args));
    expect(installCall?.[0]).toBe('python3');
    expect(installCall?.[1]).toEqual(['-m', 'pip', 'install', '--break-system-packages', 'brokkr-diagnostics==0.6.1']);
  });

  it('skips the probe and returns an actionable error when install fails', async () => {
    run.mockImplementation((_cmd: string, args: string[]) => {
      if (isPipShow(args)) return Promise.resolve({ stdout: '', stderr: '', exit_code: 1 });
      if (isPipInstall(args)) return Promise.resolve({ stdout: '', stderr: 'no network', exit_code: 1 });
      return Promise.resolve(ok());
    });

    const result = await checkCcMode();

    expect(result.cc_enabled).toBe(false);
    expect(result.cc_check_error).toContain('brokkr-diagnostics unavailable');
    expect(result.cc_check_error).toContain('no network');
    expect(run.mock.calls.some(([, args]) => isProbe(args))).toBe(false);
  });

  it('reports cc enabled when the probe prints CC_ENABLED', async () => {
    run.mockImplementation((_cmd: string, args: string[]) => {
      if (isPipShow(args)) return Promise.resolve(ok('Name: brokkr-diagnostics'));
      if (isProbe(args)) return Promise.resolve(ok('CC_ENABLED'));
      return Promise.resolve(ok());
    });

    const result = await checkCcMode();

    expect(result).toEqual({ cc_enabled: true, skip_benchmarks: true });
    expect(run.mock.calls.some(([, args]) => isPipInstall(args))).toBe(false);
  });

  it('reports cc disabled when the probe prints CC_DISABLED', async () => {
    run.mockImplementation((_cmd: string, args: string[]) => {
      if (isPipShow(args)) return Promise.resolve(ok('Name: brokkr-diagnostics'));
      if (isProbe(args)) return Promise.resolve(ok('CC_DISABLED'));
      return Promise.resolve(ok());
    });

    const result = await checkCcMode();

    expect(result).toEqual({ cc_enabled: false });
  });
});
