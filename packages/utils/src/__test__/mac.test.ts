import { CANONICAL_MAC_REGEX, canonicalMac, isCanonicalMac, mergeProxyAllowlist } from '..';

describe('canonicalMac', () => {
  it.each(['AA:BB:CC:DD:EE:01', 'aabbccddee01', 'AA-BB-CC-DD-EE-01', 'aabb.ccdd.ee01'])(
    'canonicalizes %j to the lowercase colon form',
    (input) => {
      expect(canonicalMac(input)).toBe('aa:bb:cc:dd:ee:01');
    },
  );

  it.each(['00:02:c9:03:00:1a:2b:3c', 'not-a-mac', '00-11-22', ''])('returns null for %j', (input) => {
    expect(canonicalMac(input)).toBeNull();
  });

  it('is idempotent', () => {
    expect(canonicalMac('aa:bb:cc:dd:ee:01')).toBe('aa:bb:cc:dd:ee:01');
  });
});

describe('isCanonicalMac', () => {
  it('accepts only the lowercase colon form', () => {
    expect(isCanonicalMac('aa:bb:cc:dd:ee:01')).toBe(true);
    expect(isCanonicalMac('AA:BB:CC:DD:EE:01')).toBe(false);
    expect(isCanonicalMac('aabbccddee01')).toBe(false);
    expect(isCanonicalMac('aa-bb-cc-dd-ee-01')).toBe(false);
    expect(isCanonicalMac('00:02:c9:03:00:1a:2b:3c')).toBe(false);
    expect(isCanonicalMac('')).toBe(false);
  });

  it('accepts everything canonicalMac produces', () => {
    const canonical = canonicalMac('AA-BB-CC-DD-EE-01');
    expect(canonical).not.toBeNull();
    expect(CANONICAL_MAC_REGEX.test(canonical ?? '')).toBe(true);
  });
});

describe('mergeProxyAllowlist', () => {
  it('unions operator and reservation macs, canonical and sorted', () => {
    expect(mergeProxyAllowlist(['80:61:5F:2C:59:AC'], ['80:61:5f:15:4a:29', '80:61:5f:2c:59:ac'])).toEqual({
      macs: ['80:61:5f:15:4a:29', '80:61:5f:2c:59:ac'],
      rejected: [],
    });
  });

  it('reports inputs that do not canonicalize and keeps the rest', () => {
    expect(mergeProxyAllowlist(['not-a-mac', 'aa-bb-cc-dd-ee-ff'], [])).toEqual({
      macs: ['aa:bb:cc:dd:ee:ff'],
      rejected: ['not-a-mac'],
    });
  });

  it('returns empty lists for empty inputs', () => {
    expect(mergeProxyAllowlist([], [])).toEqual({ macs: [], rejected: [] });
  });
});
