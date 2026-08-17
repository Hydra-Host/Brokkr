export interface DiscoveryFileConfig {
  chunkSize: number;
  discoveryDownloadTimeout: number;
  architectures: readonly string[];
}

export const ARCH_SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

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
    };
  }
  return cached;
}

export function resetDiscoveryFileConfig(): void {
  cached = undefined;
}
