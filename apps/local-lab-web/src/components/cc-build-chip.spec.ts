import { describe, expect, it } from 'vitest';

import { ccBuildChipModel } from './cc-build-chip';

const fresh = { sha: 'a1b2c3d4e5f6', builtAt: 1_700_000_000_000, headSha: 'a1b2c3d4e5f6', stale: false };

describe('ccBuildChipModel', () => {
  it('shows the short sha in the dim tone when the build is fresh', () => {
    const m = ccBuildChipModel(fresh);
    expect(m.text).toBe('cc a1b2c3d');
    expect(m.tone).toBe('dim');
  });

  it('turns red with a stale marker when the checkout moved', () => {
    const m = ccBuildChipModel({ ...fresh, headSha: 'f6e5d4c3b2a1', stale: true });
    expect(m.tone).toBe('red');
    expect(m.text).toContain('stale');
    expect(m.title).toContain('f6e5d4c');
  });

  it('renders an unknown placeholder without a stamp sha', () => {
    expect(ccBuildChipModel({ sha: null, builtAt: null, headSha: null, stale: false }).text).toBe('cc ?');
    expect(ccBuildChipModel(null).text).toBe('cc ?');
  });
});
