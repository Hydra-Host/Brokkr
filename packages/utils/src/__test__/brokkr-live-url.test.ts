import { describe, expect, it } from 'vitest';

import {
  buildDiscoveryFileBaseUrl,
  buildDiscoveryManifestUrl,
  discoveryRootUrl,
  withFlavorSuffix,
} from '../brokkr-live-url';

describe('withFlavorSuffix', () => {
  it('tags the version for light and leaves full untouched', () => {
    expect(withFlavorSuffix('1.2.3', 'light')).toBe('1.2.3-light');
    expect(withFlavorSuffix('1.2.3', 'full')).toBe('1.2.3');
    expect(withFlavorSuffix('latest-prod', 'light')).toBe('latest-prod-light');
  });

  it('does not double a suffix the version already carries', () => {
    expect(withFlavorSuffix('latest-prod-light', 'light')).toBe('latest-prod-light');
    expect(withFlavorSuffix('1.2.3-light', 'light')).toBe('1.2.3-light');
  });

  it('leaves the version alone for an unknown flavor rather than appending undefined', () => {
    expect(withFlavorSuffix('1.2.3', 'nonesuch')).toBe('1.2.3');
  });
});

describe('discoveryRootUrl', () => {
  it('normalizes a legacy base url naming the light tree back to the flavor-less root', () => {
    expect(discoveryRootUrl('https://assets.test/brokkr-live-light/')).toBe('https://assets.test/brokkr-live');
    expect(discoveryRootUrl('https://assets.test/brokkr-live-light')).toBe('https://assets.test/brokkr-live');
    expect(discoveryRootUrl('https://assets.test/brokkr-live')).toBe('https://assets.test/brokkr-live');
  });
});

describe('discovery url builders', () => {
  it('puts the flavor on the version segment, never on the root', () => {
    expect(
      buildDiscoveryManifestUrl('https://assets.test/brokkr-live', withFlavorSuffix('1.2.3', 'light'), 'arm64'),
    ).toBe('https://assets.test/brokkr-live/1.2.3-light/arm64/manifest.json');
    expect(buildDiscoveryFileBaseUrl('https://assets.test/brokkr-live/', '1.2.3-light', 'arm64')).toBe(
      'https://assets.test/brokkr-live/1.2.3-light/arm64',
    );
  });
});
