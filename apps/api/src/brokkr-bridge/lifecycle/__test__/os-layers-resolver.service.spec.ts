import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ActiveRecordRegistry } from '@repo/active-record';
import type { LayerKind } from '@repo/database';
import { Mock, vi } from 'vitest';
import { OsLayersResolverService } from '../os-layers-resolver.service';

const LAYER_BUILD_ID = 'test-layer-build-id';
const SHA = (n: number) => String(n).padStart(64, '0');

interface FakeLayer {
  id: string;
  slug: string;
  family: string | null;
  kind: LayerKind;
}

interface FakeArtifact {
  id: string;
  layerId: string;
  osDistro: string;
  osCodename: string;
  arch: string;
  variant: string;
  sha256: string;
  url: string;
  compression: string;
}

function layer(slug: string, family: string | null, kind: LayerKind = 'COMPONENT'): FakeLayer {
  return { id: `layer-${slug}`, slug, family, kind };
}

function artifact(
  layerId: string,
  osDistro: string,
  osCodename: string,
  arch: string,
  shaIndex: number,
  compression = 'zstd',
): FakeArtifact {
  return {
    id: `artifact-${layerId}-${osCodename}-${arch}`,
    layerId,
    osDistro,
    osCodename,
    arch,
    variant: '',
    sha256: SHA(shaIndex),
    url: `https://assets.example/blobs/${SHA(shaIndex)}`,
    compression,
  };
}

