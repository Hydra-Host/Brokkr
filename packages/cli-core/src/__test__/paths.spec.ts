import { describe, expect, it, vi } from 'vitest';
import { getActiveEnvName, getConfigDir, validateEnvName } from '../index.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: () => false };
});

describe('paths', () => {
  it('config dir ends with .config/brokkr', () => {
    expect(getConfigDir().replace(/\\/g, '/')).toMatch(/\.config\/brokkr$/);
  });

  it('validateEnvName rejects unsafe names', () => {
    expect(validateEnvName('dev-1')).toBe('dev-1');
    expect(() => validateEnvName('../etc')).toThrow();
  });

  it('getActiveEnvName falls back to local when no config file and an invalid default env', () => {
    const original = process.env.BROKKR_DEFAULT_ENV;
    process.env.BROKKR_DEFAULT_ENV = 'bad/env';
    try {
      expect(getActiveEnvName()).toBe('local');
    } finally {
      if (original === undefined) {
        delete process.env.BROKKR_DEFAULT_ENV;
      } else {
        process.env.BROKKR_DEFAULT_ENV = original;
      }
    }
  });
});
