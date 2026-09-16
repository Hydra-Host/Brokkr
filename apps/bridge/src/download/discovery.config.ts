export type DiscoveryFlavor = 'light' | 'full';

// order is the sync order: light first so VMs keep booting while the multi-GB full tree downloads
export const DISCOVERY_FLAVORS: readonly DiscoveryFlavor[] = ['light', 'full'];

// production bridges point DISCOVERY_BASE_URL at the full tree, and untagged devices must keep booting from it
const DEFAULT_DISCOVERY_FLAVORS = 'full';

export interface DiscoveryFileConfig {
  chunkSize: number;
  discoveryDownloadTimeout: number;
  architectures: readonly string[];
  flavors: readonly DiscoveryFlavor[];
}

export const ARCH_SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

function isDiscoveryFlavor(value: string): value is DiscoveryFlavor {
  return DISCOVERY_FLAVORS.some((flavor) => flavor === value);
}

export function parseDiscoveryFlavors(raw: string | undefined): DiscoveryFlavor[] {
  const requested = (raw ?? DEFAULT_DISCOVERY_FLAVORS)
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (requested.length === 0 || !requested.every(isDiscoveryFlavor)) {
    throw new Error(
      `DISCOVERY_FLAVORS must be a comma-separated list of ${DISCOVERY_FLAVORS.join('|')}, got ${JSON.stringify(raw)}`,
    );
  }
  return DISCOVERY_FLAVORS.filter((flavor) => requested.includes(flavor));
}

let cached: DiscoveryFileConfig | undefined;

export function getDiscoveryFileConfig(): DiscoveryFileConfig {
  if (cached === undefined) {
    cached = {
      chunkSize: 10 * 1024 * 1024,
      discoveryDownloadTimeout: 300,
      architectures: (process.env.DISCOVERY_ARCHITECTURES ?? 'amd64,arm64')
        .split(',')
        .map((a) => a.trim())
        .filter((a) => a.length > 0 && ARCH_SEGMENT_RE.test(a)),
      flavors: parseDiscoveryFlavors(process.env.DISCOVERY_FLAVORS),
    };
  }
  return cached;
}

export function resetDiscoveryFileConfig(): void {
  cached = undefined;
}
