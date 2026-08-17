import { initContract } from '@ts-rest/core';
import { EventLogEntrySchema, EventLogQuerySchema } from '../schemas/event-log';
import { createPaginatedResponseSchema } from '../schemas/pagination';
import { type RouteMetadata } from './metadata';
import { authedRoleGatedErrorResponses } from './responses';

const c = initContract();

export const eventLogRoutes = c.router({
  listEventLog: {
    method: 'GET',
    path: '/event-log',
    query: EventLogQuerySchema,
    responses: {
      ...authedRoleGatedErrorResponses,
      200: createPaginatedResponseSchema(EventLogEntrySchema),
    },
    summary: 'List organization event-log entries',
    description:
      'Returns the current organization’s recorded actions, newest first. Requires the event-log:access permission, which Owner and Admin hold by default. Device and system rows are excluded unless includeSystemActors is set.',
    metadata: { visibility: 'public' } as RouteMetadata,
  },
});
