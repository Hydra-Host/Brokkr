import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REQUIRED_DISCOVERY_FILES,
  inventoryDiscoveryImages,
  type DiscoveryImageInput,
  type FileStat,
} from '../discovery-image-assert.js';

const DIR = '/var/lib/brokkr/brokkr-live';
const input = (architectures: readonly string[]): DiscoveryImageInput => ({ discoveryDir: DIR, architectures });

function statFrom(sizes: ReadonlyMap<string, number>): FileStat {
  return async (path) => {
    const size = sizes.get(path);
    return size === undefined
      ? { present: false, sizeBytes: 0, mtimeMs: 0 }
      : { present: true, sizeBytes: size, mtimeMs: 1000 };
  };
}

describe('inventoryDiscoveryImages', () => {
  it('reports present + size for every required file of an arch', async () => {
    const sizes = new Map(REQUIRED_DISCOVERY_FILES.map((f, i) => [join(DIR, 'arm64', f), (i + 1) * 100]));
    const inv = await inventoryDiscoveryImages(input(['arm64']), statFrom(sizes));
    expect(inv).toEqual([
      {
        arch: 'arm64',
        files: REQUIRED_DISCOVERY_FILES.map((name, i) => ({
          name,
          present: true,
          sizeBytes: (i + 1) * 100,
          mtimeMs: 1000,
        })),
      },
    ]);
  });

  it('marks a missing file present:false with zero size', async () => {
    const sizes = new Map([[join(DIR, 'arm64', 'vmlinuz'), 42]]);
    const inv = await inventoryDiscoveryImages(input(['arm64']), statFrom(sizes));
    const iso = inv[0].files.find((f) => f.name === 'brokkr-discovery.iso');
    expect(iso).toEqual({ name: 'brokkr-discovery.iso', present: false, sizeBytes: 0, mtimeMs: 0 });
  });
});
