import { ActiveRecordRegistry } from '@repo/active-record';
import { LayerKind } from '@repo/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LayerRecord } from '../layer.record';

const LAYER_BUILD_ID = 'test-layer-build-id';

describe('LayerRecord', () => {
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
    ActiveRecordRegistry.configureForTest({ layer: mockDelegate });
  });

  afterEach(() => vi.clearAllMocks());

  describe('findAllKindsBySlug', () => {
    it('returns a Map of every slug to its kind', async () => {
      mockDelegate.findMany.mockResolvedValue([
        { slug: 'ubuntu-noble', kind: LayerKind.BASE },
        { slug: 'cuda-12.6', kind: LayerKind.COMPONENT },
        { slug: 'debian-bookworm-hpc', kind: LayerKind.LEGACY },
      ]);

      const map = await LayerRecord.findAllKindsBySlug();
      expect(map.size).toBe(3);
      expect(map.get('ubuntu-noble')).toBe(LayerKind.BASE);
      expect(map.get('cuda-12.6')).toBe(LayerKind.COMPONENT);
      expect(map.get('debian-bookworm-hpc')).toBe(LayerKind.LEGACY);
    });

    it('returns an empty Map when no layers are seeded', async () => {
      mockDelegate.findMany.mockResolvedValue([]);
      const map = await LayerRecord.findAllKindsBySlug();
      expect(map.size).toBe(0);
    });
  });

  describe('findBaseLayerSummaries', () => {
    it('returns BASE-only summaries projected and ordered by slug (legacy excluded)', async () => {
      mockDelegate.findMany.mockResolvedValue([
        { id: 'l-1', slug: 'ubuntu-noble', name: 'Ubuntu Noble', family: 'base' },
      ]);
      const result = await LayerRecord.findBaseLayerSummaries();
      expect(result).toHaveLength(1);
      expect(mockDelegate.findMany).toHaveBeenCalledWith({
        where: { kind: LayerKind.BASE },
        select: { id: true, slug: true, name: true, family: true },
        orderBy: { slug: 'asc' },
      });
    });
  });

  describe('findBaseLayersWithOsSample', () => {
    it('returns each base paired with one active-artifact OS sample, null when absent', async () => {
      mockDelegate.findMany.mockResolvedValue([
        { slug: 'ubuntu-noble', artifacts: [{ osDistro: 'ubuntu', osCodename: 'noble', osVersion: '24.04' }] },
        { slug: 'orphaned-base', artifacts: [] },
      ]);

      const result = await LayerRecord.findBaseLayersWithOsSample(LAYER_BUILD_ID);
      expect(result).toEqual([
        { slug: 'ubuntu-noble', sample: { osDistro: 'ubuntu', osCodename: 'noble', osVersion: '24.04' } },
        { slug: 'orphaned-base', sample: null },
      ]);
    });

    it('orders the sampled artifact deterministically so it matches findBaseOsSampleBySlug', async () => {
      mockDelegate.findMany.mockResolvedValue([]);
      await LayerRecord.findBaseLayersWithOsSample(LAYER_BUILD_ID);
      const args = mockDelegate.findMany.mock.calls[0][0] as {
        select: { artifacts: { where: unknown; orderBy: unknown } };
      };
      expect(args.select.artifacts.where).toEqual({ layerBuildId: LAYER_BUILD_ID });
      expect(args.select.artifacts.orderBy).toEqual([{ osDistro: 'asc' }, { osCodename: 'asc' }]);
    });
  });

  describe('findBaseOsSampleBySlug', () => {
    it('returns the sample OS pair for a base slug, ordered to match the catalog', async () => {
      mockDelegate.findUnique.mockResolvedValue({
        artifacts: [{ osDistro: 'ubuntu', osCodename: 'jammy', osVersion: '22.04' }],
      });

      const result = await LayerRecord.findBaseOsSampleBySlug('ubuntu-22.04', LAYER_BUILD_ID);
      expect(result).toEqual({ osDistro: 'ubuntu', osCodename: 'jammy', osVersion: '22.04' });
      const args = mockDelegate.findUnique.mock.calls[0][0] as {
        select: { artifacts: { where: unknown; orderBy: unknown } };
      };
      expect(args.select.artifacts.where).toEqual({ layerBuildId: LAYER_BUILD_ID });
      expect(args.select.artifacts.orderBy).toEqual([{ osDistro: 'asc' }, { osCodename: 'asc' }]);
    });

    it('returns null when the layer has no active artifacts', async () => {
      mockDelegate.findUnique.mockResolvedValue({ artifacts: [] });
      const result = await LayerRecord.findBaseOsSampleBySlug('orphan', LAYER_BUILD_ID);
      expect(result).toBeNull();
    });

    it('returns null when no layer exists for the slug', async () => {
      mockDelegate.findUnique.mockResolvedValue(null);
      const result = await LayerRecord.findBaseOsSampleBySlug('missing', LAYER_BUILD_ID);
      expect(result).toBeNull();
    });
  });

  describe('findBySlug', () => {
    it('returns the full Layer row for a slug', async () => {
      const row = {
        id: 'l-1',
        slug: 'ubuntu-noble',
        name: 'Ubuntu Noble',
        family: 'base',
        kind: LayerKind.BASE,
        layerGroupId: 'g-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockDelegate.findUnique.mockResolvedValue(row);
      const result = await LayerRecord.findBySlug('ubuntu-noble');
      expect(result).toEqual(row);
    });

    it('returns null when slug is unknown', async () => {
      mockDelegate.findUnique.mockResolvedValue(null);
      const result = await LayerRecord.findBySlug('missing');
      expect(result).toBeNull();
    });
  });

  describe('findBySlugIn', () => {
    it('short-circuits on an empty input array', async () => {
      const result = await LayerRecord.findBySlugIn([]);
      expect(result).toEqual([]);
      expect(mockDelegate.findMany).not.toHaveBeenCalled();
    });

    it('queries with slug.in for non-empty arrays', async () => {
      mockDelegate.findMany.mockResolvedValue([{ slug: 'cuda-12.6' }, { slug: 'docker' }]);
      const result = await LayerRecord.findBySlugIn(['cuda-12.6', 'docker']);
      expect(result).toHaveLength(2);
      expect(mockDelegate.findMany).toHaveBeenCalledWith({
        where: { slug: { in: ['cuda-12.6', 'docker'] } },
      });
    });
  });
});
