import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import { ErrorResponseSchema } from '../schemas/index';
import { createPaginatedResponseSchema, PaginationQuerySchema } from '../schemas/pagination';
import { ReservationInviteForUserSchema, ReservationInviteSchema } from '../schemas/reservation-invites';
import { type RouteMetadata } from './metadata';
import { authedErrorResponses } from './responses';

const c = initContract();

export const reservationInvitesRoutes = c.router({
  getReservationInvite: {
    method: 'GET',
    path: '/reservation-invites/:id',
    pathParams: z.object({ id: z.string() }),
    responses: {
      ...authedErrorResponses,
      200: ReservationInviteSchema,
      400: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Get reservation invite by ID for current user',
    description:
      'Returns the full details of a specific reservation invite. Only returns invites addressed to the authenticated user.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  getReservationInvites: {
    method: 'GET',
    path: '/reservation-invites',
    query: PaginationQuerySchema,
    responses: {
      ...authedErrorResponses,
      200: createPaginatedResponseSchema(ReservationInviteForUserSchema),
    },
    summary: 'Get all reservation invites for current user',
    description:
      'Returns a paginated list of reservation invites for the authenticated user, including both pending and accepted invites.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },
});
