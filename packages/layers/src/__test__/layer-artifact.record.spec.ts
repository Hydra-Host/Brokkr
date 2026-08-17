import { ActiveRecordRegistry } from '@repo/active-record';
import { LayerKind } from '@repo/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LayerArtifactRecord } from '../layer-artifact.record';

const LAYER_BUILD_ID = 'test-layer-build-id';

describe('LayerArtifactRecord', () => {
  const mockDelegate = {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    ActiveRecordRegistry.configureForTest({ layerArtifact: mockDelegate });
  });

  afterEach(() => vi.clearAllMocks());

  describe('findActiveByLayerAndArch', () => {
    it('queries findFirst with layerBuildId, layerId, and arch', async () => {
      mockDelegate.findFirst.mockResolvedValue({ id: 'a-1', arch: 'amd64' });
      const result = await LayerArtifactRecord.findActiveByLayerAndArch(LAYER_BUILD_ID, 'layer-1', 'amd64');
      expect(result).toEqual({ id: 'a-1', arch: 'amd64' });
      expect(mockDelegate.findFirst).toHaveBeenCalledWith({
        where: { layerBuildId: LAYER_BUILD_ID, layerId: 'layer-1', arch: 'amd64' },
      });
    });

    it('returns null when no active artifact exists', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      const result = await LayerArtifactRecord.findActiveByLayerAndArch(LAYER_BUILD_ID, 'layer-x', 'arm64');
      expect(result).toBeNull();
    });
  });

  describe('findActiveByLayerArchAndOs', () => {
    it('includes layerBuildId, osDistro, and osCodename in the where clause', async () => {
      mockDelegate.findFirst.mockResolvedValue({ id: 'a-2' });
      const result = await LayerArtifactRecord.findActiveByLayerArchAndOs({
        layerBuildId: LAYER_BUILD_ID,
        layerId: 'layer-1',
        arch: 'amd64',
        osDistro: 'ubuntu',
        osCodename: 'noble',
      });
      expect(result).toEqual({ id: 'a-2' });
      expect(mockDelegate.findFirst).toHaveBeenCalledWith({
        where: {
          layerBuildId: LAYER_BUILD_ID,
          layerId: 'layer-1',
          arch: 'amd64',
          osDistro: 'ubuntu',
          osCodename: 'noble',
        },
      });
    });
  });

  describe('findActiveComponentsForOsPairs', () => {
    it('short-circuits to [] without querying when slugs is empty', async () => {
      const result = await LayerArtifactRecord.findActiveComponentsForOsPairs({
        layerBuildId: LAYER_BUILD_ID,
        slugs: [],
        osPairs: [{ osDistro: 'ubuntu', osCodename: 'noble' }],
        arch: 'amd64',
      });
      expect(result).toEqual([]);
      expect(mockDelegate.findMany).not.toHaveBeenCalled();
    });

    it('short-circuits to [] without querying when osPairs is empty', async () => {
      const result = await LayerArtifactRecord.findActiveComponentsForOsPairs({
        layerBuildId: LAYER_BUILD_ID,
        slugs: ['cuda-12.6'],
        osPairs: [],
        arch: 'amd64',
      });
      expect(result).toEqual([]);
      expect(mockDelegate.findMany).not.toHaveBeenCalled();
    });

    it('scopes by layerBuildId, arch, COMPONENT kind, slug.in, and an OR of OS-pair tuples', async () => {
      mockDelegate.findMany.mockResolvedValue([{ layer: { slug: 'cuda-12.6' } }]);
      await LayerArtifactRecord.findActiveComponentsForOsPairs({
        layerBuildId: LAYER_BUILD_ID,
        slugs: ['cuda-12.6', 'docker'],
        osPairs: [
          { osDistro: 'ubuntu', osCodename: 'noble' },
          { osDistro: 'ubuntu', osCodename: 'jammy' },
        ],
        arch: 'arm64',
      });
      const args = mockDelegate.findMany.mock.calls[0][0] as { where: Record<string, unknown> };
      expect(args.where).toMatchObject({
        layerBuildId: LAYER_BUILD_ID,
        arch: 'arm64',
        layer: { kind: LayerKind.COMPONENT, slug: { in: ['cuda-12.6', 'docker'] } },
        OR: [
          { osDistro: 'ubuntu', osCodename: 'noble' },
          { osDistro: 'ubuntu', osCodename: 'jammy' },
        ],
      });
    });
  });

  describe('findRequiresRelatedSlugs', () => {
    it('deduplicates related slugs across artifacts', async () => {
      mockDelegate.findMany.mockResolvedValue([
        { relations: [{ relatedLayer: { slug: 'nvidia-driver-580' } }] },
        {
          relations: [{ relatedLayer: { slug: 'nvidia-driver-580' } }, { relatedLayer: { slug: 'nvidia-driver-595' } }],
        },
      ]);

      const result = await LayerArtifactRecord.findRequiresRelatedSlugs({
        layerBuildId: LAYER_BUILD_ID,
        selectorSlug: 'cuda-12.6',
        osDistro: 'ubuntu',
        osCodename: 'noble',
        relatedSlugPrefix: 'nvidia-driver-',
      });
      expect(result.sort()).toEqual(['nvidia-driver-580', 'nvidia-driver-595']);
    });

    it('threads arch into the where clause when provided', async () => {
      mockDelegate.findMany.mockResolvedValue([]);
      await LayerArtifactRecord.findRequiresRelatedSlugs({
        layerBuildId: LAYER_BUILD_ID,
        selectorSlug: 'pytorch-cu130',
        osDistro: 'ubuntu',
        osCodename: 'noble',
        arch: 'amd64',
        relatedSlugPrefix: 'cuda-',
      });
      const args = mockDelegate.findMany.mock.calls[0][0] as Record<string, unknown>;
      expect(args.where).toMatchObject({ layerBuildId: LAYER_BUILD_ID, arch: 'amd64' });
    });

    it('omits arch from the where clause when null', async () => {
      mockDelegate.findMany.mockResolvedValue([]);
      await LayerArtifactRecord.findRequiresRelatedSlugs({
        layerBuildId: LAYER_BUILD_ID,
        selectorSlug: 'pytorch-cu130',
        osDistro: 'ubuntu',
        osCodename: 'noble',
        arch: null,
        relatedSlugPrefix: 'cuda-',
      });
      const args = mockDelegate.findMany.mock.calls[0][0] as Record<string, unknown>;
      expect(args.where).toMatchObject({
        layerBuildId: LAYER_BUILD_ID,
        osDistro: 'ubuntu',
        osCodename: 'noble',
      });
      expect(args.where).not.toHaveProperty('arch');
    });

    it('returns an empty array when no artifacts have matching REQUIRES relations', async () => {
      mockDelegate.findMany.mockResolvedValue([{ relations: [] }]);
      const result = await LayerArtifactRecord.findRequiresRelatedSlugs({
        layerBuildId: LAYER_BUILD_ID,
        selectorSlug: 'cuda-12.6',
        osDistro: 'ubuntu',
        osCodename: 'noble',
        relatedSlugPrefix: 'nvidia-driver-',
      });
      expect(result).toEqual([]);
    });
  });
});
