import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IPMIDevice } from '../../device.js';
import { createIpmiDevice } from '../../device.js';
import type { IPMIResult } from '../../result.js';
import { run } from '../../transport.js';
import { IPMIValidationError } from '../../validation.js';
import { solDeactivate, solInfo, solPayloadEnable, solPayloadStatus, solSetEnabled } from '../sol.js';

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

describe('solInfo', () => {
  it('emits the canonical argv and forwards device fields to transport.run', async () => {
    const captured: {
      command?: string[];
      password?: string;
      timeout?: number;
      cipherUsed?: string | null;
      jobId?: string;
    } = {};
    mockedRun.mockImplementation(async (cmd, pw, t, opts) => {
      captured.command = [...cmd];
      captured.password = pw;
      captured.timeout = t;
      captured.cipherUsed = opts?.cipherUsed ?? null;
      captured.jobId = opts?.jobId ?? '';
      return okResult();
    });

    const result = await solInfo(makeDevice(), 1);

    expect(result.ok).toBe(true);
    expect(captured.command?.slice(-3)).toEqual(['sol', 'info', '1']);
    expect(captured.command).toContain('-H');
    expect(captured.command).toContain('10.0.0.1');
    expect(captured.command).toContain('lanplus');
    expect(captured.password).toBe('s3cret');
    expect(captured.timeout).toBe(30);
    expect(captured.jobId).toBe('job-xyz');
  });

  it('propagates a custom timeout', async () => {
    let timeout = 0;
    mockedRun.mockImplementation(async (_cmd, _pw, t) => {
      timeout = t;
      return okResult();
    });

    await solInfo(makeDevice(), 1, { timeout: 90 });

    expect(timeout).toBe(90);
  });

  it('includes -C<cipher> when device.cipher is set and surfaces it on the result', async () => {
    let command: string[] = [];
    mockedRun.mockImplementation(async (cmd, _pw, _t, opts) => {
      command = [...cmd];
      return okResult(opts?.cipherUsed ?? null);
    });

    const result = await solInfo(makeDevice('17'), 1);

    expect(command).toContain('-C17');
    expect(result.cipherUsed).toBe('17');
  });
});

describe('solSetEnabled', () => {
  it('emits the enabled=true argv', async () => {
    let command: string[] = [];
    mockedRun.mockImplementation(async (cmd) => {
      command = [...cmd];
      return okResult();
    });

    await solSetEnabled(makeDevice(), true, 1);

    expect(command.slice(-5)).toEqual(['sol', 'set', 'enabled', 'true', '1']);
  });

  it('emits the enabled=false argv', async () => {
    let command: string[] = [];
    mockedRun.mockImplementation(async (cmd) => {
      command = [...cmd];
      return okResult();
    });

    await solSetEnabled(makeDevice(), false, 1);

    expect(command.slice(-5)).toEqual(['sol', 'set', 'enabled', 'false', '1']);
  });
});

describe('solPayloadStatus', () => {
  it('emits the canonical argv', async () => {
    let command: string[] = [];
    mockedRun.mockImplementation(async (cmd) => {
      command = [...cmd];
      return okResult();
    });

    await solPayloadStatus(makeDevice(), 1, 2);

    expect(command.slice(-5)).toEqual(['sol', 'payload', 'status', '1', '2']);
  });

  it('passes cipher through onto the result', async () => {
    mockedRun.mockImplementation(async (_cmd, _pw, _t, opts) => okResult(opts?.cipherUsed ?? null));
    const result = await solPayloadStatus(makeDevice('3'), 1, 2);
    expect(result.cipherUsed).toBe('3');
  });
});

describe('solPayloadEnable', () => {
  it('emits the canonical argv', async () => {
    let command: string[] = [];
    mockedRun.mockImplementation(async (cmd) => {
      command = [...cmd];
      return okResult();
    });

    await solPayloadEnable(makeDevice(), 1, 2);

    expect(command.slice(-5)).toEqual(['sol', 'payload', 'enable', '1', '2']);
  });
});

describe('solDeactivate', () => {
  it('emits the canonical argv and uses a 15s default timeout', async () => {
    const captured: { command?: string[]; timeout?: number } = {};
    mockedRun.mockImplementation(async (cmd, _pw, t) => {
      captured.command = [...cmd];
      captured.timeout = t;
      return okResult();
    });

    await solDeactivate(makeDevice());

    expect(captured.command?.slice(-2)).toEqual(['sol', 'deactivate']);
    expect(captured.timeout).toBe(15);
  });

  it('respects a custom timeout', async () => {
    let timeout = 0;
    mockedRun.mockImplementation(async (_cmd, _pw, t) => {
      timeout = t;
      return okResult();
    });

    await solDeactivate(makeDevice(), { timeout: 5 });

    expect(timeout).toBe(5);
  });

  it('passes cipher through onto the result', async () => {
    mockedRun.mockImplementation(async (_cmd, _pw, _t, opts) => okResult(opts?.cipherUsed ?? null));
    const result = await solDeactivate(makeDevice('17'));
    expect(result.cipherUsed).toBe('17');
  });
});

describe('channel and user-id validation', () => {
  it.each([0, -1, 17, 100, 1000])('solInfo rejects out-of-range channel %p', async (badChannel) => {
    await expect(solInfo(makeDevice(), badChannel)).rejects.toBeInstanceOf(IPMIValidationError);
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it('solInfo rejects non-integer channel', async () => {
    await expect(solInfo(makeDevice(), 'abc' as unknown as number)).rejects.toBeInstanceOf(IPMIValidationError);
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it.each([0, 17])('solSetEnabled rejects out-of-range channel %p', async (badChannel) => {
    await expect(solSetEnabled(makeDevice(), true, badChannel)).rejects.toBeInstanceOf(IPMIValidationError);
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it.each([0, 17])('solPayloadStatus rejects out-of-range channel %p', async (badChannel) => {
    await expect(solPayloadStatus(makeDevice(), badChannel, 1)).rejects.toBeInstanceOf(IPMIValidationError);
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it.each([0, -1, 65, 100, 1000])('solPayloadStatus rejects out-of-range user id %p', async (badUid) => {
    await expect(solPayloadStatus(makeDevice(), 1, badUid)).rejects.toBeInstanceOf(IPMIValidationError);
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it.each([0, 65])('solPayloadEnable rejects out-of-range user id %p', async (badUid) => {
    await expect(solPayloadEnable(makeDevice(), 1, badUid)).rejects.toBeInstanceOf(IPMIValidationError);
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it('solPayloadEnable rejects non-integer user id', async () => {
    await expect(solPayloadEnable(makeDevice(), 1, 'abc' as unknown as number)).rejects.toBeInstanceOf(
      IPMIValidationError,
    );
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it.each([1, 8, 16])('solInfo accepts boundary channel %p', async (goodChannel) => {
    mockedRun.mockResolvedValue(okResult());
    const result = await solInfo(makeDevice(), goodChannel);
    expect(result.ok).toBe(true);
  });

  it.each([1, 32, 64])('solPayloadStatus accepts boundary user id %p', async (goodUid) => {
    mockedRun.mockResolvedValue(okResult());
    const result = await solPayloadStatus(makeDevice(), 1, goodUid);
    expect(result.ok).toBe(true);
  });
});
