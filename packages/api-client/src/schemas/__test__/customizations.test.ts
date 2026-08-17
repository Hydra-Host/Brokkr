import { describe, expect, it } from 'vitest';
import { ServerSchema } from '../baremetal';
import { BaseLayerSchema, availableLayersFields } from '../customizations';
import { DeploymentSchema } from '../deployments';
import { InventoryListingSchema } from '../inventory';

describe('BaseLayerSchema', () => {
  const validBase = {
    id: 'layer-123',
    slug: 'ubuntu-noble-vanilla',
    name: 'Ubuntu Noble',
    family: 'base',
  };

  it('accepts a valid base layer', () => {
    expect(BaseLayerSchema.safeParse(validBase).success).toBe(true);
  });

  it('accepts null family', () => {
    const result = BaseLayerSchema.safeParse({ ...validBase, family: null });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.family).toBeNull();
    }
  });

  it('rejects a payload missing a required string field', () => {
    const { slug: _, ...noSlug } = validBase;
    expect(BaseLayerSchema.safeParse(noSlug).success).toBe(false);
  });

  it('strips unknown keys', () => {
    const result = BaseLayerSchema.safeParse({ ...validBase, kind: 'COMPONENT' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('kind');
    }
  });
});

describe('availableLayersFields spread parity', () => {
  const catalogKeys = Object.keys(availableLayersFields).sort();

  it.each([
    ['ServerSchema', ServerSchema],
    ['DeploymentSchema', DeploymentSchema],
    ['InventoryListingSchema', InventoryListingSchema],
  ] as const)('%s contains the catalog fields', (_name, schema) => {
    const shapeKeys = Object.keys(schema.shape);
    for (const key of catalogKeys) {
      expect(shapeKeys).toContain(key);
    }
  });

  it('all three schemas share the same Zod instance for each catalog field', () => {
    for (const key of catalogKeys) {
      const serverField = ServerSchema.shape[key as keyof typeof ServerSchema.shape];
      const deploymentField = DeploymentSchema.shape[key as keyof typeof DeploymentSchema.shape];
      const inventoryField = InventoryListingSchema.shape[key as keyof typeof InventoryListingSchema.shape];

      expect(deploymentField).toBe(serverField);
      expect(inventoryField).toBe(serverField);
    }
  });
});
