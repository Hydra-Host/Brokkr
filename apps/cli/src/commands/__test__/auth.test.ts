import { resolveApiKeySource } from '../auth.js';

describe('resolveApiKeySource', () => {
  it('uses an inline --api-key value and flags it for an argv-exposure warning', () => {
    expect(resolveApiKeySource('secret-key', undefined)).toEqual({
      source: 'argv',
      key: 'secret-key',
      warnArgvExposure: true,
    });
  });

  it('reads BROKKR_API_KEY when --api-key has no inline value (no warning)', () => {
    const result = resolveApiKeySource(true, 'env-key');
    expect(result).toEqual({ source: 'env', key: 'env-key' });
    expect('warnArgvExposure' in result).toBe(false);
  });

  it('prefers the inline argv value over the env var', () => {
    expect(resolveApiKeySource('inline-key', 'env-key')).toEqual({
      source: 'argv',
      key: 'inline-key',
      warnArgvExposure: true,
    });
  });

  it('trims whitespace from BROKKR_API_KEY and ignores an all-whitespace value', () => {
    expect(resolveApiKeySource(true, '  padded-key  ')).toEqual({ source: 'env', key: 'padded-key' });
    expect(resolveApiKeySource(true, '   ')).toEqual({ source: 'prompt' });
  });

  it('falls back to the interactive prompt when neither argv nor env supplies a key', () => {
    expect(resolveApiKeySource(true, undefined)).toEqual({ source: 'prompt' });
    expect(resolveApiKeySource(undefined, undefined)).toEqual({ source: 'prompt' });
  });
});
