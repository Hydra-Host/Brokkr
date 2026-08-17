import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IPMIDevice } from '../../device.js';
import { createIpmiDevice } from '../../device.js';
import type { IPMIResult } from '../../result.js';
import { run } from '../../transport.js';
import { IPMIValidationError } from '../../validation.js';
import { mcGetenables, mcInfo, mcReset } from '../mc.js';

vi.mock('../../transport.js', () => ({
  run: vi.fn(),
}));

const mockedRun = vi.mocked(run);

function makeDevice(cipher: string | null = null): IPMIDevice {
  return createIpmiDevice({
    ip: '10.0.0.1',
    username: 'ADMIN',
    password: 's3cret',
    port: 623,
    cipher,
    jobId: 'job-xyz',
  });
}

function okResult(cipher: string | null = null): IPMIResult {
  return {
    ok: true,
    stdout: '',
    stderr: '',
    returncode: 0,
    command: [],
    cipherUsed: cipher,
    durationMs: 0,
    timedOut: false,
  };
}

beforeEach(() => {
  mockedRun.mockReset();
});

describe('mcReset', () => {
  it('emits the cold-reset argv shape and forwards device fields to transport.run', async () => {
    const captured: {
      command?: string[];
      password?: string;
      timeout?: number;
      cipherUsed?: string | null;
      jobId?: string;
    } = {};
    mockedRun.mockImplementation(async (cmd, pw, timeout, opts) => {
      captured.command = [...cmd];
      captured.password = pw;
      captured.timeout = timeout;
      captured.cipherUsed = opts?.cipherUsed ?? null;
      captured.jobId = opts?.jobId ?? '';
      return okResult();
    });

    const result = await mcReset(makeDevice(), 'cold');

    expect(result.ok).toBe(true);
    expect(captured.command?.slice(-3)).toEqual(['mc', 'reset', 'cold']);
    expect(captured.command).toContain('-H');
    expect(captured.command).toContain('10.0.0.1');
    expect(captured.command).toContain('lanplus');
    expect(captured.password).toBe('s3cret');
    expect(captured.timeout).toBe(30);
    expect(captured.jobId).toBe('job-xyz');
  });

  it('emits the warm-reset argv shape', async () => {
    let command: string[] = [];
    mockedRun.mockImplementation(async (cmd) => {
      command = [...cmd];
      return okResult();
    });

    await mcReset(makeDevice(), 'warm');

    expect(command.slice(-3)).toEqual(['mc', 'reset', 'warm']);
  });

  it('defaults to cold when mode is omitted', async () => {
    let command: string[] = [];
    mockedRun.mockImplementation(async (cmd) => {
      command = [...cmd];
      return okResult();
    });

    await mcReset(makeDevice());

    expect(command.slice(-3)).toEqual(['mc', 'reset', 'cold']);
  });

  it.each([['lukewarm'], [''], ['COLD'], ['hard'], ['0'], ['reset']])(
    'rejects invalid mode %p and never calls the transport',
    async (badMode) => {
      await expect(mcReset(makeDevice(), badMode)).rejects.toBeInstanceOf(IPMIValidationError);
      expect(mockedRun).not.toHaveBeenCalled();
    },
  );

  it('passes cipher through onto the result', async () => {
    mockedRun.mockImplementation(async (_cmd, _pw, _t, opts) => okResult(opts?.cipherUsed ?? null));
    const result = await mcReset(makeDevice('17'), 'cold');
    expect(result.cipherUsed).toBe('17');
  });

  it('includes the -C<cipher> flag in argv when device.cipher is set', async () => {
    let command: string[] = [];
    mockedRun.mockImplementation(async (cmd) => {
      command = [...cmd];
      return okResult();
    });

    await mcReset(makeDevice('17'), 'cold');

    expect(command).toContain('-C17');
  });

  it('propagates a custom timeout', async () => {
    let timeout = 0;
    mockedRun.mockImplementation(async (_cmd, _pw, t) => {
      timeout = t;
      return okResult();
    });

    await mcReset(makeDevice(), 'cold', { timeout: 90 });

    expect(timeout).toBe(90);
  });
});

describe('mcInfo', () => {
  it('emits the mc info argv with the default timeout', async () => {
    const captured: { command?: string[]; timeout?: number } = {};
    mockedRun.mockImplementation(async (cmd, _pw, t) => {
      captured.command = [...cmd];
      captured.timeout = t;
      return okResult();
    });

    await mcInfo(makeDevice());

    expect(captured.command?.slice(-2)).toEqual(['mc', 'info']);
    expect(captured.timeout).toBe(30);
  });

  it('passes cipher through onto the result', async () => {
    mockedRun.mockImplementation(async (_cmd, _pw, _t, opts) => okResult(opts?.cipherUsed ?? null));
    const result = await mcInfo(makeDevice('3'));
    expect(result.cipherUsed).toBe('3');
  });
});

describe('mcGetenables', () => {
  it('emits the mc getenables argv', async () => {
    let command: string[] = [];
    mockedRun.mockImplementation(async (cmd) => {
      command = [...cmd];
      return okResult();
    });

    await mcGetenables(makeDevice());

    expect(command.slice(-2)).toEqual(['mc', 'getenables']);
  });

  it('passes cipher through onto the result', async () => {
    mockedRun.mockImplementation(async (_cmd, _pw, _t, opts) => okResult(opts?.cipherUsed ?? null));
    const result = await mcGetenables(makeDevice('17'));
    expect(result.cipherUsed).toBe('17');
  });
});
