import {
  AuthOrganizationSchema,
  CreateInvitationRequestSchema,
  GrantOwnerAccessRequestSchema,
  InvitationSchema,
  OrganizationSchema,
  RevokeOwnerAccessRequestSchema,
  TransferOwnershipRequestSchema,
} from '../index';

describe('public OrganizationSchema (barrel re-export)', () => {
  const contractShaped = {
    id: 'org-1',
    name: 'Acme',
    tenantType: 'DemandCustomer',
    logo: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: null,
  };

  it('accepts the contract shape (tenantType) and strips slug', () => {
    expect(OrganizationSchema.safeParse(contractShaped).success).toBe(true);
    expect(OrganizationSchema.parse(contractShaped)).not.toHaveProperty('slug');
  });

  it('rejects a slug-only org that omits the required tenantType', () => {
    const slugOnly = {
      id: 'org-1',
      name: 'Acme',
      slug: 'acme',
      logo: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(OrganizationSchema.safeParse(slugOnly).success).toBe(false);
  });
});

describe('AuthOrganizationSchema', () => {
  it('remains the Better-Auth shape (has slug)', () => {
    const authShaped = {
      id: 'org-1',
      name: 'Acme',
      slug: 'acme',
      logo: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(AuthOrganizationSchema.safeParse(authShaped).success).toBe(true);
  });
});

describe('InvitationSchema', () => {
  it('preserves the derived role display name and required role ID', () => {
    const invitation = InvitationSchema.parse({
      id: 'inv-1',
      email: 'invitee@example.com',
      inviterId: 'user-1',
      organizationId: 'org-1',
      role: 'Billing Manager',
      roleId: 'role-billing',
      status: 'pending',
      createdAt: new Date(),
      expiresAt: new Date(),
    });

    expect(invitation).toMatchObject({ role: 'Billing Manager', roleId: 'role-billing' });
  });

  it('accepts a redacted role with a null role ID', () => {
    expect(
      InvitationSchema.parse({
        id: 'inv-1',
        email: 'invitee@example.com',
        inviterId: 'user-1',
        organizationId: 'org-1',
        role: 'Managed role',
        roleId: null,
        status: 'pending',
        createdAt: new Date(),
        expiresAt: new Date(),
      }),
    ).toMatchObject({ role: 'Managed role', roleId: null });
  });

  it('rejects an omitted role ID', () => {
    const result = InvitationSchema.safeParse({
      id: 'inv-1',
      email: 'invitee@example.com',
      inviterId: 'user-1',
      organizationId: 'org-1',
      role: 'member',
      status: 'pending',
      createdAt: new Date(),
      expiresAt: new Date(),
    });

    expect(result.success).toBe(false);
  });
});

describe('CreateInvitationRequestSchema', () => {
  it('accepts a role ID', () => {
    expect(CreateInvitationRequestSchema.parse({ email: 'invitee@example.com', roleId: 'role-billing' })).toEqual({
      email: 'invitee@example.com',
      roleId: 'role-billing',
    });
  });

  it('rejects the legacy role slug input', () => {
    expect(CreateInvitationRequestSchema.safeParse({ email: 'invitee@example.com', role: 'member' }).success).toBe(
      false,
    );
  });
});

describe('ownership request schemas', () => {
  const transferRequest = {
    sourceMemberId: 'source-member',
    recipientMemberId: 'recipient-member',
    ownerRoleId: 'owner-role',
    sourceReplacementRoleId: 'replacement-role',
  };

  it.each([
    [GrantOwnerAccessRequestSchema, { roleId: 'owner-role' }],
    [RevokeOwnerAccessRequestSchema, { replacementRoleId: 'member-role' }],
    [TransferOwnershipRequestSchema, transferRequest],
  ])('accepts valid request IDs', (schema, request) => {
    expect(schema.safeParse(request).success).toBe(true);
  });

  it.each([
    [GrantOwnerAccessRequestSchema, { roleId: '' }],
    [RevokeOwnerAccessRequestSchema, { replacementRoleId: '' }],
    ...Object.keys(transferRequest).map((field) => [
      TransferOwnershipRequestSchema,
      { ...transferRequest, [field]: '' },
    ]),
  ])('rejects an empty request ID', (schema, request) => {
    expect(schema.safeParse(request).success).toBe(false);
  });

  it.each([
    [GrantOwnerAccessRequestSchema, {}],
    [RevokeOwnerAccessRequestSchema, {}],
    [
      TransferOwnershipRequestSchema,
      {
        recipientMemberId: transferRequest.recipientMemberId,
        ownerRoleId: transferRequest.ownerRoleId,
        sourceReplacementRoleId: transferRequest.sourceReplacementRoleId,
      },
    ],
    [
      TransferOwnershipRequestSchema,
      {
        sourceMemberId: transferRequest.sourceMemberId,
        ownerRoleId: transferRequest.ownerRoleId,
        sourceReplacementRoleId: transferRequest.sourceReplacementRoleId,
      },
    ],
    [
      TransferOwnershipRequestSchema,
      {
        sourceMemberId: transferRequest.sourceMemberId,
        recipientMemberId: transferRequest.recipientMemberId,
        sourceReplacementRoleId: transferRequest.sourceReplacementRoleId,
      },
    ],
    [
      TransferOwnershipRequestSchema,
      {
        sourceMemberId: transferRequest.sourceMemberId,
        recipientMemberId: transferRequest.recipientMemberId,
        ownerRoleId: transferRequest.ownerRoleId,
      },
    ],
  ])('rejects a missing request ID', (schema, request) => {
    expect(schema.safeParse(request).success).toBe(false);
  });
});
