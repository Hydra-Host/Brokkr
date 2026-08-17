import { describe, expect, it } from 'vitest';

import { LOG_LEVELS, NUMERIC_LEVELS, resolveLogLevel } from '../log-levels';

describe('LOG_LEVELS', () => {
  it('uses the canonical integer values', () => {
    expect(LOG_LEVELS).toEqual({
      DEBUG: 10,
      INFO: 20,
      WARNING: 30,
      ERROR: 40,
    });
  });
});

describe('NUMERIC_LEVELS', () => {
  it('maps lowercase level names to the same integers as LOG_LEVELS', () => {
    expect(NUMERIC_LEVELS).toEqual({
      debug: 10,
      info: 20,
      warning: 30,
      error: 40,
    });
  });
});

describe('resolveLogLevel', () => {
  it('returns info regardless of LOG_LEVEL=debug', () => {
    expect(resolveLogLevel({ LOG_LEVEL: 'debug' } as NodeJS.ProcessEnv)).toBe('info');
  });

  it('returns info regardless of LOG_LEVEL=warning', () => {
    expect(resolveLogLevel({ LOG_LEVEL: 'warning' } as NodeJS.ProcessEnv)).toBe('info');
  });

  it('returns info regardless of LOG_LEVEL=error', () => {
    expect(resolveLogLevel({ LOG_LEVEL: 'error' } as NodeJS.ProcessEnv)).toBe('info');
  });

  it('returns info on unknown level', () => {
    expect(resolveLogLevel({ LOG_LEVEL: 'verbose' } as NodeJS.ProcessEnv)).toBe('info');
  });

  it('returns info when LOG_LEVEL is unset', () => {
    expect(resolveLogLevel({} as NodeJS.ProcessEnv)).toBe('info');
  });
});
