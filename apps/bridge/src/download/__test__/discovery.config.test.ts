import { afterEach, describe, expect, it } from 'vitest';

import { getDiscoveryFileConfig, parseDiscoveryFlavors, resetDiscoveryFileConfig } from '../discovery.config.js';

afterEach(() => {
  delete process.env.DISCOVERY_FLAVORS;
  resetDiscoveryFileConfig();
});

describe('parseDiscoveryFlavors', () => {
  it('defaults to the full flavor when unset', () => {
    expect(parseDiscoveryFlavors(undefined)).toEqual(['full']);
  });

  it('returns the configured flavors in sync order, light first', () => {
    expect(parseDiscoveryFlavors('full, light')).toEqual(['light', 'full']);
  });

  it('dedupes repeated entries', () => {
    expect(parseDiscoveryFlavors('light,light')).toEqual(['light']);
  });

  it('rejects an unknown flavor', () => {
    expect(() => parseDiscoveryFlavors('light,fat')).toThrow(/DISCOVERY_FLAVORS/);
  });

  it('rejects an empty list', () => {
    expect(() => parseDiscoveryFlavors(' , ')).toThrow(/DISCOVERY_FLAVORS/);
  });
});

describe('getDiscoveryFileConfig flavors', () => {
  it('reads DISCOVERY_FLAVORS from the environment', () => {
    process.env.DISCOVERY_FLAVORS = 'light';
    resetDiscoveryFileConfig();
    expect(getDiscoveryFileConfig().flavors).toEqual(['light']);
  });

  it('leaves the cache unset after rejecting an invalid DISCOVERY_FLAVORS', () => {
    process.env.DISCOVERY_FLAVORS = 'fat';
    resetDiscoveryFileConfig();
    expect(() => getDiscoveryFileConfig()).toThrow(/DISCOVERY_FLAVORS/);

    process.env.DISCOVERY_FLAVORS = 'light';
    expect(getDiscoveryFileConfig().flavors).toEqual(['light']);
  });

  it('serves only the full flavor when DISCOVERY_FLAVORS is unset', () => {
    expect(getDiscoveryFileConfig().flavors).toEqual(['full']);
  });
});
