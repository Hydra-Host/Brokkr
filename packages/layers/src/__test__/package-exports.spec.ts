import { describe, expect, it } from 'vitest';
import * as layers from '../index';

describe('@repo/layers public exports', () => {
  it('re-exports the symbols apps/api and apps/admin-api import', () => {
    expect(layers.LAYER_SLUGS).toBeDefined();
    expect(typeof layers.hardwareEligibleLayerSlugs).toBe('function');
    expect(typeof layers.resolveEffectiveBuild).toBe('function');
    expect(typeof layers.resolveZoneBuildId).toBe('function');
    expect(typeof layers.hydrateCustomizationCatalogs).toBe('function');
    expect(typeof layers.buildCustomizationCatalog).toBe('function');
    expect(typeof layers.emptyCustomizationCatalog).toBe('function');
    expect(layers.LayerRecord).toBeDefined();
    expect(layers.LayerArtifactRecord).toBeDefined();
    expect(layers.LayerBuildRecord).toBeDefined();
    expect(layers.PlatformSettingsRecord).toBeDefined();
  });
});
