import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import { ErrorResponseSchema } from '../schemas/index';
import {
  OrganizationMemberSchema,
  OrganizationMembersQuerySchema,
  OrganizationMemberWithUserSchema,
  UpdateOrganizationMemberRoleRequestSchema,
} from '../schemas/organization-members';
import {
  AssignRoleRequestSchema,
  CloneSystemRoleRequestSchema,
  CreateCustomRoleRequestSchema,
  GrantOwnerAccessRequestSchema,
  OrganizationMemberRoleSchema,
  PermissionDefinitionSchema,
  RevokeOwnerAccessRequestSchema,
  TransferOwnershipRequestSchema,
  UpdateRolePermissionsRequestSchema,
} from '../schemas/organization-roles';
import {
  AllowedOrganizationTypesResponseSchema,
  CreateInvitationRequestSchema,
  CreateOrganizationRequestSchema,
  InvitationIdParamsSchema,
  InvitationSchema,
  OrganizationWithRoleSchema,
  OrganizationSchema as PrismaOrganizationSchema,
  SetActiveResponseSchema,
  UpdateOrganizationRequestSchema,
} from '../schemas/organizations';
import { createPaginatedResponseSchema, PaginationQuerySchema } from '../schemas/pagination';
import { type RouteMetadata } from './metadata';
import { authedErrorResponses, authedRoleGatedErrorResponses } from './responses';

const c = initContract();

