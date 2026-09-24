import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  InventoryVisibilityFilterRegistry,
  type InventoryVisibilityFilter,
} from '../inventory-visibility-filter';
import { resetInventoryVisibilityFiltersForTest } from '../testing';
import * as pluginSdk from '../index';

afterEach(() => {
  resetInventoryVisibilityFiltersForTest();
});

describe('InventoryVisibilityFilterRegistry', () => {
  it('does not export reset helpers from the public package root', () => {
    expect('resetInventoryVisibilityFiltersForTest' in pluginSdk).toBe(false);
    expect(InventoryVisibilityFilterRegistry).not.toHaveProperty('reset');
    expect(InventoryVisibilityFilterRegistry).not.toHaveProperty('__resetForTest');
  });

  it('returns no exclusions when no filter is registered', async () => {
    expect(InventoryVisibilityFilterRegistry.hasFilters()).toBe(false);
    await expect(InventoryVisibilityFilterRegistry.excludedSupplierIds(['org-a', 'org-b'])).resolves.toEqual([]);
  });

  it('returns no exclusions for an empty supplier id list', async () => {
    InventoryVisibilityFilterRegistry.register({
      excludeSuppliers: async () => ['org-a'],
    });

    await expect(InventoryVisibilityFilterRegistry.excludedSupplierIds([])).resolves.toEqual([]);
  });

  it('unions exclusions from every registered filter', async () => {
    InventoryVisibilityFilterRegistry.register({
      excludeSuppliers: async (ids) => ids.filter((id) => id === 'org-a'),
    });
    InventoryVisibilityFilterRegistry.register({
      excludeSuppliers: async (ids) => ids.filter((id) => id === 'org-b'),
    });

    const excluded = await InventoryVisibilityFilterRegistry.excludedSupplierIds(['org-a', 'org-b', 'org-c']);
    expect(excluded.sort()).toEqual(['org-a', 'org-b']);
  });

  it('ignores supplier ids the filter did not receive', async () => {
    InventoryVisibilityFilterRegistry.register({
      excludeSuppliers: async () => ['org-other'],
    });

    await expect(InventoryVisibilityFilterRegistry.excludedSupplierIds(['org-a'])).resolves.toEqual([]);
  });

  it('fail-closes by excluding every given id when a filter throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    InventoryVisibilityFilterRegistry.register({
      excludeSuppliers: async () => {
        throw new Error('lookup failed');
      },
    });

    await expect(InventoryVisibilityFilterRegistry.excludedSupplierIds(['org-a', 'org-b'])).resolves.toEqual([
      'org-a',
      'org-b',
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[InventoryVisibilityFilterRegistry]'),
    );
    warn.mockRestore();
  });

  it('unregister removes the filter', async () => {
    const filter: InventoryVisibilityFilter = {
      excludeSuppliers: async (ids) => ids,
    };
    const unregister = InventoryVisibilityFilterRegistry.register(filter);

    await expect(InventoryVisibilityFilterRegistry.excludedSupplierIds(['org-a'])).resolves.toEqual(['org-a']);
    unregister();
    expect(InventoryVisibilityFilterRegistry.hasFilters()).toBe(false);
    await expect(InventoryVisibilityFilterRegistry.excludedSupplierIds(['org-a'])).resolves.toEqual([]);
  });
});
