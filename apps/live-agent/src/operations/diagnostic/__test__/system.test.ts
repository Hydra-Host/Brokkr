import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../exec', () => ({
  run: vi.fn(),
}));

import { run } from '../../../exec';
import { runSystemDiagnostic } from '../system';

const runMock = vi.mocked(run);

function ok(stdout: string) {
  return { stdout, stderr: '', exit_code: 0, duration_ms: 0 };
}

function fail() {
  return { stdout: '', stderr: 'fail', exit_code: 1, duration_ms: 0 };
}

beforeEach(() => {
  runMock.mockReset();
});

describe('diagnostic.system', () => {
  it('returns system namespace when no diagnostic tools are available', async () => {
    runMock.mockResolvedValue(fail());

    const result = (await runSystemDiagnostic()) as { system: { status: string } };

    expect(result).toHaveProperty('system');
    expect(typeof result.system.status).toBe('string');
  });

  it('parses edac-util -v output without throwing', async () => {
    runMock.mockImplementation(async (cmd, args) => {
      if (cmd === '/bin/sh' && args && args[1] === 'edac-util -v') {
        return ok('edac-util: No errors to report.\n');
      }
      return fail();
    });

    const result = (await runSystemDiagnostic()) as { system: { status: string } };

    expect(result.system.status).toBeDefined();
  });
});