export const organizationRoutes = c.router({
  createOrganization: {
    method: 'POST',
    path: '/organizations',
    body: CreateOrganizationRequestSchema,
    responses: {
      ...authedRoleGatedErrorResponses,
      201: PrismaOrganizationSchema,
      400: ErrorResponseSchema,
      409: ErrorResponseSchema,
    },
    summary: 'Create a new organization',
    description:
      'Creates a new organization and assigns the current user as its owner. Returns 409 if the organization name already exists, or 403 if the requested tenant type is not permitted on this instance.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },

  getAllowedOrganizationTypes: {
    method: 'GET',
    path: '/organizations/allowed-types',
    responses: {
      ...authedErrorResponses,
      200: AllowedOrganizationTypesResponseSchema,
    },
    summary: 'List tenant types permitted at organization creation',
    description:
      'Returns the tenant types a user may choose when creating an organization on this instance. Drives the commissioning form options so the client never offers a type the server would reject.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },

  listOrganizations: {
    method: 'GET',
    path: '/organizations',
    query: PaginationQuerySchema,
    responses: {
      ...authedErrorResponses,
      200: createPaginatedResponseSchema(OrganizationWithRoleSchema),
    },
    summary: 'List organizations for the current user',
    description:
      "Returns a paginated list of all organizations the current user belongs to, including the user's role in each.",
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },

  getOrganization: {
    method: 'GET',
    path: '/organizations/active',
    responses: {
      ...authedErrorResponses,
      200: PrismaOrganizationSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Get active organization',
    description:
      "Returns the full details of the user's currently active organization. Returns 404 if no organization is active.",
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  updateOrganization: {
    method: 'PATCH',
    path: '/organizations',
    body: UpdateOrganizationRequestSchema,
    responses: {
      ...authedRoleGatedErrorResponses,
      200: PrismaOrganizationSchema,
      400: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Update active organization settings',
    description:
      'Updates fields on the currently active organization. Only provided fields are modified. Requires organization:update.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  setActiveOrganization: {
    method: 'POST',
    path: '/organizations/:id/set-active',
    pathParams: z.object({ id: z.string().describe('ID of the organization to activate') }),
    body: z.object({}),
    responses: {
      ...authedErrorResponses,
      200: SetActiveResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Set the active organization for the current user',
    description:
      "Switches the user's active organization to the specified one. The user must be a member of that organization.",
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },

  getOrganizationMemberships: {
    method: 'GET',
    path: '/organizations/memberships',
    query: OrganizationMembersQuerySchema,
    responses: {
      ...authedErrorResponses,
      200: createPaginatedResponseSchema(OrganizationMemberWithUserSchema),
    },
    summary: 'Get all memberships of an organization',
    description:
      'Returns a paginated list of all members in the active organization, including user details. Supports filtering by role.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  getOrganizationMember: {
    method: 'GET',
    path: '/organizations/memberships/:memberId',
    pathParams: z.object({ memberId: z.string().describe('ID of the membership to retrieve') }),
    responses: {
      ...authedErrorResponses,
      200: OrganizationMemberSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Get specific membership of an organization',
    description: 'Returns details for a single membership record within the active organization.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  updateOrganizationMemberRole: {
    method: 'PATCH',
    path: '/organizations/memberships/:memberId',
    pathParams: z.object({ memberId: z.string().describe('ID of the membership to update') }),
    body: UpdateOrganizationMemberRoleRequestSchema,
    responses: {
      ...authedRoleGatedErrorResponses,
      200: OrganizationMemberWithUserSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Update membership role in organization',
    description:
      "Changes a member's system role within the active organization using the ordinary permission-dominance policy.",
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  deleteOrganizationMembership: {
    method: 'DELETE',
    path: '/organizations/memberships/:membershipId',
    pathParams: z.object({ membershipId: z.string().describe('ID of the membership to remove') }),
    responses: {
      ...authedRoleGatedErrorResponses,
      200: OrganizationMemberWithUserSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Remove membership from organization',
    description:
      'Removes a member from the active organization. Removing another member requires member:delete and strict permission dominance; owner-capable members are protected.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  createInvitation: {
    method: 'POST',
    path: '/organizations/invitations',
    body: CreateInvitationRequestSchema,
    responses: {
      ...authedRoleGatedErrorResponses,
      200: InvitationSchema,
      400: ErrorResponseSchema,
    },
    summary: 'Invite a user to the active organization',
    description:
      'Sends an invitation email to the specified address. The selected system or organization-scoped custom role is assigned when the invitation is accepted.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  listInvitations: {
    method: 'GET',
    path: '/organizations/invitations',
    query: PaginationQuerySchema,
    responses: {
      ...authedErrorResponses,
      200: createPaginatedResponseSchema(InvitationSchema),
    },
    summary: 'List invitations for the active organization',
    description:
      'Returns a paginated list of all invitations (pending, accepted, rejected, canceled) for the active organization.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  getInvitation: {
    method: 'GET',
    path: '/organizations/invitations/:invitationId',
    pathParams: InvitationIdParamsSchema,
    responses: {
      ...authedErrorResponses,
      200: InvitationSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Get a specific invitation by ID',
    description: 'Returns the details of a single invitation within the active organization.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  acceptInvitation: {
    method: 'POST',
    path: '/organizations/invitations/:invitationId/accept',
    pathParams: InvitationIdParamsSchema,
    body: z.object({}),
    responses: {
      ...authedRoleGatedErrorResponses,
      200: InvitationSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Accept an organization invitation',
    description:
      'Accepts a pending invitation, adding the invited user as a member of the organization with the assigned role.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  rejectInvitation: {
    method: 'POST',
    path: '/organizations/invitations/:invitationId/reject',
    pathParams: InvitationIdParamsSchema,
    body: z.object({}),
    responses: {
      ...authedErrorResponses,
      200: InvitationSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Reject an organization invitation',
    description:
      'Rejects a pending invitation. The invitation status is updated to rejected and cannot be accepted afterward.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  cancelInvitation: {
    method: 'POST',
    path: '/organizations/invitations/:invitationId/cancel',
    pathParams: InvitationIdParamsSchema,
    body: z.object({}),
    responses: {
      ...authedRoleGatedErrorResponses,
      200: InvitationSchema,
      400: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Cancel an organization invitation',
    description: 'Cancels a pending invitation that was previously sent. Only the inviting organization can cancel.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  listOrganizationRoles: {
    method: 'GET',
    path: '/organizations/roles',
    responses: {
      ...authedErrorResponses,
      200: z.array(OrganizationMemberRoleSchema),
    },
    summary: 'List all roles available to the active organization',
    description:
      'Returns system roles and any custom roles defined for the active organization, including permission details and member counts.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  getOrganizationRole: {
    method: 'GET',
    path: '/organizations/roles/:roleId',
    pathParams: z.object({ roleId: z.string().describe('ID of the role to retrieve') }),
    responses: {
      ...authedErrorResponses,
      200: OrganizationMemberRoleSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Get a specific role by ID',
    description: 'Returns the full details of a role including all granted permissions and member count.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  createCustomRole: {
    method: 'POST',
    path: '/organizations/roles',
    body: CreateCustomRoleRequestSchema,
    responses: {
      ...authedRoleGatedErrorResponses,
      201: OrganizationMemberRoleSchema,
      400: ErrorResponseSchema,
    },
    summary: 'Create a custom role for the active organization',
    description:
      'Creates a new custom role with the specified permissions. Maximum 20 custom roles per organization. Requires member:change-role permission.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  cloneSystemRole: {
    method: 'POST',
    path: '/organizations/roles/clone',
    body: CloneSystemRoleRequestSchema,
    responses: {
      ...authedRoleGatedErrorResponses,
      201: OrganizationMemberRoleSchema,
      400: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Clone a system role into a custom role',
    description:
      'Creates a new custom role by copying all permissions from an existing system role. The new role can then be modified independently.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  updateRolePermissions: {
    method: 'PATCH',
    path: '/organizations/roles/:roleId',
    pathParams: z.object({ roleId: z.string().describe('ID of the role to update') }),
    body: UpdateRolePermissionsRequestSchema,
    responses: {
      ...authedRoleGatedErrorResponses,
      200: OrganizationMemberRoleSchema,
      400: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Update permissions for a custom role',
    description: 'Replaces the entire permission set for a custom role. System roles cannot be modified.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  archiveCustomRole: {
    method: 'DELETE',
    path: '/organizations/roles/:roleId',
    pathParams: z.object({ roleId: z.string().describe('ID of the role to archive') }),
    responses: {
      ...authedRoleGatedErrorResponses,
      200: z.object({ success: z.boolean().describe('Whether the role was successfully archived') }),
      400: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Archive a custom role',
    description:
      'Archives a custom role. Active members and pending unexpired invitations must be reassigned or resolved first; system roles cannot be archived.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  listPermissions: {
    method: 'GET',
    path: '/organizations/permissions',
    responses: {
      ...authedErrorResponses,
      200: z.array(PermissionDefinitionSchema),
    },
    summary: 'List all available permission definitions',
    description: 'Returns the complete list of resource:action permissions that can be assigned to roles.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  assignRoleToMember: {
    method: 'PATCH',
    path: '/organizations/memberships/:memberId/role-assignment',
    pathParams: z.object({ memberId: z.string().describe('ID of the membership to update') }),
    body: AssignRoleRequestSchema,
    responses: {
      ...authedRoleGatedErrorResponses,
      200: z.object({ success: z.boolean().describe('Whether the role was successfully assigned') }),
      404: ErrorResponseSchema,
    },
    summary: 'Assign a role to an organization member',
    description:
      'Assigns a system or custom role to a member. The role must belong to the same organization or be a system role.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  grantOwnerAccess: {
    method: 'POST',
    path: '/organizations/memberships/:memberId/owner-access',
    pathParams: z.object({ memberId: z.string().describe('ID of the member who will receive owner access') }),
    body: GrantOwnerAccessRequestSchema,
    responses: {
      ...authedRoleGatedErrorResponses,
      200: z.object({ success: z.boolean().describe('Whether owner access was granted') }),
      400: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Grant owner access',
    description: 'Assigns an owner-capable role to an existing member. Requires an owner-capable browser session.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  revokeOwnerAccess: {
    method: 'POST',
    path: '/organizations/memberships/:memberId/owner-access/revoke',
    pathParams: z.object({ memberId: z.string().describe('ID of the owner member to demote') }),
    body: RevokeOwnerAccessRequestSchema,
    responses: {
      ...authedRoleGatedErrorResponses,
      200: z.object({ success: z.boolean().describe('Whether owner access was removed') }),
      400: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Remove owner access',
    description:
      'Replaces an owner member’s role with a non-owner role. Refuses to remove the organization’s last owner-capable member.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  transferOwnership: {
    method: 'POST',
    path: '/organizations/ownership/transfer',
    body: TransferOwnershipRequestSchema,
    responses: {
      ...authedRoleGatedErrorResponses,
      200: z.object({ success: z.boolean().describe('Whether ownership was transferred atomically') }),
      400: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Transfer organization ownership',
    description:
      'Atomically promotes a recipient to an owner-capable role before demoting the source owner to a non-owner replacement role. Requires an owner-capable browser session.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },
});