describe('OsLayersResolverService', () => {
  let service: OsLayersResolverService;
  let mockLayerFindUnique: Mock;
  let mockLayerFindMany: Mock;
  let mockArtifactFindFirst: Mock;
  let mockLogger: { log: Mock; warn: Mock; error: Mock; debug: Mock; verbose: Mock; setContext: Mock };

  beforeEach(async () => {
    mockLayerFindUnique = vi.fn();
    mockLayerFindMany = vi.fn();
    mockArtifactFindFirst = vi.fn();
    mockLogger = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      verbose: vi.fn(),
      setContext: vi.fn().mockReturnThis(),
    };

    ActiveRecordRegistry.configureForTest({
      layer: { findUnique: mockLayerFindUnique, findMany: mockLayerFindMany },
      layerArtifact: { findFirst: mockArtifactFindFirst },
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OsLayersResolverService,
        {
          provide: `LoggerService${OsLayersResolverService.name}`,
          useValue: mockLogger,
        },
      ],
    }).compile();

    service = module.get<OsLayersResolverService>(OsLayersResolverService);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('resolves a base-only stack when no customizations are supplied', async () => {
    const baseLayer = layer('ubuntu-noble-hpc', 'base', 'BASE');
    mockLayerFindUnique.mockResolvedValueOnce(baseLayer);
    mockArtifactFindFirst.mockResolvedValueOnce(artifact(baseLayer.id, 'ubuntu', 'noble', 'amd64', 1));

    const result = await service.resolve({
      layerBuildId: LAYER_BUILD_ID,
      operatingSystemSlug: 'ubuntu-noble-hpc',
      customizationSlugs: [],
      arch: 'amd64',
    });

    expect(result.entries).toEqual([
      { layer: 'ubuntu-noble-hpc', sha256: SHA(1), compression: 'zstd', stack_position: 0 },
    ]);
  });

  it('resolves base + components, scoping component artifacts to the base osDistro/osCodename', async () => {
    const baseLayer = layer('ubuntu-noble-vanilla', 'base', 'BASE');
    const driver = layer('nvidia-driver-580', 'driver');
    const cuda = layer('cuda-12.6', 'runtime');
    const docker = layer('docker', 'platform');

    mockLayerFindUnique.mockResolvedValueOnce(baseLayer);
    mockArtifactFindFirst.mockImplementationOnce(() =>
      Promise.resolve(artifact(baseLayer.id, 'ubuntu', 'noble', 'amd64', 1)),
    );
    mockLayerFindMany.mockResolvedValueOnce([cuda, docker, driver]);
    mockArtifactFindFirst.mockImplementation(({ where }) => {
      if (where.layerId === driver.id) return Promise.resolve(artifact(driver.id, 'ubuntu', 'noble', 'amd64', 2));
      if (where.layerId === cuda.id) return Promise.resolve(artifact(cuda.id, 'ubuntu', 'noble', 'amd64', 3));
      if (where.layerId === docker.id) return Promise.resolve(artifact(docker.id, 'ubuntu', 'noble', 'amd64', 4));
      return Promise.resolve(null);
    });

    const result = await service.resolve({
      layerBuildId: LAYER_BUILD_ID,
      operatingSystemSlug: 'ubuntu-noble-vanilla',
      customizationSlugs: ['cuda-12.6', 'docker', 'nvidia-driver-580'],
      arch: 'amd64',
    });

    expect(result.entries).toEqual([
      { layer: 'ubuntu-noble-vanilla', sha256: SHA(1), compression: 'zstd', stack_position: 0 },
      { layer: 'nvidia-driver-580', sha256: SHA(2), compression: 'zstd', stack_position: 1 },
      { layer: 'cuda-12.6', sha256: SHA(3), compression: 'zstd', stack_position: 2 },
      { layer: 'docker', sha256: SHA(4), compression: 'zstd', stack_position: 3 },
    ]);
  });

  it('passes the base artifact osDistro/osCodename into the component lookup', async () => {
    const baseLayer = layer('debian-bookworm-vanilla', 'base', 'BASE');
    const driver = layer('nvidia-driver-580', 'driver');

    mockLayerFindUnique.mockResolvedValueOnce(baseLayer);
    mockArtifactFindFirst.mockImplementationOnce(() =>
      Promise.resolve(artifact(baseLayer.id, 'debian', 'bookworm', 'amd64', 1)),
    );
    mockLayerFindMany.mockResolvedValueOnce([driver]);
    mockArtifactFindFirst.mockImplementationOnce((args) => {
      expect(args.where).toMatchObject({
        layerId: driver.id,
        arch: 'amd64',
        osDistro: 'debian',
        osCodename: 'bookworm',
      });
      return Promise.resolve(artifact(driver.id, 'debian', 'bookworm', 'amd64', 2));
    });

    await service.resolve({
      layerBuildId: LAYER_BUILD_ID,
      operatingSystemSlug: 'debian-bookworm-vanilla',
      customizationSlugs: ['nvidia-driver-580'],
      arch: 'amd64',
    });
  });

  it('throws when the base Layer row is missing', async () => {
    mockLayerFindUnique.mockResolvedValueOnce(null);

    await expect(
      service.resolve({
        layerBuildId: LAYER_BUILD_ID,
        operatingSystemSlug: 'ubuntu-utopic-vanilla',
        customizationSlugs: [],
        arch: 'amd64',
      }),
    ).rejects.toThrow(/No Layer for OS slug ubuntu-utopic-vanilla/);
  });

  it('throws when the OS-slug Layer is not kind=BASE', async () => {
    mockLayerFindUnique.mockResolvedValueOnce(layer('cuda-12.6', 'runtime', 'COMPONENT'));

    await expect(
      service.resolve({
        layerBuildId: LAYER_BUILD_ID,
        operatingSystemSlug: 'cuda-12.6',
        customizationSlugs: [],
        arch: 'amd64',
      }),
    ).rejects.toThrow(/is not a base layer/);
  });

  it('rejects a LEGACY-kind layer as an OS slug', async () => {
    mockLayerFindUnique.mockResolvedValueOnce(layer('ubuntu-focal-legacy', 'legacy', 'LEGACY'));

    await expect(
      service.resolve({
        layerBuildId: LAYER_BUILD_ID,
        operatingSystemSlug: 'ubuntu-focal-legacy',
        customizationSlugs: [],
        arch: 'amd64',
      }),
    ).rejects.toThrow(/is not a base layer/);
  });

  it('rejects a LEGACY-kind layer as an OS slug', async () => {
    mockLayerFindUnique.mockResolvedValueOnce(layer('centos-legacy', 'legacy', 'LEGACY'));

    await expect(
      service.resolve({
        layerBuildId: LAYER_BUILD_ID,
        operatingSystemSlug: 'centos-legacy',
        customizationSlugs: [],
        arch: 'amd64',
      }),
    ).rejects.toThrow(/is not a base layer/);
  });

  it('throws when a customization slug resolves to a non-COMPONENT layer', async () => {
    const baseLayer = layer('ubuntu-noble-vanilla', 'base', 'BASE');
    const otherBase = layer('ubuntu-jammy-vanilla', 'legacy', 'LEGACY');

    mockLayerFindUnique.mockResolvedValueOnce(baseLayer);
    mockArtifactFindFirst.mockResolvedValueOnce(artifact(baseLayer.id, 'ubuntu', 'noble', 'amd64', 1));
    mockLayerFindMany.mockResolvedValueOnce([otherBase]);

    await expect(
      service.resolve({
        layerBuildId: LAYER_BUILD_ID,
        operatingSystemSlug: 'ubuntu-noble-vanilla',
        customizationSlugs: ['ubuntu-jammy-vanilla'],
        arch: 'amd64',
      }),
    ).rejects.toThrow(/is not a customization layer/);
  });

  it('throws when a requested customization slug is not seeded', async () => {
    const baseLayer = layer('ubuntu-noble-vanilla', 'base', 'BASE');
    mockLayerFindUnique.mockResolvedValueOnce(baseLayer);
    mockArtifactFindFirst.mockResolvedValueOnce(artifact(baseLayer.id, 'ubuntu', 'noble', 'amd64', 1));
    mockLayerFindMany.mockResolvedValueOnce([]);

    await expect(
      service.resolve({
        layerBuildId: LAYER_BUILD_ID,
        operatingSystemSlug: 'ubuntu-noble-vanilla',
        customizationSlugs: ['cuda-12.6'],
        arch: 'amd64',
      }),
    ).rejects.toThrow(/Missing Layer rows for customization slugs: cuda-12\.6/);
  });

  it('throws when no LayerArtifact exists for the base on the requested arch', async () => {
    const baseLayer = layer('ubuntu-noble-vanilla', 'base', 'BASE');
    mockLayerFindUnique.mockResolvedValueOnce(baseLayer);
    mockArtifactFindFirst.mockResolvedValueOnce(null);

    await expect(
      service.resolve({
        layerBuildId: LAYER_BUILD_ID,
        operatingSystemSlug: 'ubuntu-noble-vanilla',
        customizationSlugs: [],
        arch: 'amd64',
      }),
    ).rejects.toThrow(/No LayerArtifact for base layer=ubuntu-noble-vanilla/);
  });

  it('throws BadRequestException for unsupported compression values', async () => {
    const baseLayer = layer('ubuntu-noble-vanilla', 'base', 'BASE');
    mockLayerFindUnique.mockResolvedValueOnce(baseLayer);
    mockArtifactFindFirst.mockResolvedValueOnce(artifact(baseLayer.id, 'ubuntu', 'noble', 'amd64', 1, 'lz4'));

    await expect(
      service.resolve({
        layerBuildId: LAYER_BUILD_ID,
        operatingSystemSlug: 'ubuntu-noble-vanilla',
        customizationSlugs: [],
        arch: 'amd64',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('places layers with unknown family at the end of the stack', async () => {
    const baseLayer = layer('ubuntu-noble-vanilla', 'base', 'BASE');
    const known = layer('nvidia-driver-580', 'driver');
    const unknownFamily = layer('mystery-tool', 'something-not-in-the-tier-list');

    mockLayerFindUnique.mockResolvedValueOnce(baseLayer);
    mockArtifactFindFirst.mockImplementationOnce(() =>
      Promise.resolve(artifact(baseLayer.id, 'ubuntu', 'noble', 'amd64', 1)),
    );
    mockLayerFindMany.mockResolvedValueOnce([unknownFamily, known]);
    mockArtifactFindFirst.mockImplementation(({ where }) =>
      Promise.resolve(artifact(where.layerId, 'ubuntu', 'noble', 'amd64', 1)),
    );

    const result = await service.resolve({
      layerBuildId: LAYER_BUILD_ID,
      operatingSystemSlug: 'ubuntu-noble-vanilla',
      customizationSlugs: ['mystery-tool', 'nvidia-driver-580'],
      arch: 'amd64',
    });

    expect(result.entries.map((r) => r.layer)).toEqual(['ubuntu-noble-vanilla', 'nvidia-driver-580', 'mystery-tool']);
  });

  it('places null-family layers at the end of the stack', async () => {
    const baseLayer = layer('ubuntu-noble-vanilla', 'base', 'BASE');
    const noFamily = layer('orphan', null);

    mockLayerFindUnique.mockResolvedValueOnce(baseLayer);
    mockArtifactFindFirst.mockImplementationOnce(() =>
      Promise.resolve(artifact(baseLayer.id, 'ubuntu', 'noble', 'amd64', 1)),
    );
    mockLayerFindMany.mockResolvedValueOnce([noFamily]);
    mockArtifactFindFirst.mockImplementation(({ where }) =>
      Promise.resolve(artifact(where.layerId, 'ubuntu', 'noble', 'amd64', 1)),
    );

    const result = await service.resolve({
      layerBuildId: LAYER_BUILD_ID,
      operatingSystemSlug: 'ubuntu-noble-vanilla',
      customizationSlugs: ['orphan'],
      arch: 'amd64',
    });

    expect(result.entries.map((r) => r.layer)).toEqual(['ubuntu-noble-vanilla', 'orphan']);
  });
});
