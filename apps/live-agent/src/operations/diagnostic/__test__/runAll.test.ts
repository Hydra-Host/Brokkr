import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../exec', () => ({
  run: vi.fn(),
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, readFile: vi.fn() };
});

import { readFile } from 'node:fs/promises';
import { clearOperationsForTests, getHandler } from '../../../dispatch/registry';
import { run } from '../../../exec';
import { registerRunAllDiagnostic } from '../runAll';

const runMock = vi.mocked(run);
const readFileMock = vi.mocked(readFile);

function fail() {
  return { stdout: '', stderr: 'fail', exit_code: 1, duration_ms: 0 };
}

beforeEach(() => {
  runMock.mockReset();
  readFileMock.mockReset();
  runMock.mockResolvedValue(fail());
  readFileMock.mockRejectedValue(new Error('ENOENT'));
  clearOperationsForTests();
  registerRunAllDiagnostic();
});

describe('diagnostic.runAll', () => {
  it('runs every sub-diagnostic and merges their namespaced output', async () => {
    const handler = getHandler('diagnostic.runAll')!.handler;
    const ctx = { work_id: 'w', job_id: 'j-1' } as never;

    const result = (await handler({}, ctx)) as Record<string, unknown>;

    for (const ns of ['gpu', 'thermal', 'storage', 'memory', 'network', 'performance', 'power', 'system', 'battery']) {
      expect(result).toHaveProperty(ns);
    }
    const meta = result['diagnostics_metadata'] as Record<string, unknown>;
    expect(meta['diagnostics_total']).toBe(9);
    expect(meta['diagnostics_successful']).toBe(9);
    expect(meta['diagnostics_failed']).toBe(0);
    expect(meta['job_id']).toBe('j-1');
  });

  it('counts a diagnostic as failed when its runner rejects', async () => {
    const handler = getHandler('diagnostic.runAll')!.handler;
    const ctx = { work_id: 'w' } as never;

    const result = (await handler({}, ctx)) as Record<string, unknown>;

    const meta = result['diagnostics_metadata'] as Record<string, unknown>;
    expect(meta['job_id']).toBe('');
    expect(typeof meta['diagnostics_total']).toBe('number');
  });
});
