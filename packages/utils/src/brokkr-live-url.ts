// The publisher tags the light variant on the version segment, not the root: {root}/{version}-light/{arch}/.
// The bridge syncs that tree and the lab verifies it, so both must move together.

const FLAVOR_VERSION_SUFFIX: Record<string, string> = { light: '-light' };

// Plain string so the bridge's DiscoveryFlavor union and the lab's wire-derived string both fit.
// Idempotent: `latest-prod-light` and a resolved `1.2.3-light` arrive suffixed and must not double.
export function withFlavorSuffix(version: string, flavor: string): string {
  const suffix = FLAVOR_VERSION_SUFFIX[flavor] ?? '';
  return suffix && !version.endsWith(suffix) ? `${version}${suffix}` : version;
}

// An older config pointed the base url at the light tree itself; normalizing back lets it resolve.
export function discoveryRootUrl(url: string): string {
  return url.replace(/\/+$/, '').replace(/-light$/, '');
}

// `rootUrl` is flavor-less; the flavor belongs in `version`. A pre-flavorized root doubles the suffix.
export function buildDiscoveryFileBaseUrl(rootUrl: string, version: string, arch: string): string {
  return `${rootUrl.replace(/\/+$/, '')}/${version}/${arch}`;
}

export function buildDiscoveryManifestUrl(rootUrl: string, version: string, arch: string): string {
  return `${buildDiscoveryFileBaseUrl(rootUrl, version, arch)}/manifest.json`;
}
