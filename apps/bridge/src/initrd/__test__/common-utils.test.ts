import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CommonInitrdUtils, InitrdBuildError } from '../common-utils.js';
import type { RunResult } from '../exec.js';
import { CommandTimeout } from '../exec.js';
import { resetInitrdConfigForTests } from '../initrd.config.js';

interface ExecCall {
  cmd: string;
  args: readonly string[];
  opts: { timeoutMs?: number };
}

function fakeExec(calls: ExecCall[], result: Partial<RunResult> = {}, error?: Error) {
  return (cmd: string, args: readonly string[], opts: { timeoutMs?: number }): Promise<RunResult> => {
    calls.push({ cmd, args, opts });
    if (error) return Promise.reject(error);
    return Promise.resolve({ stdout: '', stderr: '', exitCode: 0, durationMs: 1, ...result });
  };
}

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ['BROKKR_ENV', 'HH_ENV', 'ENVIRONMENT', 'LOCAL_SIMULATION_ENABLED']) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  resetInitrdConfigForTests();
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetInitrdConfigForTests();
});

describe('executeInitrdBuild argv assembly', () => {
  it('runs the cpio pipeline through /bin/sh -c with a 5 minute timeout', async () => {
    const calls: ExecCall[] = [];
    const utils = new CommonInitrdUtils('job-1', fakeExec(calls));

    await utils.executeInitrdBuild(
      '/tmp/work/inventory_initrd',
      '/brokkr/initrd-builds/brokkr-discovery-dev.img',
      'brokkr-discovery',
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe('/bin/sh');
    expect(calls[0]?.args).toEqual([
      '-c',
      'cd /tmp/work/inventory_initrd && find . | sort | cpio --quiet -o -H newc > /brokkr/initrd-builds/brokkr-discovery-dev.img',
    ]);
    expect(calls[0]?.opts.timeoutMs).toBe(300_000);
  });

  it('appends -R 0:0 in local simulation mode', async () => {
    process.env.LOCAL_SIMULATION_ENABLED = 'true';
    const calls: ExecCall[] = [];
    const utils = new CommonInitrdUtils('job-1', fakeExec(calls));

    await utils.executeInitrdBuild('/tmp/d', '/out/i.img');

    expect(calls[0]?.args[1]).toBe('cd /tmp/d && find . | sort | cpio --quiet -o -H newc -R 0:0 > /out/i.img');
  });

  it('raises InitrdBuildError on non-zero exit', async () => {
    const calls: ExecCall[] = [];
    const utils = new CommonInitrdUtils('job-1', fakeExec(calls, { exitCode: 1, stderr: 'cpio: boom' }));

    await expect(utils.executeInitrdBuild('/tmp/d', '/out/i.img', 'ubuntu-rescue-os')).rejects.toThrowError(
      'Failed to build ubuntu-rescue-os initrd image',
    );
  });

  it('maps a command timeout to a titled InitrdBuildError', async () => {
    const calls: ExecCall[] = [];
    const utils = new CommonInitrdUtils('job-1', fakeExec(calls, {}, new CommandTimeout('cpio', 300_000)));

    await expect(utils.executeInitrdBuild('/tmp/d', '/out/i.img', 'brokkr-discovery')).rejects.toThrowError(
      'Brokkr-Discovery initrd build timed out',
    );
    await expect(utils.executeInitrdBuild('/tmp/d', '/out/i.img', 'brokkr-discovery')).rejects.toThrowError(
      InitrdBuildError,
    );
  });
});

describe('parseSshKeys', () => {
  const utils = new CommonInitrdUtils('job-1');

  it('keeps valid keys and drops malformed lines', () => {
    const keys = utils.parseSshKeys(
      [
        'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIwJ admin@bridge',
        '',
        'not-a-key blah',
        'ssh-rsa AAAAB3NzaC1yc2E= legacy',
        'ssh-ed25519 not!base64!',
        'ssh-ed25519',
      ].join('\n'),
    );
    expect(keys).toEqual(['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIwJ admin@bridge', 'ssh-rsa AAAAB3NzaC1yc2E= legacy']);
  });

  it('normalizes tabs and carriage returns', () => {
    expect(utils.parseSshKeys('ssh-ed25519\tAAAA\tuser\r\n')).toEqual(['ssh-ed25519 AAAA user']);
  });

  it('returns empty for empty input', () => {
    expect(utils.parseSshKeys('')).toEqual([]);
  });
});
