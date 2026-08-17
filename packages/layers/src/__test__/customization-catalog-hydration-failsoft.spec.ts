import { TeeCapability } from '@repo/database';
import { parseGpuFamily } from '@repo/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildCustomizationCatalog,
  type CustomizationCatalog,
  emptyCustomizationCatalog,
  hydrateCustomizationCatalogs,
} from '../customization-catalog-hydration';
import { LayerArtifactRecord } from '../layer-artifact.record';
import { LayerRecord } from '../layer.record';
import { PlatformSettingsRecord } from '../platform-settings.record';
import * as resolveEffectiveBuildModule from '../resolve-effective-build';


const GPU = 'NVIDIA H100 80GB';
const BUILD_ID = 'test-layer-build-id';

function driverGroup() {
  return { id: 'g-driver', slug: 'gpuDriver', name: 'GPU Driver', selectionType: 'SINGLE_SELECT' as const };
}
function frameworkGroup() {
  return { id: 'g-fw', slug: 'gpuFramework', name: 'GPU Framework', selectionType: 'SINGLE_SELECT' as const };
}
function artifact(slug: string, name: string, group: ReturnType<typeof driverGroup>, relatedSlugs: string[]) {
  return {
    osDistro: 'ubuntu',
    osCodename: 'noble',
    layer: { id: `l-${slug}`, slug, name, layerGroup: group },
    relations: relatedSlugs.map((s) => ({ type: 'REQUIRES' as const, groupId: null, relatedLayer: { slug: s } })),
  };
}

type HydratableDevice = {
  gpus: Array<{ model: string; index: number }>;
  server: { teeCapable: TeeCapability } | null;
  architecture: string | null;
  zone: { id: string; layerBuildId: string | null } | null;
  customizationCatalog?: CustomizationCatalog;
};

