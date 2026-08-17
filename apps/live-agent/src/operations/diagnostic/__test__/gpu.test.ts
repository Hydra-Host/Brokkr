import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../exec', () => ({
  run: vi.fn(),
}));

import { run } from '../../../exec';
import { runGpuDiagnostic } from '../gpu';

const runMock = vi.mocked(run);

function ok(stdout: string) {
  return { stdout, stderr: '', exit_code: 0, duration_ms: 0 };
}

function fail() {
  return { stdout: '', stderr: 'not found', exit_code: 1, duration_ms: 0 };
}

beforeEach(() => {
  runMock.mockReset();
});

describe('diagnostic.gpu', () => {
  it('returns gpu namespace when no GPUs are present', async () => {
    runMock.mockResolvedValue(ok(''));

    const result = (await runGpuDiagnostic()) as { gpu: { status: string } };

    expect(result).toHaveProperty('gpu');
    expect(typeof result.gpu.status).toBe('string');
  });

  it('parses lspci + nvidia-smi happy path without throwing', async () => {
    runMock.mockImplementation(async (cmd, args) => {
      if (cmd === '/bin/sh' && args && args[1] === 'lspci') {
        return ok('00:01.0 VGA compatible controller: NVIDIA Corporation A100\n');
      }
      if (cmd === '/bin/sh' && args && args[1]?.startsWith('nvidia-smi')) {
        return ok('0, A100-SXM4, 45, 70.5, 81920, 81000\n');
      }
      return fail();
    });

    const result = (await runGpuDiagnostic()) as { gpu: { status: string } };

    expect(result.gpu.status).toBeDefined();
  });
});
