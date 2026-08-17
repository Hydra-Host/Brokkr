import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IPMIDevice } from '../../device.js';
import { createIpmiDevice } from '../../device.js';
import type { IPMIResult } from '../../result.js';
import { run } from '../../transport.js';
import { IPMIValidationError } from '../../validation.js';
import { bootDevice, getBootParam, power, powerStatus, shouldExecutePowerOp } from '../power.js';

vi.mock('../../transport.js', () => ({
  run: vi.fn(),
}));

const mockedRun = vi.mocked(run);

const IDEMPOTENT_STDERR_MARKERS = [
  'Command not supported in present state',
  'Unable to establish IPMI v2 / RMCP+ session',
  'Node busy',
];

function device(cipher: string | null = '17'): IPMIDevice {
  return createIpmiDevice({ ip: '10.0.0.1', username: 'admin', password: 's3cret', port: 623, cipher, jobId: 'job-1' });
}

function okResult(stdout = 'Chassis Power is on', cipher: string | null = '17'): IPMIResult {
  return {
    ok: true,
    stdout,
    stderr: '',
    returncode: 0,
    command: [],
    cipherUsed: cipher,
    durationMs: 5,
    timedOut: false,
  };
}

function failResult(stderr: string, returncode = 1, cipher: string | null = '17'): IPMIResult {
  return {
    ok: false,
    stdout: '',
    stderr,
    returncode,
    command: [],
    cipherUsed: cipher,
    durationMs: 5,
    timedOut: false,
  };
}

beforeEach(() => {
  mockedRun.mockReset();
});

describe('power — argv shape', () => {
  it.each(['on', 'off', 'soft', 'status', 'cycle', 'reset'])(
    'appends ["power", %p] to the base command',
    async (op) => {
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

      await power(device(), op, { timeout: 12 });

      const command = captured.command ?? [];
      expect(command.slice(-2)).toEqual(['power', op]);
      expect(command[0]?.endsWith('ipmitool')).toBe(true);
      expect(captured.password).toBe('s3cret');
      expect(captured.timeout).toBe(12);
      expect(captured.cipherUsed).toBe('17');
      expect(captured.jobId).toBe('job-1');
    },
  );

  it('rejects an unknown power op', async () => {
    await expect(power(device(), 'explode')).rejects.toBeInstanceOf(IPMIValidationError);
  });
});

describe('idempotent error recognition', () => {
  for (const marker of IDEMPOTENT_STDERR_MARKERS) {
    for (const op of ['on', 'off', 'soft'] as const) {
      it(`synthesizes ok for state-change op=${op} when stderr contains '${marker}'`, async () => {
        const stderr = `ipmitool: ${marker} (error 0xd5)`;
        mockedRun.mockResolvedValue(failResult(stderr));
        const result = await power(device(), op);
        expect(result.ok).toBe(true);
        expect(result.stdout).toBe(`Power ${op} — already in desired state or transitioning`);
        expect(result.stderr).toContain(marker);
      });
    }
  }

  it('does not synthesize ok for op=status even on a sentinel stderr', async () => {
    const stderr = 'Command not supported in present state';
    mockedRun.mockResolvedValue(failResult(stderr));
    const result = await power(device(), 'status');
    expect(result.ok).toBe(false);
    expect(result.stderr).toBe(stderr);
  });

  it.each(['cycle', 'reset'])('does not synthesize ok for op=%p on a sentinel stderr', async (op) => {
    const stderr = 'Node busy';
    mockedRun.mockResolvedValue(failResult(stderr));
    const result = await power(device(), op);
    expect(result.ok).toBe(false);
    expect(result.stderr).toBe(stderr);
  });

  it('passes unrelated failures through unchanged', async () => {
    const stderr = 'Authentication failure';
    mockedRun.mockResolvedValue(failResult(stderr));
    const result = await power(device(), 'on');
    expect(result.ok).toBe(false);
    expect(result.stderr).toBe(stderr);
  });

  it('returns an already-ok result unchanged', async () => {
    const original = okResult('Chassis Power is on');
    mockedRun.mockResolvedValue(original);
    const result = await power(device(), 'on');
    expect(result).toBe(original);
  });
});

describe('powerStatus parsing', () => {
  it.each([
    ['Chassis Power is on', 'on'],
    ['chassis power is on', 'on'],
    ['Power is on', 'on'],
    ['Chassis Power is off', 'off'],
    ['power is off', 'off'],
  ])('parses %p as %p', async (stdout, expected) => {
    mockedRun.mockResolvedValue(okResult(stdout));
    expect(await powerStatus(device())).toBe(expected);
  });

  it('returns null for unrecognized stdout', async () => {
    mockedRun.mockResolvedValue(okResult('garbage response'));
    expect(await powerStatus(device())).toBeNull();
  });

  it('returns null on a failed status call', async () => {
    mockedRun.mockResolvedValue(failResult('Authentication failure'));
    expect(await powerStatus(device())).toBeNull();
  });
});

