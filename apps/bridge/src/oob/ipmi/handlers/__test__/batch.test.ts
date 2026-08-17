import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IPMIDevice } from '../../device.js';
import { createIpmiDevice } from '../../device.js';
import type { IPMIResult } from '../../result.js';
import { run } from '../../transport.js';
import { IPMIValidationError } from '../../validation.js';
import { executeBatch } from '../batch.js';

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

describe('executeBatch', () => {
  it('runs three valid commands and returns three IPMIResults', async () => {
    const seen: string[][] = [];
    mockedRun.mockImplementation(async (cmd) => {
      seen.push([...cmd]);
      return okResult(cmd);
    });

    const results = await executeBatch(device(), [
      ['chassis', 'status'],
      ['mc', 'info'],
      ['fru', 'print'],
    ]);

    expect(results.length).toBe(3);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(seen.length).toBe(3);
    expect(seen[0]?.slice(-2)).toEqual(['chassis', 'status']);
    expect(seen[1]?.slice(-2)).toEqual(['mc', 'info']);
    expect(seen[2]?.slice(-2)).toEqual(['fru', 'print']);
  });

  it('applies -c only to CSV-output commands, deciding per command', async () => {
    const seen: string[][] = [];
    mockedRun.mockImplementation(async (cmd) => {
      seen.push([...cmd]);
      return okResult(cmd);
    });

    await executeBatch(device(), [
      ['sensor', 'list'],
      ['chassis', 'status'],
    ]);

    expect(seen.length).toBe(2);
    const sensorArgv = seen[0] ?? [];
    expect(sensorArgv).toContain('-c');
    expect(sensorArgv.indexOf('-c')).toBeLessThan(sensorArgv.indexOf('-H'));
    expect(seen[1]).not.toContain('-c');
  });

  it('omits -c for non-CSV commands even when a later command is CSV', async () => {
    const seen: string[][] = [];
    mockedRun.mockImplementation(async (cmd) => {
      seen.push([...cmd]);
      return okResult(cmd);
    });

    await executeBatch(device(), [
      ['chassis', 'status'],
      ['sensor', 'list'],
    ]);

    expect(seen.length).toBe(2);
    expect(seen[0]).not.toContain('-c');
    expect(seen[1]).toContain('-c');
  });

  it('isolates a per-command validation failure without aborting the batch', async () => {
    const seen: string[][] = [];
    mockedRun.mockImplementation(async (cmd) => {
      seen.push([...cmd]);
      return okResult(cmd);
    });

    const results = await executeBatch(device(), [
      ['chassis', 'status'],
      ['rm', 'rf'],
      ['fru', 'print'],
    ]);

    expect(results.length).toBe(3);
    expect(seen.length).toBe(2);
    expect(results[0]?.ok).toBe(true);
    expect(results[2]?.ok).toBe(true);
    const bad = results[1];
    if (!bad) throw new Error('expected a middle entry');
    expect(bad.ok).toBe(false);
    expect(bad.returncode).toBeNull();
    expect(bad.stderr).toContain('Validation error');
    expect(bad.command).toEqual(['rm', 'rf']);
  });

  it('rejects an oversize batch and never calls the transport', async () => {
    const oversize: string[][] = Array.from({ length: 21 }, () => ['chassis', 'status']);
    await expect(executeBatch(device(), oversize)).rejects.toBeInstanceOf(IPMIValidationError);
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it('returns an empty array on empty input without calling the transport', async () => {
    const results = await executeBatch(device(), []);
    expect(results).toEqual([]);
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it('skips non-iterable entries instead of aborting the batch', async () => {
    const seen: string[][] = [];
    mockedRun.mockImplementation(async (cmd) => {
      seen.push([...cmd]);
      return okResult(cmd);
    });

    const results = await executeBatch(device(), [['chassis', 'status'], 42, ['mc', 'info']]);

    expect(results.length).toBe(2);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(seen[0]?.slice(-2)).toEqual(['chassis', 'status']);
    expect(seen[1]?.slice(-2)).toEqual(['mc', 'info']);
  });

  it('accepts a mix of string and list entries', async () => {
    const seen: string[][] = [];
    mockedRun.mockImplementation(async (cmd) => {
      seen.push([...cmd]);
      return okResult(cmd);
    });

    const results = await executeBatch(device(), ['chassis status', ['mc', 'info']]);

    expect(results.length).toBe(2);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(seen[0]?.slice(-2)).toEqual(['chassis', 'status']);
    expect(seen[1]?.slice(-2)).toEqual(['mc', 'info']);
  });

  it('forwards device.cipher to every transport call and surfaces it on every result', async () => {
    const captured: (string | null | undefined)[] = [];
    mockedRun.mockImplementation(async (cmd, _pw, _timeout, opts) => {
      captured.push(opts?.cipherUsed);
      return okResult(cmd, opts?.cipherUsed ?? null);
    });

    const results = await executeBatch(device('17'), [
      ['chassis', 'status'],
      ['mc', 'info'],
    ]);

    expect(captured).toEqual(['17', '17']);
    expect(results.map((r) => r.cipherUsed)).toEqual(['17', '17']);
  });

  it('decides -c per command across a mixed-order batch', async () => {
    const seen: string[][] = [];
    mockedRun.mockImplementation(async (cmd) => {
      seen.push([...cmd]);
      return okResult(cmd);
    });

    const results = await executeBatch(device(), [
      ['chassis', 'status'],
      ['sensor', 'list'],
      ['mc', 'info'],
      ['sdr', 'list'],
    ]);

    expect(results.length).toBe(4);
    expect(seen.length).toBe(4);
    expect(seen[0]).not.toContain('-c');
    expect(seen[1]).toContain('-c');
    expect(seen[2]).not.toContain('-c');
    expect(seen[3]).toContain('-c');
  });

  it('applies -c per command regardless of whether the first valid command is CSV', async () => {
    const seen: string[][] = [];
    mockedRun.mockImplementation(async (cmd) => {
      seen.push([...cmd]);
      return okResult(cmd);
    });

    const results = await executeBatch(device(), [
      ['rm', 'rf'],
      ['sensor', 'list'],
      ['chassis', 'status'],
    ]);

    expect(results.length).toBe(3);
    expect(seen.length).toBe(2);
    expect(seen[0]).toContain('-c');
    expect(seen[1]).not.toContain('-c');
  });

  it('propagates an explicit timeout to every transport.run invocation', async () => {
    const timeouts: number[] = [];
    mockedRun.mockImplementation(async (cmd, _pw, timeout) => {
      timeouts.push(timeout);
      return okResult(cmd);
    });

    await executeBatch(
      device(),
      [
        ['chassis', 'status'],
        ['mc', 'info'],
      ],
      { timeout: 9 },
    );

    expect(timeouts).toEqual([9, 9]);
  });

  it('accepts exactly maxCommands entries (off-by-one guard)', async () => {
    mockedRun.mockImplementation(async (cmd) => okResult(cmd));
    const commands: string[][] = Array.from({ length: 20 }, () => ['chassis', 'status']);
    const results = await executeBatch(device(), commands);
    expect(results.length).toBe(20);
    expect(mockedRun).toHaveBeenCalledTimes(20);
  });
});
