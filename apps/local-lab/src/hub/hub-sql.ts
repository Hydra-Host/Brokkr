import { z } from 'zod';

/** Column lists are explicit because two must never appear: `Webhook.secret` and
 *  `DeviceToken.tokenHash` are the columns the hub and admin apis stopped returning. */
const epochMs = z
  .unknown()
  .transform((value) => (value instanceof Date ? value.getTime() : typeof value === 'number' ? value : null));

const requiredEpochMs = epochMs.pipe(z.number());
const text = z.unknown().transform((value) => (typeof value === 'string' && value.length > 0 ? value : null));
const requiredText = z.string().min(1);
const int = z.unknown().transform((value) => (typeof value === 'number' && Number.isFinite(value) ? value : null));
const requiredInt = z.coerce.number().int();

export const LIFECYCLE_PHASES = [
  'REQUESTED',
  'AUTHORIZING',
  'SCHEDULED',
  'DEFERRED',
  'DISPATCHED',
  'RUNNING',
  'AWAITING_PHONE_HOME',
  'COMPLETED',
  'FAILED',
  'ABORTED',
] as const;

export const WEBHOOK_DELIVERY_COLUMNS = `d.id, d."webhookId", w.endpoint, d."eventType", d.status,
  d."httpStatus", d.attempts, d."errorMessage", d."idempotencyKey", d."nextRetryAt", d."createdAt",
  d."deliveredAt", d."processingLockedBy", d."processingLockedAt", d."processingLockExpires",
  d.payload, d."responseBody"`;

export const WEBHOOK_DELIVERIES_SQL = `SELECT ${WEBHOOK_DELIVERY_COLUMNS}
  FROM "WebhookDelivery" d
  LEFT JOIN "Webhook" w ON w.id = d."webhookId"
 WHERE ($1::text IS NULL OR d.status::text = $1)
   AND ($2::text IS NULL OR d."webhookId" = $2)
 ORDER BY d."createdAt" DESC
 LIMIT $3 OFFSET $4`;

export const WebhookDeliverySqlRowSchema = z.object({
  id: requiredText,
  webhookId: requiredText,
  endpoint: text,
  eventType: requiredText,
  status: z.enum(['PENDING', 'SUCCESS', 'FAILED', 'RETRYING']),
  httpStatus: int,
  attempts: requiredInt,
  errorMessage: text,
  idempotencyKey: text,
  nextRetryAt: epochMs,
  createdAt: requiredEpochMs,
  deliveredAt: epochMs,
  processingLockedBy: text,
  processingLockedAt: epochMs,
  processingLockExpires: epochMs,
  payload: z.unknown(),
  responseBody: text,
});
export type WebhookDeliverySqlRow = z.infer<typeof WebhookDeliverySqlRowSchema>;

// qualified because the list statement joins the newest event laterally; the by-id read aliases to
// the same letter so one column list serves both
export const LIFECYCLE_JOB_COLUMNS = `j.id, j."jobType", j.phase, j."deviceId", j."deploymentId", j.source,
  j."performedBy", j.error, j."scheduledAt", j."phoneHomeDeadline", j."linkedJobId", j."createdAt", j."updatedAt"`;

const LATEST_STEP_LATERAL = `  LEFT JOIN LATERAL (
    SELECT e.id, e."sagaName", e."stepName", e."eventType", e.status, e.attempt, e.error,
           e."occurredAt", e."recordedAt"
      FROM "LifecycleJobEvent" e
     WHERE e."jobId" = j.id
     ORDER BY e."recordedAt" DESC
     LIMIT 1
  ) step ON true`;

const LATEST_STEP_COLUMNS = `step.id AS "stepId", step."sagaName", step."stepName", step."eventType",
  step.status AS "stepStatus", step.attempt, step.error AS "stepError", step."occurredAt", step."recordedAt"`;

// an empty phase array means every phase: `= ANY('{}')` would match nothing, so the length guard is
// what makes "no filter" mean no filter rather than no rows
export const LIFECYCLE_JOBS_SQL = `SELECT ${LIFECYCLE_JOB_COLUMNS}, ${LATEST_STEP_COLUMNS}
  FROM "LifecycleJob" j
${LATEST_STEP_LATERAL}
 WHERE (cardinality($1::text[]) = 0 OR j.phase::text = ANY($1::text[]))
   AND ($2::text IS NULL OR j."deviceId" = $2)
 ORDER BY j."createdAt" DESC
 LIMIT $3 OFFSET $4`;