describe('buildCustomizationCatalog', () => {
  beforeEach(() => {
    vi.spyOn(LayerRecord, 'findBaseLayerSummaries').mockResolvedValue([
      { id: 'b-1', slug: 'ubuntu-noble', name: 'Ubuntu Noble', family: 'base' },
    ]);
    vi.spyOn(LayerRecord, 'findBaseLayersWithOsSample').mockResolvedValue([
      { slug: 'ubuntu-noble', sample: { osDistro: 'ubuntu', osCodename: 'noble', osVersion: '24.04' } },
    ]);
  });

  afterEach(() => vi.restoreAllMocks());

  it('unions REQUIRES across same-slug artifacts so the catalog mirrors the validator', async () => {
    const spy = vi
      .spyOn(LayerArtifactRecord, 'findActiveComponentsForOsPairs')
      .mockResolvedValue([
        artifact('nvidia-driver-580', 'NVIDIA Driver 580', driverGroup(), ['cuda-12.9']),
        artifact('nvidia-driver-580', 'NVIDIA Driver 580', driverGroup(), ['cuda-12.10']),
        artifact('cuda-12.9', 'CUDA 12.9', frameworkGroup(), []),
        artifact('cuda-12.10', 'CUDA 12.10', frameworkGroup(), []),
      ]);

    const catalog = await buildCustomizationCatalog(GPU, false, 'aarch64', { buildId: BUILD_ID });

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ arch: 'arm64', layerBuildId: BUILD_ID }));

    const layers = catalog.componentsByBase['ubuntu-noble'];
    expect(layers.map((l) => l.slug)).toEqual(['gpuFramework', 'gpuDriver']);

    const driver = layers.find((l) => l.slug === 'gpuDriver')!.options[0];
    expect(driver.value).toBe('nvidia-driver-580');
    expect(driver.relations.map((r) => r.relatedOptionValue).sort()).toEqual(['cuda-12.10', 'cuda-12.9']);
  });

  it('tags driver options with the GPU family and leaves non-driver options untagged', async () => {
    vi.spyOn(LayerArtifactRecord, 'findActiveComponentsForOsPairs').mockResolvedValue([
      artifact('nvidia-driver-580', 'NVIDIA Driver 580', driverGroup(), []),
      artifact('cuda-12.9', 'CUDA 12.9', frameworkGroup(), []),
    ]);

    const family = parseGpuFamily(GPU);
    expect(family).toBeTruthy();

    const catalog = await buildCustomizationCatalog(GPU, false, 'amd64', { buildId: BUILD_ID });
    const layers = catalog.componentsByBase['ubuntu-noble'];

    expect(layers.find((l) => l.slug === 'gpuDriver')!.options[0].hardwareCompatibility).toEqual({
      gpuFamilies: [family],
    });
    expect(layers.find((l) => l.slug === 'gpuFramework')!.options[0].hardwareCompatibility).toBeNull();
  });

  it('natural-sorts options so 12.10 lands after 12.9', async () => {
    vi.spyOn(LayerArtifactRecord, 'findActiveComponentsForOsPairs').mockResolvedValue([
      artifact('cuda-12.10', 'CUDA 12.10', frameworkGroup(), []),
      artifact('cuda-12.9', 'CUDA 12.9', frameworkGroup(), []),
    ]);

    const catalog = await buildCustomizationCatalog(GPU, false, 'amd64', { buildId: BUILD_ID });
    const fw = catalog.componentsByBase['ubuntu-noble'].find((l) => l.slug === 'gpuFramework')!;
    expect(fw.options.map((o) => o.value)).toEqual(['cuda-12.9', 'cuda-12.10']);
  });

  it('returns an empty componentsByBase for hardware with no eligible layers (no artifact query)', async () => {
    const spy = vi.spyOn(LayerArtifactRecord, 'findActiveComponentsForOsPairs').mockResolvedValue([]);
    const catalog = await buildCustomizationCatalog('Some Random GPU', false, 'amd64', { buildId: BUILD_ID });
    expect(catalog.componentsByBase).toEqual({});
    expect(catalog.bases).toHaveLength(1);
    expect(spy).not.toHaveBeenCalled();
  });

  it('requests the tee-setup slug only for TEE-capable hardware on a TEE-eligible GPU', async () => {
    const spy = vi.spyOn(LayerArtifactRecord, 'findActiveComponentsForOsPairs').mockResolvedValue([]);

    await buildCustomizationCatalog(GPU, true, 'amd64', { buildId: BUILD_ID });
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ slugs: expect.arrayContaining(['tee-setup']) }));

    await buildCustomizationCatalog(GPU, false, 'amd64', { buildId: BUILD_ID });
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ slugs: expect.not.arrayContaining(['tee-setup']) }));
  });

  it('restricts CPU-only devices (no GPU) to driverless misc layers', async () => {
    const spy = vi.spyOn(LayerArtifactRecord, 'findActiveComponentsForOsPairs').mockResolvedValue([]);
    await buildCustomizationCatalog(null, false, 'amd64', { buildId: BUILD_ID });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ slugs: ['mellanox-ofed', 'docker'] }));
  });

  it('preserves base summaries when the component query fails, reporting the error', async () => {
    vi.spyOn(LayerArtifactRecord, 'findActiveComponentsForOsPairs').mockRejectedValue(
      new Error('component query down'),
    );
    const onComponentError = vi.fn();

    const catalog = await buildCustomizationCatalog(GPU, false, 'amd64', { onComponentError, buildId: BUILD_ID });

    expect(catalog.bases).toEqual([{ id: 'b-1', slug: 'ubuntu-noble', name: 'Ubuntu Noble', family: 'base' }]);
    expect(catalog.componentsByBase).toEqual({});
    expect(onComponentError).toHaveBeenCalledOnce();
  });

  it('returns bases with empty componentsByBase when buildId is omitted', async () => {
    const mockFindComponents = vi.spyOn(LayerArtifactRecord, 'findActiveComponentsForOsPairs');
    const catalog = await buildCustomizationCatalog(GPU, false, 'amd64');
    expect(catalog.bases).toEqual([{ id: 'b-1', slug: 'ubuntu-noble', name: 'Ubuntu Noble', family: 'base' }]);
    expect(catalog.componentsByBase).toEqual({});
    expect(mockFindComponents).not.toHaveBeenCalled();
  });
});

