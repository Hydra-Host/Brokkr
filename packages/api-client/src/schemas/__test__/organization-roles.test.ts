import { describe, expect, it } from 'vitest';
import { OrganizationMemberRoleSchema } from '../organization-roles';

describe('OrganizationMemberRoleSchema', () => {
  it('requires active member and pending invitation counts for archive controls', () => {
    const role = {
      id: 'role-1',
      name: 'Billing',
      slug: 'billing',
      description: null,
      isSystem: false,
      isOwnerCapable: false,
      organizationId: 'org-1',
      templateId: null,
      rolePermissions: [],
      _count: { members: 0, invitations: 2 },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    expect(OrganizationMemberRoleSchema.parse(role)._count).toEqual({ members: 0, invitations: 2 });
    expect(() =>
      OrganizationMemberRoleSchema.parse({
        ...role,
        _count: { members: 0 },
      }),
    ).toThrow();
  });
});
