import { describe, expect, it } from 'vitest';
import { buildPrunableLayerFilter, buildReferencedLayerFilter } from '../layers/prune-filters';

describe('seed-from-manifest prune filters', () => {
  const keepSlugs = ['ubuntu-noble', 'brokkr-discovery'];

  describe('buildPrunableLayerFilter', () => {
    it('excludes layers referenced by deploymentLayers', () => {
      const filter = buildPrunableLayerFilter(keepSlugs);
      expect(filter).toHaveProperty('deploymentLayers', { none: {} });
    });

    it('excludes layers referenced as a base OS (Deployment.baseLayerId)', () => {
      const filter = buildPrunableLayerFilter(keepSlugs);
      expect(filter).toHaveProperty('baseDeployments', { none: {} });
    });

    it('excludes layers referenced as a rescue OS (Deployment.rescueLayerId)', () => {
      const filter = buildPrunableLayerFilter(keepSlugs);
      expect(filter).toHaveProperty('rescueDeployments', { none: {} });
    });

    it('filters out keepSlugs', () => {
      const filter = buildPrunableLayerFilter(keepSlugs);
      expect(filter.slug).toEqual({ notIn: keepSlugs });
    });

    it('requires ALL three relation guards (AND semantics)', () => {
      const filter = buildPrunableLayerFilter(keepSlugs);
      expect(Object.keys(filter)).toEqual(
        expect.arrayContaining(['slug', 'deploymentLayers', 'baseDeployments', 'rescueDeployments']),
      );
      expect(filter).not.toHaveProperty('OR');
    });
  });

  describe('buildReferencedLayerFilter', () => {
    it('returns exact OR-semantics shape with all three relation branches', () => {
      expect(buildReferencedLayerFilter(keepSlugs)).toEqual({
        slug: { notIn: keepSlugs },
        OR: [
          { deploymentLayers: { some: {} } },
          { baseDeployments: { some: {} } },
          { rescueDeployments: { some: {} } },
        ],
      });
    });
  });
});
