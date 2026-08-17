import { afterEach, describe, expect, it } from 'vitest';
import { getProcessApiKey } from '../env.js';

describe('getProcessApiKey', () => {
  const original = process.env.BROKKR_API_KEY;
  afterEach(() => {
    if (original === undefined) delete process.env.BROKKR_API_KEY;
    else process.env.BROKKR_API_KEY = original;
  });

  it('returns undefined when unset', () => {
    delete process.env.BROKKR_API_KEY;
    expect(getProcessApiKey()).toBeUndefined();
  });

  it('returns undefined when blank/whitespace-only', () => {
    process.env.BROKKR_API_KEY = '   \n';
    expect(getProcessApiKey()).toBeUndefined();
  });

  it('trims surrounding whitespace so a padded env var matches the trimmed value login saves', () => {
    process.env.BROKKR_API_KEY = '  brk_abc123\n';
    expect(getProcessApiKey()).toBe('brk_abc123');
  });
});
