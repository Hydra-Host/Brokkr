import { describe, expect, it, vi } from 'vitest';

import {
  createSolService,
  processBackspaces,
  processControlChars,
  SOLService,
  type SOLServiceDeps,
} from '../sol/sol.service.js';
import type { IPMIResult, SolLogger, SolStream } from '../sol/sol.types.js';

function okResult(): IPMIResult {
  return {
    ok: true,
    stdout: '',
    stderr: '',
    returncode: 0,
    command: [],
    cipherUsed: null,
    durationMs: 1,
    timedOut: false,
  };
}

function timedOutResult(): IPMIResult {
  return {
    ok: false,
    stdout: '',
    stderr: 'Command timed out',
    returncode: 0,
    command: [],
    cipherUsed: null,
    durationMs: 1,
    timedOut: true,
  };
}

function noopLogger(): SolLogger {
  return { info: vi.fn(), warning: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

async function* emptyStream(): SolStream {}

function makeDeps(overrides: Partial<SOLServiceDeps> = {}): SOLServiceDeps {
  return {
    cache: { rpush: vi.fn().mockResolvedValue(1), expire: vi.fn().mockResolvedValue(true) },
    getCipher: vi.fn().mockResolvedValue('3'),
    solDeactivateFn: vi.fn().mockResolvedValue(okResult()),
    pingFn: vi.fn().mockResolvedValue({ result: 'success', response: 'ok' }),
    streamFactory: vi.fn(() => emptyStream()),
    logger: noopLogger(),
    ...overrides,
  };
}

describe('processBackspaces', () => {
  it('passes through text with no backspaces', () => {
    expect(processBackspaces('hello')).toBe('hello');
  });

  it('removes the prior character on a single backspace', () => {
    expect(processBackspaces('helo\bl')).toBe('hell');
  });

  it('pops repeatedly for consecutive backspaces', () => {
    expect(processBackspaces('abc\b\bx')).toBe('ax');
  });

  it('is a no-op on backspace at the start', () => {
    expect(processBackspaces('\bhello')).toBe('hello');
  });
});

describe('processControlChars', () => {
  it('strips ANSI color codes', () => {
    expect(processControlChars('\x1b[31mred\x1b[0m')).toBe('red');
  });

  it('strips null bytes', () => {
    expect(processControlChars('hel\x00lo')).toBe('hello');
  });

  it('applies backspace then ANSI stripping in order', () => {
    expect(processControlChars('helo\bl\x1b[0m')).toBe('hell');
  });
});

describe('createSolService factory', () => {
  it('returns a SOLService bound to the supplied job id', async () => {
    const service = await createSolService('job-1', makeDeps());
    expect(service).toBeInstanceOf(SOLService);
  });
});

describe('SOLService.deactivateSession — timeout semantics', () => {
  it('reports deactivated=true on a timed-out adapter result (best-effort contract)', async () => {
    const solDeactivateFn = vi.fn().mockResolvedValue(timedOutResult());
    const service = new SOLService('job-1', makeDeps({ solDeactivateFn }));
    const out = await service.deactivateSession({ ipAddress: '10.0.0.1', username: 'admin', password: 'pass' });
    expect(out).toEqual({ deactivated: true });
  });

  it('captures the adapter error message verbatim on exception', async () => {
    const solDeactivateFn = vi.fn().mockRejectedValue(new Error('transport boom'));
    const service = new SOLService('job-1', makeDeps({ solDeactivateFn }));
    const out = await service.deactivateSession({ ipAddress: '10.0.0.1', username: 'admin', password: 'pass' });
    expect(out['deactivated']).toBe(false);
    expect(String(out['error'])).toContain('transport boom');
  });
});
