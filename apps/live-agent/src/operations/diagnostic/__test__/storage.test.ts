import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../exec', () => ({
  run: vi.fn(),
}));

import { run } from '../../../exec';
import { runStorageDiagnostic } from '../storage';

const runMock = vi.mocked(run);

function ok(stdout: string) {
  return { stdout, stderr: '', exit_code: 0, duration_ms: 0 };
}

function fail() {
  return { stdout: '', stderr: 'no devices', exit_code: 1, duration_ms: 0 };
}

beforeEach(() => {
  runMock.mockReset();
});

describe('diagnostic.storage', () => {
  it('returns storage namespace when no block devices are present', async () => {
    runMock.mockResolvedValue(ok(''));

    const result = (await runStorageDiagnostic()) as { storage: { status: string } };

    expect(result).toHaveProperty('storage');
    expect(typeof result.storage.status).toBe('string');
  });

  it('parses an NVMe device via smart-log without throwing', async () => {
    runMock.mockImplementation(async (cmd, args) => {
      if (cmd === '/bin/sh' && args && args[1]?.startsWith('ls /dev/sd*')) {
        return ok('/dev/nvme0n1\n');
      }
      if (cmd === 'nvme') {
        return ok(JSON.stringify({ temperature: 40, power_on_time: 500, percentage_used: 5 }));
      }
      if (cmd === '/bin/sh' && args && args[1]?.startsWith('mdadm')) {
        return ok('');
      }
      return fail();
    });

    const result = (await runStorageDiagnostic()) as { storage: { status: string } };

    expect(result.storage.status).toBeDefined();
  });
});