describe('hydrateCustomizationCatalogs', () => {
  afterEach(() => vi.restoreAllMocks());

  it('skips immediately for an empty device list', async () => {
    const spy = vi.spyOn(LayerRecord, 'findBaseLayerSummaries');
    await hydrateCustomizationCatalogs([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('attaches a catalog to each device, deduping queries by (gpu, tee, arch, buildId)', async () => {
    vi.spyOn(LayerRecord, 'findBaseLayerSummaries').mockResolvedValue([
      { id: 'b-1', slug: 'ubuntu-noble', name: 'Ubuntu Noble', family: 'base' },
    ]);
    vi.spyOn(LayerRecord, 'findBaseLayersWithOsSample').mockResolvedValue([
      { slug: 'ubuntu-noble', sample: { osDistro: 'ubuntu', osCodename: 'noble', osVersion: '24.04' } },
    ]);
    vi.spyOn(LayerArtifactRecord, 'findActiveComponentsForOsPairs').mockResolvedValue([]);
    vi.spyOn(resolveEffectiveBuildModule, 'resolveEffectiveBuild').mockResolvedValue('build-1');

    const devices: HydratableDevice[] = [
      {
        gpus: [{ model: GPU, index: 0 }],
        server: { teeCapable: TeeCapability.UNVERIFIED },
        architecture: 'amd64',
        zone: { id: 'z1', layerBuildId: 'build-1' },
      },
      {
        gpus: [{ model: GPU, index: 0 }],
        server: { teeCapable: TeeCapability.UNVERIFIED },
        architecture: 'amd64',
        zone: { id: 'z1', layerBuildId: 'build-1' },
      },
    ];

    await hydrateCustomizationCatalogs(devices);

    expect(devices[0].customizationCatalog).toBeDefined();
    expect(devices[0].customizationCatalog!.bases).toHaveLength(1);
    expect(devices[1].customizationCatalog).toBeDefined();
    expect(resolveEffectiveBuildModule.resolveEffectiveBuild).toHaveBeenCalledTimes(1);
  });

  it('assigns an empty componentsByBase to devices without a zone', async () => {
    vi.spyOn(LayerRecord, 'findBaseLayerSummaries').mockResolvedValue([
      { id: 'b-1', slug: 'ubuntu-noble', name: 'Ubuntu Noble', family: 'base' },
    ]);

    const devices: HydratableDevice[] = [{ gpus: [], server: null, architecture: null, zone: null }];

    await hydrateCustomizationCatalogs(devices);

    expect(devices[0].customizationCatalog).toEqual({
      bases: [{ id: 'b-1', slug: 'ubuntu-noble', name: 'Ubuntu Noble', family: 'base' }],
      componentsByBase: {},
    });
  });

  it('fails loudly with LayerBuildResolutionError when a zone has no build and no global default is configured', async () => {
    vi.spyOn(LayerRecord, 'findBaseLayerSummaries').mockResolvedValue([
      { id: 'b-1', slug: 'ubuntu-noble', name: 'Ubuntu Noble', family: 'base' },
    ]);
    vi.spyOn(PlatformSettingsRecord, 'get').mockResolvedValue({
      id: 'singleton',
      defaultLayerBuildId: null,
      updatedById: null,
      updatedAt: new Date(),
    });

    const devices: HydratableDevice[] = [
      {
        gpus: [{ model: GPU, index: 0 }],
        server: null,
        architecture: 'amd64',
        zone: { id: 'z-unconfigured', layerBuildId: null },
      },
    ];

    await expect(hydrateCustomizationCatalogs(devices)).rejects.toThrow(
      resolveEffectiveBuildModule.LayerBuildResolutionError,
    );
    await expect(hydrateCustomizationCatalogs(devices)).rejects.toThrow(/no layer build assigned/);
  });

  it('degrades an unresolvable zone to the empty catalog, reporting via onZoneResolutionError under failSoftZoneResolution (list path)', async () => {
    vi.spyOn(LayerRecord, 'findBaseLayerSummaries').mockResolvedValue([
      { id: 'b-1', slug: 'ubuntu-noble', name: 'Ubuntu Noble', family: 'base' },
    ]);
    vi.spyOn(PlatformSettingsRecord, 'get').mockResolvedValue({
      id: 'singleton',
      defaultLayerBuildId: null,
      updatedById: null,
      updatedAt: new Date(),
    });
    const onZoneResolutionError = vi.fn();

    const devices: HydratableDevice[] = [
      {
        gpus: [{ model: GPU, index: 0 }],
        server: null,
        architecture: 'amd64',
        zone: { id: 'z-unconfigured', layerBuildId: null },
      },
    ];

    await expect(
      hydrateCustomizationCatalogs(devices, { failSoftZoneResolution: true, onZoneResolutionError }),
    ).resolves.toBeUndefined();

    expect(devices[0].customizationCatalog).toEqual({ bases: [], componentsByBase: {} });
    expect(onZoneResolutionError).toHaveBeenCalledOnce();
    expect(onZoneResolutionError).toHaveBeenCalledWith('z-unconfigured', expect.any(Error));
  });

  it('scopes the fail-soft degradation to the broken zone; healthy zones still get full catalogs', async () => {
    vi.spyOn(LayerRecord, 'findBaseLayerSummaries').mockResolvedValue([
      { id: 'b-1', slug: 'ubuntu-noble', name: 'Ubuntu Noble', family: 'base' },
    ]);
    vi.spyOn(LayerRecord, 'findBaseLayersWithOsSample').mockResolvedValue([
      { slug: 'ubuntu-noble', sample: { osDistro: 'ubuntu', osCodename: 'noble', osVersion: '24.04' } },
    ]);
    vi.spyOn(LayerArtifactRecord, 'findActiveComponentsForOsPairs').mockResolvedValue([
      artifact('cuda-12.9', 'CUDA 12.9', frameworkGroup(), []),
    ]);
    vi.spyOn(PlatformSettingsRecord, 'get').mockResolvedValue({
      id: 'singleton',
      defaultLayerBuildId: null,
      updatedById: null,
      updatedAt: new Date(),
    });
    vi.spyOn(resolveEffectiveBuildModule, 'resolveEffectiveBuild').mockImplementation(async (zone) => {
      if (zone.id === 'z-bad') throw new Error(`Zone ${zone.id} has no layer build assigned`);
      return 'build-1';
    });

    const healthy: HydratableDevice = {
      gpus: [{ model: GPU, index: 0 }],
      server: null,
      architecture: 'amd64',
      zone: { id: 'z-ok', layerBuildId: 'build-1' },
    };
    const broken: HydratableDevice = {
      gpus: [{ model: GPU, index: 0 }],
      server: null,
      architecture: 'amd64',
      zone: { id: 'z-bad', layerBuildId: null },
    };

    await hydrateCustomizationCatalogs([healthy, broken], { failSoftZoneResolution: true });

    expect(healthy.customizationCatalog!.bases).toHaveLength(1);
    expect(healthy.customizationCatalog!.componentsByBase['ubuntu-noble']).not.toEqual([]);
    expect(broken.customizationCatalog).toEqual({ bases: [], componentsByBase: {} });
  });
});

describe('emptyCustomizationCatalog', () => {
  it('returns a fresh object each call so callers cannot share mutable state', () => {
    const a = emptyCustomizationCatalog();
    const b = emptyCustomizationCatalog();
    expect(a).toEqual({ bases: [], componentsByBase: {} });
    expect(a).not.toBe(b);
    expect(a.componentsByBase).not.toBe(b.componentsByBase);
  });
});
