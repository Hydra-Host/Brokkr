import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import { InvitationIdParamsSchema, InvitationSchema, InvitationWithOrganizationSchema } from '../schemas/organizations';
import { createPaginatedResponseSchema, PaginationQuerySchema } from '../schemas/pagination';
import { ErrorResponseSchema } from '../schemas/responses';
import {
  SetDefaultOrganizationRequestSchema,
  SetDefaultOrganizationResponseSchema,
  UpdateUserRequestSchema,
  UserProfileSchema,
} from '../schemas/users';
import { type RouteMetadata } from './metadata';
import { authedErrorResponses } from './responses';

const c = initContract();

export const usersRoutes = c.router({
  updateUserProfile: {
    method: 'PATCH',
    path: '/users/profile',
    body: UpdateUserRequestSchema,
    responses: {
      ...authedErrorResponses,
      200: UserProfileSchema,
    },
    summary: "Update the current user's profile",
    description:
      "Updates the authenticated user's name. The login email cannot be changed here. Only provided fields are changed.",
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  setDefaultOrganization: {
    method: 'POST',
    path: '/users/default-organization',
    body: SetDefaultOrganizationRequestSchema,
    responses: {
      ...authedErrorResponses,
      200: SetDefaultOrganizationResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Set the default organization for the current user',
    description:
      'Sets which organization is automatically selected when the user logs in. The user must be a member of the specified organization.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  listMyInvitations: {
    method: 'GET',
    path: '/users/invitations',
    query: PaginationQuerySchema,
    responses: {
      ...authedErrorResponses,
      200: createPaginatedResponseSchema(InvitationWithOrganizationSchema),
    },
    summary: 'List pending invitations for the current user',
    description:
      'Returns a paginated list of all pending organization invitations addressed to the current user, including organization details.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  acceptMyInvitation: {
    method: 'POST',
    path: '/users/invitations/:invitationId/accept',
    pathParams: InvitationIdParamsSchema,
    body: z.object({}),
    responses: {
      ...authedErrorResponses,
      200: InvitationSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Accept an invitation (no org context required)',
    description:
      'Accepts a pending invitation and adds the current user as a member of the inviting organization. Does not require an active organization context.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  rejectMyInvitation: {
    method: 'POST',
    path: '/users/invitations/:invitationId/reject',
    pathParams: InvitationIdParamsSchema,
    body: z.object({}),
    responses: {
      ...authedErrorResponses,
      200: InvitationSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Reject an invitation (no org context required)',
    description:
      'Rejects a pending organization invitation. The invitation status is set to rejected. Does not require an active organization context.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },
});
