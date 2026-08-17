
import { describe, expect, it, vi } from 'vitest';
import type { IPMIDevice } from '../../oob/ipmi/device.js';
import type { IPMIResult } from '../../oob/ipmi/result.js';

import { performIpmiWithRetry } from '../ipmi-operations.js';

function makeDevice(): IPMIDevice {
  return { ip: '10.0.0.5', port: 623 } as unknown as IPMIDevice;
}

function failureResult(stderr: string): IPMIResult {
  return {
    ok: false,
    stdout: '',
    stderr,
    returncode: 1,
    command: ['ipmitool'],
    cipherUsed: null,
    durationMs: 0,
    timedOut: false,
  };
}

describe('performIpmiWithRetry — never silently succeeds on no-op', () => {
  it('returns failure (not success) when the BMC is unreachable for every retry attempt', async () => {
    const ipmiPing = vi.fn().mockResolvedValue(false);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const power = vi.fn();
    const bootDevice = vi.fn();
    const mcReset = vi.fn();
    const shouldExecutePowerOp = vi.fn();

    const result = await performIpmiWithRetry(makeDevice(), 'on', 'job-1', 3, {
      deps: { ipmiPing, sleep, power, bootDevice, mcReset, shouldExecutePowerOp },
    });

    expect(result.result).toBe('failure');
    expect(result.response).toMatch(/not reachable/);
    expect(power).not.toHaveBeenCalled();
    expect(bootDevice).not.toHaveBeenCalled();
    expect(mcReset).not.toHaveBeenCalled();
  });

  it('returns failure when every dispatched attempt fails (no silent success after exhausting retries)', async () => {
    const ipmiPing = vi.fn().mockResolvedValue(true);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const power = vi.fn().mockResolvedValue(failureResult('chassis power command failed'));
    const shouldExecutePowerOp = vi.fn().mockResolvedValue(true);

    const result = await performIpmiWithRetry(makeDevice(), 'on', 'job-2', 3, {
      deps: {
        ipmiPing,
        sleep,
        power,
        bootDevice: vi.fn(),
        mcReset: vi.fn(),
        shouldExecutePowerOp,
      },
    });

    expect(result.result).toBe('failure');
    expect(result.response).toContain('chassis power command failed');
    expect(power).toHaveBeenCalledTimes(3);
  });

  it('throws (does NOT silently succeed) when handed an unknown operation', async () => {
    const ipmiPing = vi.fn().mockResolvedValue(true);
    await expect(
      performIpmiWithRetry(makeDevice(), 'bogus-op', 'job-3', 1, {
        deps: {
          ipmiPing,
          sleep: vi.fn().mockResolvedValue(undefined),
          power: vi.fn(),
          bootDevice: vi.fn(),
          mcReset: vi.fn(),
          shouldExecutePowerOp: vi.fn(),
        },
      }),
    ).rejects.toThrowError(/Unknown IPMI operation/);
  });
});