// the phase filter is deliberately absent: a census that answered only for the selected phase would
// make the tile row restate the filter instead of the fleet
export const LIFECYCLE_PHASE_COUNTS_SQL = `SELECT j.phase, count(*)::int AS count
  FROM "LifecycleJob" j
 WHERE ($1::text IS NULL OR j."deviceId" = $1)
 GROUP BY j.phase`;

export const LifecyclePhaseCountSqlRowSchema = z.object({
  phase: z.enum(LIFECYCLE_PHASES),
  count: requiredInt,
});

export const LIFECYCLE_JOB_BY_ID_SQL = `SELECT ${LIFECYCLE_JOB_COLUMNS}, ${LATEST_STEP_COLUMNS}, j.payload
  FROM "LifecycleJob" j
${LATEST_STEP_LATERAL}
 WHERE j.id = $1`;

export const LifecycleJobSqlRowSchema = z.object({
  id: requiredText,
  jobType: requiredText,
  phase: z.enum(LIFECYCLE_PHASES),
  deviceId: text,
  deploymentId: text,
  source: requiredText,
  performedBy: text,
  error: text,
  scheduledAt: epochMs,
  phoneHomeDeadline: epochMs,
  linkedJobId: text,
  createdAt: requiredEpochMs,
  updatedAt: requiredEpochMs,
  stepId: text,
  sagaName: text,
  stepName: text,
  eventType: text,
  stepStatus: text,
  attempt: int,
  stepError: text,
  occurredAt: epochMs,
  recordedAt: epochMs,
});
export type LifecycleJobSqlRow = z.infer<typeof LifecycleJobSqlRowSchema>;

export const LifecycleJobWithPayloadSchema = LifecycleJobSqlRowSchema.extend({ payload: z.unknown() });

/** Newest first even though the timeline reads oldest first: a job past the cap has to lose its
 *  oldest end, not the failure that is the reason anyone opened it. The reader re-sorts. */
export const LIFECYCLE_JOB_EVENTS_SQL = `SELECT id, "sagaName", "stepName", "eventType", status, attempt,
  error, "occurredAt", "recordedAt"
  FROM "LifecycleJobEvent" WHERE "jobId" = $1 ORDER BY "recordedAt" DESC LIMIT $2`;

export const LifecycleJobEventSqlRowSchema = z.object({
  id: requiredText,
  sagaName: requiredText,
  stepName: requiredText,
  eventType: requiredText,
  status: requiredText,
  attempt: requiredInt,
  error: text,
  occurredAt: epochMs,
  recordedAt: requiredEpochMs,
});

export const DEVICE_TOKENS_SQL = `SELECT id, "displayId", "deviceId", "deploymentId", context, status,
  "rotationGeneration", "expiresAt", "lastUsedAt", "lastUsedIp", "revokedAt", "revokedReason",
  "issuedBy", "createdAt"
  FROM "DeviceToken"
 WHERE ($1::text IS NULL OR "deviceId" = $1)
   AND ($2::text IS NULL OR status::text = $2)
 ORDER BY "createdAt" DESC
 LIMIT $3 OFFSET $4`;

export const DeviceTokenSqlRowSchema = z.object({
  id: requiredText,
  displayId: requiredText,
  deviceId: requiredText,
  deploymentId: text,
  context: requiredText,
  status: z.enum(['ACTIVE', 'REVOKED']),
  rotationGeneration: requiredInt,
  expiresAt: epochMs,
  lastUsedAt: epochMs,
  lastUsedIp: text,
  revokedAt: epochMs,
  revokedReason: text,
  issuedBy: text,
  createdAt: requiredEpochMs,
});
export type DeviceTokenSqlRow = z.infer<typeof DeviceTokenSqlRowSchema>;

export const DEVICE_TOKEN_EVENTS_SQL = `SELECT id, event, actor, ip, "userAgent", "createdAt"
  FROM "DeviceTokenAuditEvent" WHERE "tokenId" = $1 ORDER BY "createdAt" DESC LIMIT $2 OFFSET $3`;

export const DeviceTokenEventSqlRowSchema = z.object({
  id: requiredText,
  event: requiredText,
  actor: text,
  ip: text,
  userAgent: text,
  createdAt: requiredEpochMs,
});

/** Hub-written and global — it carries no zone prefix, unlike the spoke atoms. */
export const deviceTokenLastUsedKey = (tokenId: string): string => `device-token:${tokenId}:last-used`;

export const EVENT_READ_CAP = 500;
