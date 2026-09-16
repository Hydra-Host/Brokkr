import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REQUIRED_DISCOVERY_FILES,
  inventoryDiscoveryImages,
  type DiscoveryImageInput,
  type FileStat,
} from '../discovery-image-assert.js';

const DIR = '/var/lib/brokkr/brokkr-live';
const input = (architectures: readonly string[]): DiscoveryImageInput => ({
  discoveryDir: DIR,
  flavors: ['full'],
  architectures,
});

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
    const sizes = new Map(REQUIRED_DISCOVERY_FILES.map((f, i) => [join(DIR, 'full', 'arm64', f), (i + 1) * 100]));
    const inv = await inventoryDiscoveryImages(input(['arm64']), statFrom(sizes));
    expect(inv).toEqual([
      {
        flavor: 'full',
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
    const sizes = new Map([[join(DIR, 'full', 'arm64', 'vmlinuz'), 42]]);
    const inv = await inventoryDiscoveryImages(input(['arm64']), statFrom(sizes));
    const iso = inv[0].files.find((f) => f.name === 'brokkr-discovery.iso');
    expect(iso).toEqual({ name: 'brokkr-discovery.iso', present: false, sizeBytes: 0, mtimeMs: 0 });
  });

  it('reports every configured flavor for every arch, light first', async () => {
    const inv = await inventoryDiscoveryImages(
      { discoveryDir: DIR, flavors: ['light', 'full'], architectures: ['amd64', 'arm64'] },
      statFrom(new Map([[join(DIR, 'light', 'arm64', 'vmlinuz'), 7]])),
    );
    expect(inv.map((entry) => [entry.flavor, entry.arch])).toEqual([
      ['light', 'amd64'],
      ['light', 'arm64'],
      ['full', 'amd64'],
      ['full', 'arm64'],
    ]);
    const lightArm = inv.find((entry) => entry.flavor === 'light' && entry.arch === 'arm64');
    expect(lightArm?.files.find((f) => f.name === 'vmlinuz')?.sizeBytes).toBe(7);
  });
});
