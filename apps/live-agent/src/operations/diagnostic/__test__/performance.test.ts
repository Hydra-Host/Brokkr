import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../exec', () => ({
  run: vi.fn(),
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, readFile: vi.fn() };
});

import { readFile } from 'node:fs/promises';
import { run } from '../../../exec';
import { runPerformanceDiagnostic } from '../performance';

const runMock = vi.mocked(run);
const readFileMock = vi.mocked(readFile);

function ok(stdout: string) {
  return { stdout, stderr: '', exit_code: 0, duration_ms: 0 };
}

function fail() {
  return { stdout: '', stderr: 'fail', exit_code: 1, duration_ms: 0 };
}

beforeEach(() => {
  runMock.mockReset();
  readFileMock.mockReset();
});

describe('diagnostic.performance', () => {
  it('returns performance namespace when readFile/dmesg fail', async () => {
    readFileMock.mockRejectedValue(new Error('ENOENT'));
    runMock.mockResolvedValue(fail());

    const result = (await runPerformanceDiagnostic()) as { performance: { status: string } };

    expect(result).toHaveProperty('performance');
    expect(typeof result.performance.status).toBe('string');
  });

  it('parses /proc/cpuinfo + dmesg without throwing', async () => {
    readFileMock.mockImplementation(async (path) => {
      if (typeof path === 'string' && path === '/proc/cpuinfo') {
        return ['processor : 0', 'cpu MHz : 3500.000', '', 'processor : 1', 'cpu MHz : 3500.000', ''].join('\n');
      }
      throw new Error(`ENOENT: ${String(path)}`);
    });
    runMock.mockImplementation(async (cmd, args) => {
      if (cmd === '/bin/sh' && args && args[1] === 'dmesg') {
        return ok('[    0.000000] Linux version 6.5.0\n');
      }
      return fail();
    });

    const result = (await runPerformanceDiagnostic()) as { performance: { status: string } };

    expect(result.performance.status).toBeDefined();
  });
});
