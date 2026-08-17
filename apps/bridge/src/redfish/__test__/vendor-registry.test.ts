import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_VENDOR_PROFILE,
  registerVendorProfile,
  resetVendorRegistry,
  resolveVendorProfile,
  resolveVendorProfileForDiscovery,
} from '../vendor/base/registry.js';
import { BaseVendorProfile } from '../vendor/base/vendor-profile.js';

class FakeDellProfile extends BaseVendorProfile {
  readonly tagPattern = /^dell\.idrac9\..*/;
}
class FakeLenovoProfile extends BaseVendorProfile {
  readonly tagPattern = /^lenovo\.xcc3\..*/;
}
class FakeDellCatchAll extends BaseVendorProfile {
  readonly tagPattern = /^dell\..*/;
}
class FakeDellDiscoveryProfile extends BaseVendorProfile {
  readonly tagPattern = /^dell\.idrac9\..*/;
  override readonly discoveryTagPattern = /^dell\..*/;
}

describe('vendor profile registry', () => {
  afterEach(() => resetVendorRegistry());

  it('falls back to the default profile for an unmatched tag', () => {
    registerVendorProfile(new FakeDellProfile());
    expect(resolveVendorProfile('supermicro.aspeed.foo')).toBe(DEFAULT_VENDOR_PROFILE);
  });

  it('resolves a registered brand by tag pattern', () => {
    const dell = new FakeDellProfile();
    const lenovo = new FakeLenovoProfile();
    registerVendorProfile(dell);
    registerVendorProfile(lenovo);
    expect(resolveVendorProfile('dell.idrac9.poweredge')).toBe(dell);
    expect(resolveVendorProfile('lenovo.xcc3.sr675')).toBe(lenovo);
  });

  it('returns the first registered match (registration order is significant)', () => {
    const specific = new FakeDellProfile();
    const catchAll = new FakeDellCatchAll();
    registerVendorProfile(specific);
    registerVendorProfile(catchAll);
    expect(resolveVendorProfile('dell.idrac9.poweredge')).toBe(specific);
    expect(resolveVendorProfile('dell.idrac8.legacy')).toBe(catchAll);
  });

  it('reset clears registrations', () => {
    registerVendorProfile(new FakeDellProfile());
    resetVendorRegistry();
    expect(resolveVendorProfile('dell.idrac9.poweredge')).toBe(DEFAULT_VENDOR_PROFILE);
  });

  it('discovery resolution matches the bare tag via discoveryTagPattern while tagPattern still does not', () => {
    const profile = new FakeDellDiscoveryProfile();
    registerVendorProfile(profile);
    expect(resolveVendorProfileForDiscovery('dell..')).toBe(profile);
    expect(resolveVendorProfile('dell..')).toBe(DEFAULT_VENDOR_PROFILE);
  });
});
