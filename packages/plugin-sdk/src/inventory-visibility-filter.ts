// Process-wide registry (not a lifecycle gate): provision.authorize is a void veto and cannot batch-filter public listings.

export interface InventoryVisibilityFilter {
  /** Return supplier ids to hide; throw or return all ids to fail closed (registry also logs+fails closed). */
  excludeSuppliers(supplierIds: readonly string[]): Promise<readonly string[]>;
}

const filters = new Set<InventoryVisibilityFilter>();

export class InventoryVisibilityFilterRegistry {
  static hasFilters(): boolean {
    return filters.size > 0;
  }

  static register(filter: InventoryVisibilityFilter): () => void {
    filters.add(filter);
    return () => {
      filters.delete(filter);
    };
  }

  static async excludedSupplierIds(supplierIds: readonly string[]): Promise<string[]> {
    if (supplierIds.length === 0 || filters.size === 0) return [];

    const known = new Set(supplierIds);
    const excluded = new Set<string>();
    for (const filter of filters) {
      try {
        const ids = await filter.excludeSuppliers(supplierIds);
        for (const id of ids) {
          if (known.has(id)) excluded.add(id);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[InventoryVisibilityFilterRegistry] filter failed; excluding all given suppliers: ${message}`);
        return [...known];
      }
    }
    return [...excluded];
  }
}

/** Spec teardown. Import from `@hydrahost/plugin-sdk/testing`, not the package root. */
export function resetInventoryVisibilityFiltersForTest(): void {
  filters.clear();
}
