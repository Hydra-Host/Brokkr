import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ipmitoolBin } from '../../command.js';
import type { IPMIDevice } from '../../device.js';
import { createIpmiDevice } from '../../device.js';
import * as configModule from '../../ipmi.config.js';
import type { IPMIResult } from '../../result.js';
import { run } from '../../transport.js';
import { IPMIValidationError } from '../../validation.js';
import { executeMetricsCommand } from '../metrics.js';

vi.mock('../../transport.js', () => ({
  run: vi.fn(),
}));

const mockedRun = vi.mocked(run);

function device(cipher: string | null = null): IPMIDevice {
  return createIpmiDevice({ ip: '10.0.0.1', username: 'admin', password: 's3cret', port: 623, cipher });
}

function okResult(command: readonly string[], cipher: string | null = null): IPMIResult {
  return {
    ok: true,
    stdout: 'ok',
    stderr: '',
    returncode: 0,
    command: [...command],
    cipherUsed: cipher,
    durationMs: 1,
    timedOut: false,
  };
}

beforeEach(() => {
  mockedRun.mockReset();
});

describe('executeMetricsCommand', () => {
  it('builds the canonical argv and forwards password and timeout', async () => {
    const captured: {
      command?: string[];
      password?: string;
      timeout?: number;
      cipherUsed?: string | null;
    } = {};
    mockedRun.mockImplementation(async (cmd, pw, t, opts) => {
      captured.command = [...cmd];
      captured.password = pw;
      captured.timeout = t;
      captured.cipherUsed = opts?.cipherUsed ?? null;
      return okResult(cmd, opts?.cipherUsed ?? null);
    });

    const result = await executeMetricsCommand(device(), ['chassis', 'status'], { timeout: 4 });

    expect(result.ok).toBe(true);
    const argv = captured.command ?? [];
    expect(argv[0]).toBe(ipmitoolBin());
    expect(argv.slice(-2)).toEqual(['chassis', 'status']);
    expect(argv).not.toContain('-c');
    expect(captured.password).toBe('s3cret');
    expect(captured.timeout).toBe(4);
  });

  it('inserts -c immediately after the binary for CSV-output commands', async () => {
    let command: string[] = [];
    mockedRun.mockImplementation(async (cmd) => {
      command = [...cmd];
      return okResult(cmd);
    });

    await executeMetricsCommand(device(), ['sensor', 'list']);

    expect(command[0]).toBe(ipmitoolBin());
    expect(command[1]).toBe('-c');
    expect(command.indexOf('-c')).toBeLessThan(command.indexOf('-H'));
    expect(command.slice(-2)).toEqual(['sensor', 'list']);
  });

  it('omits -c when the base command is not in csvOutputCommands', async () => {
    let command: string[] = [];
    mockedRun.mockImplementation(async (cmd) => {
      command = [...cmd];
      return okResult(cmd);
    });

    await executeMetricsCommand(device(), ['chassis', 'status']);

    expect(command).not.toContain('-c');
  });

  it('splits string input on whitespace and yields the same argv as the list form', async () => {
    const seen: string[][] = [];
    mockedRun.mockImplementation(async (cmd) => {
      seen.push([...cmd]);
      return okResult(cmd);
    });

    await executeMetricsCommand(device(), 'chassis status');
    await executeMetricsCommand(device(), ['chassis', 'status']);

    expect(seen[0]).toEqual(seen[1]);
  });

  it('rejects disallowed commands before reaching the transport', async () => {
    await expect(executeMetricsCommand(device(), ['rm', 'rf'])).rejects.toBeInstanceOf(IPMIValidationError);
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it('forwards device.cipher to transport.run and surfaces it on the result', async () => {
    const captured: { command?: string[]; cipherUsed?: string | null } = {};
    mockedRun.mockImplementation(async (cmd, _pw, _t, opts) => {
      captured.command = [...cmd];
      captured.cipherUsed = opts?.cipherUsed ?? null;
      return okResult(cmd, opts?.cipherUsed ?? null);
    });

    const result = await executeMetricsCommand(device('17'), ['chassis', 'status']);

    expect(captured.cipherUsed).toBe('17');
    expect(captured.command).toContain('-C17');
    expect(result.cipherUsed).toBe('17');
  });

  it('falls back to the config default when timeout is undefined', async () => {
    const spy = vi.spyOn(configModule, 'getIpmiMonitoringConfig').mockReturnValue({
      allowedIpmiCommands: { chassis: ['status'] },
      allowedSdrTypes: [],
      allowedDcmiOperations: [],
      allowedChassisPowerOps: [],
      csvOutputCommands: ['sensor', 'user', 'dcmi', 'sdr', 'sel'],
      commandTimeoutSeconds: 42,
    });

    let timeout = 0;
    mockedRun.mockImplementation(async (cmd, _pw, t) => {
      timeout = t;
      return okResult(cmd);
    });

    await executeMetricsCommand(device(), ['chassis', 'status']);

    expect(timeout).toBe(42);
    spy.mockRestore();
  });

  it('honors an explicit timeout over the config default', async () => {
    let timeout = 0;
    mockedRun.mockImplementation(async (cmd, _pw, t) => {
      timeout = t;
      return okResult(cmd);
    });

    await executeMetricsCommand(device(), ['chassis', 'status'], { timeout: 9 });

    expect(timeout).toBe(9);
  });

  it('does not mutate the caller-supplied command array', async () => {
    const cmd = ['sensor', 'list'];
    const snapshot = [...cmd];
    mockedRun.mockImplementation(async (c) => okResult(c));

    await executeMetricsCommand(device(), cmd);

    expect(cmd).toEqual(snapshot);
  });
});
