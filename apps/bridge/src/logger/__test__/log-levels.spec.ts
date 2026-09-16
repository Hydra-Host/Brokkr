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
  it('honors LOG_LEVEL=debug', () => {
    expect(resolveLogLevel({ LOG_LEVEL: 'debug' })).toBe('debug');
  });

  it('honors LOG_LEVEL=warning', () => {
    expect(resolveLogLevel({ LOG_LEVEL: 'warning' })).toBe('warning');
  });

  it('maps the warn alias to warning', () => {
    expect(resolveLogLevel({ LOG_LEVEL: 'warn' })).toBe('warning');
  });

  it('honors LOG_LEVEL=error', () => {
    expect(resolveLogLevel({ LOG_LEVEL: 'error' })).toBe('error');
  });

  it('normalizes case and whitespace', () => {
    expect(resolveLogLevel({ LOG_LEVEL: ' DEBUG ' })).toBe('debug');
  });

  it('returns info on unknown level', () => {
    expect(resolveLogLevel({ LOG_LEVEL: 'verbose' })).toBe('info');
  });

  it('returns info when LOG_LEVEL is unset', () => {
    expect(resolveLogLevel({})).toBe('info');
  });

  it('returns info when LOG_LEVEL is empty', () => {
    expect(resolveLogLevel({ LOG_LEVEL: '' })).toBe('info');
  });
});
