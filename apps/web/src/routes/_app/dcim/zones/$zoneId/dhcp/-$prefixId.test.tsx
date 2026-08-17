import { describe, expect, it } from 'vitest';
import { isPrefixLoadError, prefixBelongsToZone } from './$prefixId';

describe('prefixBelongsToZone (zone-ownership URL guard)', () => {
  it('is true only when the prefix zone exactly matches the URL zone', () => {
    expect(prefixBelongsToZone('zone-1', 'zone-1')).toBe(true);
  });

  it('is false when the prefix belongs to a different zone (cross-zone access blocked)', () => {
    expect(prefixBelongsToZone('zone-2', 'zone-1')).toBe(false);
  });

  it('is false for a zoneless prefix (null never belongs to a URL zone)', () => {
    expect(prefixBelongsToZone(null, 'zone-1')).toBe(false);
  });
});

describe('isPrefixLoadError (distinguish load failure from not-found)', () => {
  it('is true on a query error (network/transport failure)', () => {
    expect(isPrefixLoadError(undefined, true)).toBe(true);
  });

  it('is false while loading (no data, no error yet)', () => {
    expect(isPrefixLoadError(undefined, false)).toBe(false);
  });

  it('is false for a 200 (loaded) or 404 (genuine not-found)', () => {
    expect(isPrefixLoadError(200, false)).toBe(false);
    expect(isPrefixLoadError(404, false)).toBe(false);
  });

  it('is true for any other non-200/404 status (e.g. 400, 401, 500)', () => {
    expect(isPrefixLoadError(400, false)).toBe(true);
    expect(isPrefixLoadError(401, false)).toBe(true);
    expect(isPrefixLoadError(500, false)).toBe(true);
  });
});
