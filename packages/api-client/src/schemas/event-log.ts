import { z } from 'zod';
import { BooleanQueryParamSchema } from './common';
import { PaginationQuerySchema } from './pagination';
import { ErrorResponseSchema } from './responses';

export const EventTierSchema = z
  .enum(['EVIDENCE', 'ACTIVITY'])
  .describe('EVIDENCE for enumerated governance actions; ACTIVITY for every other captured mutation.');

export const EventDurabilitySchema = z
  .enum(['ATOMIC', 'POST_COMMIT', 'MIRROR', 'BEST_EFFORT'])
  .describe(
    'How durably the row was written. ATOMIC shared the mutation transaction and is the only compliance-grade class; MIRROR projects a record kept primarily in a purpose-built audit table.',
  );

export const EventOutcomeSchema = z
  .enum(['SUCCEEDED', 'FAILED', 'DENIED'])
  .describe('Whether the action succeeded, failed after passing its permission check, or was refused.');

export const EventActorTypeSchema = z
  .enum(['UI', 'API', 'DEVICE', 'ADMIN', 'SYSTEM'])
  .describe('Kind of principal that acted. ADMIN is reserved and has no producer in this app.');

export const EventLogEntrySchema = z.object({
  id: z.string().uuid().describe('Unique identifier for the event.'),
  tier: EventTierSchema,
  durability: EventDurabilitySchema,
  resource: z.string().describe('Resource the action applied to, for example "member" or "api-key".'),
  action: z.string().describe('Verb performed, for example "removed" or "role-changed".'),
  actionKey: z.string().describe('Combined resource.action key used for filtering and grouping.'),
  actorType: EventActorTypeSchema,
  actorId: z.string().nullable().describe('User id that acted; null for device and system actors.'),
  actorLabel: z.string().nullable().describe('Actor email or device name as it was at the time of the action.'),
  apiKeyId: z.string().nullable().describe('API key id when the actor was a key rather than a browser session.'),
  apiKeyLabel: z.string().nullable().describe('API key name as it was at the time of the action.'),
  targetId: z.string().nullable().describe('Identifier of the object that was acted upon.'),
  targetLabel: z.string().nullable().describe('Human-readable name of the object at the time of the action.'),
  outcome: EventOutcomeSchema,
  errorCode: z.string().nullable().describe('Mapped status and exception class when the action failed.'),
  requestId: z.string().nullable().describe('Correlates every row produced by a single request.'),
  method: z.string().nullable().describe('HTTP method of the originating request.'),
  path: z.string().nullable().describe('Route path of the originating request.'),
  ipAddress: z.string().nullable().describe('Client address of the originating request.'),
  userAgent: z.string().nullable().describe('Client user agent of the originating request.'),
  metadata: z
    .record(z.unknown())
    .nullable()
    .describe('Allowlisted supplementary fields. Never contains request bodies or secrets.'),
  createdAt: z.coerce.date().describe('When the event was recorded.'),
});

export type EventLogEntry = z.infer<typeof EventLogEntrySchema>;

// Shared by browse and export, so a filter cannot exist on one route and be missing from the other.
export const EventLogFilterQuerySchema = z.object({
  actionKey: z.string().optional().describe('Exact resource.action key to filter by.'),
  resource: z.string().optional().describe('Resource to filter by, for example "member".'),
  tier: EventTierSchema.optional(),
  durability: EventDurabilitySchema.optional(),
  actorId: z.string().optional().describe('Restrict to actions taken by one user.'),
  actorType: EventActorTypeSchema.optional(),
  outcome: EventOutcomeSchema.optional(),
  targetId: z.string().optional().describe('Restrict to events about one object.'),
  from: z.coerce.date().optional().describe('Only events recorded at or after this timestamp.'),
  to: z.coerce.date().optional().describe('Only events recorded at or before this timestamp.'),
  // Not z.coerce.boolean(): that is Boolean(value), so the string "false" arrives as true.
  includeSystemActors: BooleanQueryParamSchema.optional().describe(
    'Include DEVICE and SYSTEM rows, which are hidden by default so the feed reads as human activity.',
  ),
});

export type EventLogFilterQuery = z.infer<typeof EventLogFilterQuerySchema>;

// `filters` is omitted, not merely unused: this endpoint configures no advancedFilterFields, so
// inheriting it would document and accept an expression the query planner never applies.
export const EventLogQuerySchema = PaginationQuerySchema.omit({ filters: true }).merge(EventLogFilterQuerySchema);

export type EventLogQuery = z.infer<typeof EventLogQuerySchema>;

/** The CSV column set IS the API projection above, so the two cannot drift; `metadata` is
 *  JSON-encoded into one column and `id` is the dedupe key an at-least-once export requires. */
export const EVENT_LOG_CSV_COLUMNS = [
  'id',
  'createdAt',
  'tier',
  'durability',
  'actionKey',
  'resource',
  'action',
  'outcome',
  'errorCode',
  'actorType',
  'actorId',
  'actorLabel',
  'apiKeyId',
  'apiKeyLabel',
  'targetId',
  'targetLabel',
  'requestId',
  'method',
  'path',
  'ipAddress',
  'userAgent',
  'metadata',
] as const satisfies readonly (keyof EventLogEntry)[];

export const EventLogExportFormatSchema = z
  .enum(['csv', 'json'])
  .describe('csv streams a bounded text/csv download; json returns one keyset page for incremental pulls.');

export const EventLogExportQuerySchema = EventLogFilterQuerySchema.extend({
  format: EventLogExportFormatSchema.optional()
    .default('json')
    .describe('Response encoding. csv returns text/csv rather than the documented JSON body.'),
  cursor: z
    .string()
    .optional()
    .describe('Opaque cursor from the previous page. Omit to start a new pull; csv treats it as a lower bound.'),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .default(1000)
    .describe('Rows per json page (max 1000). Ignored for csv, which is capped at 50,000 rows.'),
});

export type EventLogExportQuery = z.infer<typeof EventLogExportQuerySchema>;

export const EventLogExportPageSchema = z.object({
  data: z.array(EventLogEntrySchema).describe('Matching events in ascending (createdAt, id) order.'),
  cursor: z.string().describe('Cursor to pass to the next pull. Always present, including on an empty page.'),
  hasMore: z
    .boolean()
    .describe('True when the page filled its limit, so the next pull continues immediately rather than idling.'),
});

export type EventLogExportPage = z.infer<typeof EventLogExportPageSchema>;

export const EventLogExportKeySchema = z.object({
  createdAt: z.coerce.date().describe('Timestamp half of the keyset position.'),
  id: z.string().describe('Event id half of the keyset position, which makes the order total.'),
});

export const EventLogCursorExpiredSchema = ErrorResponseSchema.extend({
  error: z.literal('cursor_expired').describe('Discriminator: the cursor predates the retention floor.'),
  oldestAvailable: EventLogExportKeySchema.nullable().describe(
    'Oldest event still retained, or null when the organization has none. Rows before it are gone, not skipped.',
  ),
  cursor: z.string().describe('Replacement cursor positioned at the oldest retained event.'),
});

export type EventLogCursorExpired = z.infer<typeof EventLogCursorExpiredSchema>;
