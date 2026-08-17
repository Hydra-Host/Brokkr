// First registered `tagPattern` match wins: brands needing multiple entries must register
// most-specific-first; model-level variance is handled inside the brand profile, not here.

import { BaseVendorProfile, DefaultVendorProfile } from './vendor-profile.js';

const registered: BaseVendorProfile[] = [];

/** Fallback when a device's tag matches no registered brand — carries the base defaults. */
export const DEFAULT_VENDOR_PROFILE: BaseVendorProfile = new DefaultVendorProfile();

export function registerVendorProfile(profile: BaseVendorProfile): void {
  registered.push(profile);
}

/** Resolve `RedfishDevice.tag()` to its brand profile; unmatched → default. */
export function resolveVendorProfile(tag: string): BaseVendorProfile {
  return registered.find((profile) => profile.tagPattern.test(tag)) ?? DEFAULT_VENDOR_PROFILE;
}

/** Discovery-time tags are still bare (`vendor..`), where narrow `tagPattern`s silently miss. */
export function resolveVendorProfileForDiscovery(tag: string): BaseVendorProfile {
  return (
    registered.find((profile) => (profile.discoveryTagPattern ?? profile.tagPattern).test(tag)) ??
    DEFAULT_VENDOR_PROFILE
  );
}

/** Test-only: clear registrations between suites. */
export function resetVendorRegistry(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetVendorRegistry() is test-only and must not be called outside tests');
  }
  registered.length = 0;
}
