import { z } from 'zod';
import { BooleanQueryParamSchema } from './common';
import { PaginationQuerySchema } from './pagination';

export const EventTierSchema = z
  .enum(['EVIDENCE', 'ACTIVITY'])
  .describe('EVIDENCE for enumerated governance actions; ACTIVITY for every other captured mutation.');

export const EventDurabilitySchema = z
  .enum(['ATOMIC', 'POST_COMMIT', 'BEST_EFFORT'])
  .describe(
    'How durably the row was written. ATOMIC shared the mutation transaction and is the only compliance-grade class.',
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

// `filters` is omitted, not merely unused: this endpoint configures no advancedFilterFields, so
// inheriting it would document and accept an expression the query planner never applies.
export const EventLogQuerySchema = PaginationQuerySchema.omit({ filters: true }).extend({
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

export type EventLogQuery = z.infer<typeof EventLogQuerySchema>;
