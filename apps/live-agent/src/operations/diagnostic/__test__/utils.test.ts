import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../exec', () => ({
  run: vi.fn(),
}));

import { run } from '../../../exec';
import { numOr, parseSlashDate, runStrict, sh, ShellError, tryShell } from '../utils';

const runMock = vi.mocked(run);

interface RunResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
}

function ok(stdout: string): RunResult {
  return { stdout, stderr: '', exit_code: 0, duration_ms: 0 };
}

function fail(exit_code = 1, stderr = 'boom'): RunResult {
  return { stdout: '', stderr, exit_code, duration_ms: 0 };
}

beforeEach(() => {
  runMock.mockReset();
});

describe('sh', () => {
  it('returns stdout on exit 0', async () => {
    runMock.mockResolvedValue(ok('hello\n'));
    await expect(sh('echo hello')).resolves.toBe('hello\n');
  });

  it('throws ShellError carrying script + stderr on non-zero exit', async () => {
    runMock.mockResolvedValue(fail(2, 'bad'));
    await expect(sh('false')).rejects.toBeInstanceOf(ShellError);
    await expect(sh('false')).rejects.toMatchObject({ exit_code: 2, stderr: 'bad', script: 'false' });
  });
});

describe('runStrict', () => {
  it('returns stdout on exit 0', async () => {
    runMock.mockResolvedValue(ok('output'));
    await expect(runStrict('cmd', ['arg'])).resolves.toBe('output');
  });

  it('throws ShellError with joined command on non-zero exit', async () => {
    runMock.mockResolvedValue(fail(1, 'err'));
    await expect(runStrict('cmd', ['a', 'b'])).rejects.toMatchObject({ script: 'cmd a b' });
  });
});

describe('tryShell', () => {
  it('returns stdout on success', async () => {
    runMock.mockResolvedValue(ok('ok'));
    await expect(tryShell('true')).resolves.toBe('ok');
  });

  it('returns undefined on non-zero exit instead of throwing', async () => {
    runMock.mockResolvedValue(fail());
    await expect(tryShell('false')).resolves.toBeUndefined();
  });

  it('returns undefined when run itself throws', async () => {
    runMock.mockRejectedValue(new Error('spawn failed'));
    await expect(tryShell('true')).resolves.toBeUndefined();
  });
});

describe('numOr', () => {
  it('returns the value when it is a finite number', () => {
    expect(numOr(42)).toBe(42);
    expect(numOr(0)).toBe(0);
    expect(numOr(-3.14)).toBe(-3.14);
  });

  it('returns the fallback for non-numbers', () => {
    expect(numOr('42')).toBe(0);
    expect(numOr(null)).toBe(0);
    expect(numOr(undefined)).toBe(0);
    expect(numOr({})).toBe(0);
  });

  it('returns the fallback for NaN', () => {
    expect(numOr(Number.NaN, 99)).toBe(99);
  });

  it('uses the explicit fallback', () => {
    expect(numOr('bad', 7)).toBe(7);
  });
});

describe('parseSlashDate', () => {
  it('parses mm/dd/yyyy', () => {
    const d = parseSlashDate('06/15/2026');
    expect(d?.toISOString().slice(0, 10)).toBe('2026-06-15');
  });

  it('parses yyyy-mm-dd ISO form', () => {
    const d = parseSlashDate('2026-03-09');
    expect(d?.toISOString().slice(0, 10)).toBe('2026-03-09');
  });

  it('falls back to dd/mm/yyyy when first field exceeds 12', () => {
    const d = parseSlashDate('13/02/2026');
    expect(d?.toISOString().slice(0, 10)).toBe('2026-02-13');
  });

  it('returns null on out-of-range fields (no silent Date.UTC wrap)', () => {
    expect(parseSlashDate('13/13/2026')).toBeNull();
    expect(parseSlashDate('02/32/2026')).toBeNull();
  });

  it('returns null on unparseable input', () => {
    expect(parseSlashDate('not a date')).toBeNull();
    expect(parseSlashDate('')).toBeNull();
  });
});
