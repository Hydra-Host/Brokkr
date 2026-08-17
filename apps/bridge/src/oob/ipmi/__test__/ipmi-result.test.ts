import { describe, expect, it } from 'vitest';

import type { IPMIResult } from '../result.js';
import { resultError } from '../result.js';

function makeResult(overrides: Partial<IPMIResult>): IPMIResult {
  return {
    ok: true,
    stdout: '',
    stderr: '',
    returncode: 0,
    command: [],
    cipherUsed: null,
    durationMs: 0,
    timedOut: false,
    ...overrides,
  };
}

describe('IPMIResult and resultError', () => {
  it('success result exposes default fields', () => {
    const r = makeResult({ ok: true, stdout: 'ok', stderr: '', returncode: 0 });
    expect(r.ok).toBe(true);
    expect(resultError(r)).toBe('');
    expect(r.command).toEqual([]);
    expect(r.cipherUsed).toBeNull();
    expect(r.timedOut).toBe(false);
  });

  it('error prefers stderr', () => {
    const r = makeResult({ ok: false, stdout: '', stderr: 'auth failed', returncode: 1 });
    expect(resultError(r)).toBe('auth failed');
  });

  it('error synthesizes timeout message when timedOut and no stderr', () => {
    const r = makeResult({ ok: false, stdout: '', stderr: '', returncode: null, timedOut: true });
    expect(resultError(r)).toBe('Command timed out');
  });

  it('error synthesizes rc message when no stderr', () => {
    const r = makeResult({ ok: false, stdout: '', stderr: '', returncode: 1 });
    expect(resultError(r)).toContain('rc=1');
  });
});
