import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as syncLog from '../../logger/sync-log';
import { resolveEnvSecret, warnPartialEnv } from '../secret-helpers';

describe('warnPartialEnv', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(syncLog, 'syncLogWarning').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('no log when all present', () => {
    warnPartialEnv('sol_logs', { SOL_LOGS_ENDPOINT_URL: 'https://x', SOL_LOGS_BUCKET: 't' });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('no log when all missing (null)', () => {
    warnPartialEnv('sol_logs', { SOL_LOGS_ENDPOINT_URL: null, SOL_LOGS_BUCKET: null });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('no log when all empty strings', () => {
    warnPartialEnv('sol_logs', { SOL_LOGS_ENDPOINT_URL: '', SOL_LOGS_BUCKET: '' });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns when partial', () => {
    warnPartialEnv('sol_logs', { SOL_LOGS_ENDPOINT_URL: 'https://x', SOL_LOGS_BUCKET: null });
    expect(warnSpy).toHaveBeenCalledOnce();
    const msg = warnSpy.mock.calls[0]?.[0] as string;
    expect(msg).toContain('sol_logs');
    expect(msg).toContain('SOL_LOGS_ENDPOINT_URL');
    expect(msg).toContain('SOL_LOGS_BUCKET');
  });

  it('warn includes present and missing lists', () => {
    warnPartialEnv('test_cred', {
      TEST_CRED_KEY_ONE: 'val1',
      TEST_CRED_KEY_TWO: 'val2',
      TEST_CRED_KEY_THREE: null,
      TEST_CRED_KEY_FOUR: null,
    });
    const msg = warnSpy.mock.calls[0]?.[0] as string;
    expect(msg).toContain('TEST_CRED_KEY_ONE');
    expect(msg).toContain('TEST_CRED_KEY_TWO');
    expect(msg).toContain('TEST_CRED_KEY_THREE');
    expect(msg).toContain('TEST_CRED_KEY_FOUR');
  });

  it('empty env state is noop', () => {
    warnPartialEnv('anything', {});
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('emits JSON list repr', () => {
    warnPartialEnv('sl', { A: 'v', B: null });
    const msg = warnSpy.mock.calls[0]?.[0] as string;
    expect(msg).toContain('have ["A"]');
    expect(msg).toContain('missing ["B"]');
    expect(msg).toContain('(set all or unset all)');
  });
});

describe('resolveEnvSecret', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    infoSpy = vi.spyOn(syncLog, 'syncLogInfo').mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  it('returns the loader payload and logs success', () => {
    const result = resolveEnvSecret({
      slug: 'sol_logs',
      envLoader: () => ({ endpoint: 'https://example/logs' }),
      required: false,
    });
    expect(result).toEqual({ endpoint: 'https://example/logs' });
    const matched = infoSpy.mock.calls.some((c) => String(c[0]).includes("Loaded slug 'sol_logs' from environment"));
    expect(matched).toBe(true);
  });

  it('throws on missing required env with slug name in the message', () => {
    expect(() => resolveEnvSecret({ slug: 'sol_logs', envLoader: () => null, required: true })).toThrow(
      /Required env vars for slug 'sol_logs' are missing/,
    );
  });

  it('returns null when optional and loader returns null, logs at info', () => {
    const result = resolveEnvSecret({ slug: 'sol_logs', envLoader: () => null, required: false });
    expect(result).toBeNull();
    const matched = infoSpy.mock.calls.some((c) => String(c[0]).includes("optional slug 'sol_logs'"));
    expect(matched).toBe(true);
  });

  it('invokes the loader lazily exactly once per call', () => {
    let calls = 0;
    const loader = () => {
      calls += 1;
      return { x: '1' };
    };
    resolveEnvSecret({ slug: 'x', envLoader: loader, required: true });
    expect(calls).toBe(1);
  });
});
