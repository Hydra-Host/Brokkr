import { describe, expect, it } from 'vitest';

import { ccSkewBannerModel } from './cc-skew-banner';

const base = { sha: 'a1b2c3d4e5f6', builtAt: 1_700_000_000_000, headSha: 'f6e5d4c3b2a1', stale: true };

describe('ccSkewBannerModel', () => {
  it('is hidden when the build is fresh or unknown', () => {
    expect(ccSkewBannerModel({ ...base, stale: false })).toBeNull();
    expect(ccSkewBannerModel(null)).toBeNull();
  });

  it('names both shas and the rebuild remedy when stale', () => {
    const m = ccSkewBannerModel(base);
    expect(m?.text).toContain('a1b2c3d');
    expect(m?.text).toContain('f6e5d4c');
    expect(m?.text).toContain('task up');
  });
});
