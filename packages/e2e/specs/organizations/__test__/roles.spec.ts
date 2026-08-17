import type { Page } from '@playwright/test';
import { expect, test } from '../../../fixtures/auth.fixture.js';

const TAG_PERMISSION_KEYS = ['tag:create', 'tag:delete', 'tag:read', 'tag:update'];

const clickTagPermissionGroup = async (page: Page): Promise<void> => {
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('checkbox', { name: /^(Select|Clear) all tag permissions$/ }).click();
};

test.describe('Organization RBAC Roles', () => {
  test('should display system roles on the roles list', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;
    const ts = Date.now();

    const customRole = await db.prisma.organizationMemberRole.create({
      data: {
        name: `e2e-list-role-${ts}`,
        slug: `e2e-list-role-${ts}`,
        description: 'Custom role for list test',
        organizationId: seedData.organization.id,
      },
    });

    try {
      await page.goto('/organizations/roles');

      await expect(page.getByRole('heading', { name: 'Roles & Permissions' })).toBeVisible();
      await expect(page.getByText('Manage system and custom roles for your organization.')).toBeVisible();
      await expect(page.getByText('System Roles', { exact: true })).toBeVisible();
      await expect(page.getByText('Owner', { exact: true }).first()).toBeVisible();
      await expect(page.getByText('Admin', { exact: true }).first()).toBeVisible();
      await expect(page.getByText('Member', { exact: true }).first()).toBeVisible();

      await expect(page.getByText('Custom Roles', { exact: true })).toBeVisible();
      await expect(page.getByText(customRole.name, { exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Create Custom Role' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'View All Permissions' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Clone' }).first()).toBeVisible();
      await expect(page.getByRole('link', { name: 'Edit' }).first()).toBeVisible();
      await expect(page.getByRole('link', { name: 'Archive' }).first()).toBeVisible();
    } finally {
      await db.prisma.organizationMemberRole.deleteMany({ where: { id: customRole.id } });
    }
  });

  test('should render the permissions matrix', async ({ authenticatedPage }) => {
    const page = authenticatedPage;

    await page.goto('/organizations/roles/permissions');

    await expect(page.getByRole('heading', { name: 'All Permissions' })).toBeVisible();
    await expect(page.getByText('Reference of all available permissions that can be assigned to roles.')).toBeVisible();

    await expect(page.getByText('member:change-role')).toBeVisible();
    await expect(page.getByText('Change a member role', { exact: true })).toBeVisible();
    await expect(page.getByText('organization:delete')).toBeVisible();
    await expect(page.getByText('Delete the organization', { exact: true })).toBeVisible();
  });

  test('should create a custom role with selected permissions', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;
    const ts = Date.now();
    const roleName = `E2E Create Role ${ts}`;
    const roleSlug = `e2e-create-role-${ts}`;

    try {
      await page.goto('/organizations/roles/create');
      await expect(page.getByRole('heading', { name: 'Create Custom Role' })).toBeVisible();

      await page.getByLabel('Role Name').fill(roleName);
      await expect(page.getByLabel('Slug')).toHaveValue(roleSlug);
      await page.getByLabel('Description').fill('Created by E2E test');

      await expect(page.getByText('Permissions (0 selected)')).toBeVisible();
      await clickTagPermissionGroup(page);
      await expect(page.getByText('Permissions (4 selected)')).toBeVisible();

      await page.getByRole('button', { name: 'Create Role' }).click();

      await page.waitForURL(/\/organizations\/roles$/);

      const role = await db.prisma.organizationMemberRole.findUnique({
        where: { slug_organizationId: { slug: roleSlug, organizationId: seedData.organization.id } },
        include: { rolePermissions: { include: { permission: true } } },
      });
      expect(role).not.toBeNull();
      expect(role!.name).toBe(roleName);
      expect(role!.isSystem).toBe(false);
      expect(role!.description).toBe('Created by E2E test');
      const grantedKeys = role!.rolePermissions.map((rp) => `${rp.permission.resource}:${rp.permission.action}`).sort();
      expect(grantedKeys).toEqual(TAG_PERMISSION_KEYS);
    } finally {
      await db.prisma.organizationMemberRole.deleteMany({
        where: { slug: roleSlug, organizationId: seedData.organization.id },
      });
    }
  });

  test('should require at least one permission when creating a role', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;
    const ts = Date.now();
    const roleName = `E2E Empty Role ${ts}`;
    const roleSlug = `e2e-empty-role-${ts}`;

    await page.goto('/organizations/roles/create');
    await expect(page.getByRole('heading', { name: 'Create Custom Role' })).toBeVisible();

    await page.getByLabel('Role Name').fill(roleName);
    await page.getByRole('button', { name: 'Create Role' }).click();

    await expect(page.getByText('Select at least one permission')).toBeVisible();
    await expect(page).toHaveURL(/\/organizations\/roles\/create/);

    const role = await db.prisma.organizationMemberRole.findUnique({
      where: { slug_organizationId: { slug: roleSlug, organizationId: seedData.organization.id } },
    });
    expect(role).toBeNull();
  });

  test('should reject an invalid slug when creating a role', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;
    const ts = Date.now();
    const roleName = `E2E Bad Slug ${ts}`;

    await page.goto('/organizations/roles/create');
    await expect(page.getByRole('heading', { name: 'Create Custom Role' })).toBeVisible();

    await page.getByLabel('Role Name').fill(roleName);
    await page.getByLabel('Slug').fill('Invalid Slug!');
    await page.getByRole('button', { name: 'Create Role' }).click();

    await expect(page.getByText('Slug must be lowercase alphanumeric with hyphens')).toBeVisible();

    const role = await db.prisma.organizationMemberRole.findFirst({
      where: { name: roleName, organizationId: seedData.organization.id },
    });
    expect(role).toBeNull();
  });

  test('should edit a custom role permission set', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;
    const ts = Date.now();

    const tagRead = await db.prisma.permission.findUnique({
      where: { resource_action: { resource: 'tag', action: 'read' } },
    });
    expect(tagRead).not.toBeNull();

    const role = await db.prisma.organizationMemberRole.create({
      data: {
        name: `e2e-edit-role-${ts}`,
        slug: `e2e-edit-role-${ts}`,
        organizationId: seedData.organization.id,
        rolePermissions: { create: [{ permissionId: tagRead!.id }] },
      },
    });

    try {
      await page.goto(`/organizations/roles/edit/${role.id}`);
      await expect(page.getByRole('heading', { name: `Edit Role: ${role.name}` })).toBeVisible();

      await expect(page.getByText('Permissions (1 selected)')).toBeVisible();

      await clickTagPermissionGroup(page);
      await expect(page.getByText('Permissions (4 selected)')).toBeVisible();

      await page.getByRole('button', { name: 'Save Changes' }).click();

      await page.waitForURL(/\/organizations\/roles$/);

      const updated = await db.prisma.organizationMemberRole.findUnique({
        where: { id: role.id },
        include: { rolePermissions: { include: { permission: true } } },
      });
      expect(updated).not.toBeNull();
      const grantedKeys = updated!.rolePermissions
        .map((rp) => `${rp.permission.resource}:${rp.permission.action}`)
        .sort();
      expect(grantedKeys).toEqual(TAG_PERMISSION_KEYS);
    } finally {
      await db.prisma.organizationMemberRole.deleteMany({ where: { id: role.id } });
    }
  });

  test('should archive a custom role', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;
    const ts = Date.now();

    const role = await db.prisma.organizationMemberRole.create({
      data: {
        name: `e2e-archive-role-${ts}`,
        slug: `e2e-archive-role-${ts}`,
        organizationId: seedData.organization.id,
      },
    });

    try {
      await page.goto(`/organizations/roles/edit/${role.id}?action=archive`);

      await expect(
        page.getByText(
          `Archive "${role.name}"? It will no longer be available for assignment, while historical records will retain its name.`,
        ),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Archive Role' }).click();

      await page.waitForURL(/\/organizations\/roles$/);

      const archived = await db.prisma.organizationMemberRole.findUnique({ where: { id: role.id } });
      expect(archived).not.toBeNull();
      expect(archived!.archivedAt).not.toBeNull();
    } finally {
      await db.prisma.organizationMemberRole.deleteMany({ where: { id: role.id } });
    }
  });

  test('should not allow editing a system role', async ({ authenticatedPage, db }) => {
    const page = authenticatedPage;

    const ownerRole = await db.prisma.organizationMemberRole.findFirst({
      where: { slug: 'owner', isSystem: true, organizationId: null },
    });
    expect(ownerRole).not.toBeNull();

    await page.goto(`/organizations/roles/edit/${ownerRole!.id}`);

    await expect(page.getByRole('heading', { name: 'Cannot Edit System Role' })).toBeVisible();
    await expect(
      page.getByText('System roles cannot be modified. Clone this role to create a customizable version.'),
    ).toBeVisible();
  });
});
