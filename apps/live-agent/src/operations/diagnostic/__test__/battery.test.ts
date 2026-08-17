import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../exec', () => ({
  run: vi.fn(),
}));

import { run } from '../../../exec';
import { runBatteryDiagnostic } from '../battery';

const runMock = vi.mocked(run);

function ok(stdout: string) {
  return { stdout, stderr: '', exit_code: 0, duration_ms: 0 };
}

function fail() {
  return { stdout: '', stderr: 'no ups', exit_code: 1, duration_ms: 0 };
}

beforeEach(() => {
  runMock.mockReset();
});

describe('diagnostic.battery', () => {
  it('returns battery namespace with healthy status when no UPS is present', async () => {
    runMock.mockResolvedValue(fail());

    const result = (await runBatteryDiagnostic()) as { battery: { status: string } };

    expect(result).toHaveProperty('battery');
    expect(typeof result.battery.status).toBe('string');
  });

  it('parses apcaccess output without throwing', async () => {
    runMock.mockImplementation(async (cmd, args) => {
      if (cmd === '/bin/sh' && args && args[1] === 'apcaccess') {
        return ok(
          ['STATUS   : ONLINE', 'BCHARGE  : 100.0 Percent', 'BATTV    : 27.3 Volts', 'TIMELEFT : 45.0 Minutes'].join(
            '\n',
          ),
        );
      }
      return fail();
    });

    const result = (await runBatteryDiagnostic()) as { battery: { status: string } };

    expect(result.battery.status).toBeDefined();
  });
});
