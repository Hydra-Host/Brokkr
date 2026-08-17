import { describe, expect, it } from 'vitest';

import { isOwnerCapable, OWNER_MANAGEMENT_PERMISSION, strictlyDominates, type PermissionDefinition } from '../rbac';

const catalog: PermissionDefinition[] = [
  { resource: 'organization', action: 'manage-owners', description: '' },
  { resource: 'member', action: 'read', description: '' },
  { resource: 'member', action: 'change-role', description: '' },
];

describe('permission-set authority', () => {
  it('allows only a strict superset to manage another member', () => {
    expect(strictlyDominates(catalog, ['member:read', 'member:change-role'], ['member:read'])).toBe(true);
    expect(strictlyDominates(catalog, ['member:read'], ['member:read'])).toBe(false);
    expect(strictlyDominates(catalog, ['member:read'], ['member:change-role'])).toBe(false);
    expect(strictlyDominates(catalog, ['member:read'], ['member:read', 'member:change-role'])).toBe(false);
  });

  it('ignores permissions outside the configured catalog', () => {
    expect(strictlyDominates(catalog, ['member:read', 'external:admin'], ['member:read'])).toBe(false);
  });

  it('requires every configured key for owner capability', () => {
    const full = catalog.map(({ resource, action }) => `${resource}:${action}`);
    expect(isOwnerCapable(catalog, full)).toBe(true);
    expect(
      isOwnerCapable(
        catalog,
        full.filter((key) => key !== OWNER_MANAGEMENT_PERMISSION),
      ),
    ).toBe(false);
  });

  it('fails closed when the permission catalog is empty', () => {
    expect(isOwnerCapable([], [])).toBe(false);
    expect(isOwnerCapable([], [OWNER_MANAGEMENT_PERMISSION])).toBe(false);
  });

  it('treats a composed full catalog as owner-capable in both catalog contexts', () => {
    const adminCatalog = [...catalog, { resource: 'admin.users', action: 'read', description: '' }];
    const localAdmin = adminCatalog.map(({ resource, action }) => `${resource}:${action}`);
    expect(isOwnerCapable(catalog, localAdmin)).toBe(true);
    expect(isOwnerCapable(adminCatalog, localAdmin)).toBe(true);
  });
});
