import { initContract } from '@ts-rest/core';
import {
  EventLogCursorExpiredSchema,
  EventLogEntrySchema,
  EventLogExportPageSchema,
  EventLogExportQuerySchema,
  EventLogQuerySchema,
} from '../schemas/event-log';
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

  // The documented 200 covers format=json only. ts-rest keys one body schema per status, so the
  // format=csv branch cannot be declared here and is described instead — see the description.
  exportEventLog: {
    method: 'GET',
    path: '/event-log/export',
    query: EventLogExportQuerySchema,
    responses: {
      ...authedRoleGatedErrorResponses,
      200: EventLogExportPageSchema,
      409: EventLogCursorExpiredSchema,
    },
    summary: 'Export organization event-log entries as CSV or a keyset JSON page',
    description:
      'Exports the current organization’s recorded actions in ascending (createdAt, id) order, using the same filters as the browse route. Requires the event-log:access permission. **The documented 200 schema below describes format=json only.** format=json (the default) returns that keyset page as application/json: pass the returned cursor back to continue, and a pull re-scans a one-hour overlap so rows that commit out of createdAt order are still delivered — delivery is at-least-once, so deduplicate on id. **format=csv returns a completely different 200: Content-Type text/csv; charset=utf-8, sent as an attachment, with a CSV body rather than the JSON object documented here.** Generated clients typed from this schema must not attempt to parse a format=csv response as JSON. The CSV is capped at 50,000 rows and truncation is reported both in the X-Event-Log-Truncated header and in a trailing "#" metadata line, never as a silent prefix; its column set is exactly the fields of the JSON entry projection, in a fixed order, with metadata JSON-encoded into one column. A cursor older than the retention window returns 409 cursor_expired with the oldest event still retained. Free-text search is browse-only; the export accepts the named audit filters only.',
    metadata: { visibility: 'public' } as RouteMetadata,
  },
});
