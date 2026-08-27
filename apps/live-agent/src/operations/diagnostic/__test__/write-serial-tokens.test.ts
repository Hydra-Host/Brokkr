import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../exec', () => ({
  run: vi.fn(),
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, open: vi.fn() };
});

import { open } from 'node:fs/promises';
import { clearOperationsForTests, getHandler } from '../../../dispatch/registry';
import { run } from '../../../exec';
import { registerWriteSerialTokensDiagnostic } from '../write-serial-tokens';

const runMock = vi.mocked(run);
const openMock = vi.mocked(open);

function sttyOk() {
  return { stdout: '', stderr: '', exit_code: 0, duration_ms: 5 };
}

function sttyFail(stderr = 'no such device') {
  return { stdout: '', stderr, exit_code: 1, duration_ms: 5 };
}

function mockFileHandle() {
  return {
    write: vi.fn().mockResolvedValue({ bytesWritten: 32, buffer: Buffer.alloc(0) }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  runMock.mockReset();
  openMock.mockReset();
  clearOperationsForTests();
  registerWriteSerialTokensDiagnostic();
});

const ctx = { work_id: 'w', job_id: 'probe-test' } as never;

describe('diagnostic.write_serial_tokens', () => {
  it('happy path: writes each port and reports ok', async () => {
    runMock.mockResolvedValue(sttyOk());
    openMock.mockResolvedValue(mockFileHandle() as never);

    const handler = getHandler('diagnostic.write_serial_tokens')!.handler;
    const result = (await handler(
      {
        writes: [
          { port: 'ttyS0', token: 'A', baud: 115200 },
          { port: 'ttyS1', token: 'B', baud: 115200 },
        ],
      },
      ctx,
    )) as { writes: { port: string; ok: boolean; error?: string }[]; total_duration_ms: number };

    expect(result.writes).toHaveLength(2);
    expect(result.writes[0]).toEqual({ port: 'ttyS0', ok: true });
    expect(result.writes[1]).toEqual({ port: 'ttyS1', ok: true });
    expect(result.total_duration_ms).toBeGreaterThanOrEqual(0);
    expect(runMock).toHaveBeenCalledTimes(2);
  });

  it('isolates per-port stty failure: surfaces error, continues other ports', async () => {
    runMock.mockResolvedValueOnce(sttyFail('Permission denied')).mockResolvedValueOnce(sttyOk());
    openMock.mockResolvedValue(mockFileHandle() as never);

    const handler = getHandler('diagnostic.write_serial_tokens')!.handler;
    const result = (await handler(
      {
        writes: [
          { port: 'ttyS0', token: 'A', baud: 115200 },
          { port: 'ttyS1', token: 'B', baud: 115200 },
        ],
      },
      ctx,
    )) as { writes: { port: string; ok: boolean; error?: string }[] };

    expect(result.writes[0]?.ok).toBe(false);
    expect(result.writes[0]?.error).toContain('stty exit=1');
    expect(result.writes[1]?.ok).toBe(true);
  });

  it('captures write-side failure without throwing', async () => {
    runMock.mockResolvedValue(sttyOk());
    openMock.mockRejectedValue(new Error('ENXIO: no such device'));

    const handler = getHandler('diagnostic.write_serial_tokens')!.handler;
    const result = (await handler({ writes: [{ port: 'ttyS0', token: 'X', baud: 115200 }] }, ctx)) as {
      writes: { port: string; ok: boolean; error?: string }[];
    };

    expect(result.writes[0]?.ok).toBe(false);
    expect(result.writes[0]?.error).toContain('ENXIO');
  });

  it('rejects invalid port names before touching stty or open', async () => {
    const handler = getHandler('diagnostic.write_serial_tokens')!.handler;
    const result = (await handler({ writes: [{ port: '../etc/passwd', token: 'X', baud: 115200 }] }, ctx)) as {
      writes: { port: string; ok: boolean; error?: string }[];
    };

    expect(result.writes[0]?.ok).toBe(false);
    expect(result.writes[0]?.error).toContain('invalid port name');
    expect(runMock).not.toHaveBeenCalled();
    expect(openMock).not.toHaveBeenCalled();
  });

  it('handles an entirely empty writes array gracefully', async () => {
    const handler = getHandler('diagnostic.write_serial_tokens')!.handler;
    const result = (await handler({ writes: [] }, ctx)) as { writes: unknown[]; total_duration_ms: number };
    expect(result.writes).toEqual([]);
    expect(result.total_duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('clears the write timeout on success (no orphaned timer)', async () => {
    runMock.mockResolvedValue(sttyOk());
    openMock.mockResolvedValue(mockFileHandle() as never);

    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

    try {
      const handler = getHandler('diagnostic.write_serial_tokens')!.handler;
      const result = (await handler({ writes: [{ port: 'ttyS0', token: 'X', baud: 115200 }] }, ctx)) as {
        writes: { port: string; ok: boolean }[];
      };
      expect(result.writes[0]?.ok).toBe(true);

      const created = setTimeoutSpy.mock.results.map((r) => r.value);
      const cleared = clearTimeoutSpy.mock.calls.map((c) => c[0]);
      for (const handle of created) {
        expect(cleared).toContain(handle);
      }
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });
});