describe('shouldExecutePowerOp', () => {
  it('returns false for op=on when already on', async () => {
    mockedRun.mockResolvedValue(okResult('Chassis Power is on'));
    expect(await shouldExecutePowerOp(device(), 'on')).toBe(false);
  });

  it('returns true for op=on when currently off', async () => {
    mockedRun.mockResolvedValue(okResult('Chassis Power is off'));
    expect(await shouldExecutePowerOp(device(), 'on')).toBe(true);
  });

  it.each(['off', 'soft'])('returns false for op=%p when already off', async (op) => {
    mockedRun.mockResolvedValue(okResult('Chassis Power is off'));
    expect(await shouldExecutePowerOp(device(), op)).toBe(false);
  });

  it.each(['off', 'soft'])('returns true for op=%p when currently on', async (op) => {
    mockedRun.mockResolvedValue(okResult('Chassis Power is on'));
    expect(await shouldExecutePowerOp(device(), op)).toBe(true);
  });

  it.each(['status', 'cycle', 'reset'])('returns true for non-idempotent op=%p without probing status', async (op) => {
    mockedRun.mockResolvedValue(okResult());
    expect(await shouldExecutePowerOp(device(), op)).toBe(true);
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it('returns true when the status probe fails (indeterminate)', async () => {
    mockedRun.mockResolvedValue(failResult('Authentication failure'));
    expect(await shouldExecutePowerOp(device(), 'on')).toBe(true);
  });

  it('returns true when status stdout is unparseable', async () => {
    mockedRun.mockResolvedValue(okResult('garbage'));
    expect(await shouldExecutePowerOp(device(), 'off')).toBe(true);
  });
});

describe('getBootParam', () => {
  it('appends ["chassis", "bootparam", "get", "<n>"] to the base command', async () => {
    const captured: { command?: string[]; timeout?: number; cipherUsed?: string | null } = {};
    mockedRun.mockImplementation(async (cmd, _pw, t, opts) => {
      captured.command = [...cmd];
      captured.timeout = t;
      captured.cipherUsed = opts?.cipherUsed ?? null;
      return okResult('Boot parameter data: 0x...');
    });

    const result = await getBootParam(device(), 5, { timeout: 20 });

    expect(captured.command?.slice(-4)).toEqual(['chassis', 'bootparam', 'get', '5']);
    expect(captured.command?.[0]?.endsWith('ipmitool')).toBe(true);
    expect(captured.timeout).toBe(20);
    expect(captured.cipherUsed).toBe('17');
    expect(result.ok).toBe(true);
  });

  it('returns the raw failure without idempotent recognition', async () => {
    const stderr = 'Command not supported in present state';
    mockedRun.mockResolvedValue(failResult(stderr));
    const result = await getBootParam(device(), 5);
    expect(result.ok).toBe(false);
    expect(result.stderr).toBe(stderr);
  });
});

describe('bootDevice', () => {
  it('appends options=persistent,efiboot when uefi=true', async () => {
    let command: string[] = [];
    mockedRun.mockImplementation(async (cmd) => {
      command = [...cmd];
      return okResult();
    });

    await bootDevice(device(), 'pxe', { uefi: true });

    expect(command.slice(-4)).toEqual(['chassis', 'bootdev', 'pxe', 'options=persistent,efiboot']);
  });

  it('appends options=persistent when uefi=false', async () => {
    let command: string[] = [];
    mockedRun.mockImplementation(async (cmd) => {
      command = [...cmd];
      return okResult();
    });

    await bootDevice(device(), 'disk', { uefi: false });

    expect(command.slice(-4)).toEqual(['chassis', 'bootdev', 'disk', 'options=persistent']);
  });

  it.each(['disk', 'bios', 'pxe', 'cdrom'])('accepts target %p', async (target) => {
    mockedRun.mockResolvedValue(okResult());
    const result = await bootDevice(device(), target);
    expect(result.ok).toBe(true);
  });

  it('rejects an unknown target', async () => {
    await expect(bootDevice(device(), 'floppy')).rejects.toBeInstanceOf(IPMIValidationError);
  });
});

describe('cipher propagation', () => {
  it('forwards device.cipher to the transport', async () => {
    let cipher: string | null | undefined;
    mockedRun.mockImplementation(async (_cmd, _pw, _t, opts) => {
      cipher = opts?.cipherUsed;
      return okResult('Chassis Power is on', '3');
    });

    await power(device('3'), 'status');

    expect(cipher).toBe('3');
  });

  it('propagates null when device.cipher is null', async () => {
    let cipher: string | null | undefined;
    mockedRun.mockImplementation(async (_cmd, _pw, _t, opts) => {
      cipher = opts?.cipherUsed;
      return okResult('Chassis Power is on', null);
    });

    await power(device(null), 'status');

    expect(cipher).toBeNull();
  });
});
