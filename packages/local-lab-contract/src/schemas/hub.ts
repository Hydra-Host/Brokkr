import { z } from 'zod';
import { QueueJobSchema, QueueRefSchema } from './queues';

export const LIFECYCLE_JOB_PHASES = [
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

export const LifecycleJobPhaseSchema = z
  .enum(LIFECYCLE_JOB_PHASES)
  .describe(
    'Engine-owned state-machine position. DEFERRED means a plugin gate parked the job pending out-of-band resolution, and AWAITING_PHONE_HOME means the bridge finished and the hub is waiting on the device callback — both are in-flight, not failures',
  );
export type LifecycleJobPhase = z.infer<typeof LifecycleJobPhaseSchema>;

export const DELIVERY_STATUSES = ['PENDING', 'SUCCESS', 'FAILED', 'RETRYING'] as const;
export const DeliveryStatusSchema = z.enum(DELIVERY_STATUSES).describe('Delivery state as the hub recorded it');
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>;

export const DEVICE_TOKEN_STATUSES = ['ACTIVE', 'REVOKED'] as const;
export const DeviceTokenStatusSchema = z
  .enum(DEVICE_TOKEN_STATUSES)
  .describe('Whether the token can still authenticate');
export type DeviceTokenStatus = z.infer<typeof DeviceTokenStatusSchema>;

export const WebhookDeliveryRowSchema = z.object({
  id: z.string().describe('WebhookDelivery.id'),
  webhookId: z.string().describe('Webhook this delivery belongs to'),
  endpoint: z
    .string()
    .nullable()
    .describe(
      'Destination URL, joined from the parent webhook. Null when that row is gone — the signing secret is never read',
    ),
  eventType: z.string().describe('Event that produced this delivery'),
  status: DeliveryStatusSchema,
  httpStatus: z
    .number()
    .int()
    .nullable()
    .describe(
      'Status the endpoint answered with. Null when the attempt never got a response, which is not the same as a 0',
    ),
  attempts: z.number().int().describe('Attempts made so far'),
  errorMessage: z.string().nullable().describe('Failure text the hub recorded. Null when the attempt did not fail'),
  idempotencyKey: z.string().nullable().describe('Dedupe key, when the producer set one'),
  nextRetryAtMs: z.number().nullable().describe('Unix ms of the next scheduled retry. Null when none is scheduled'),
  createdAtMs: z.number().describe('Unix ms the delivery row was created'),
  deliveredAtMs: z.number().nullable().describe('Unix ms it succeeded. Null while it has not'),
  lockedBy: z
    .string()
    .nullable()
    .describe(
      'Worker holding the processing lock. A non-null value with an expired lockExpiresAtMs is the signature of a wedged delivery — the reason this surface reads the database rather than the hub API, which never exposes these columns',
    ),
  lockedAtMs: z.number().nullable().describe('Unix ms the lock was taken. Null when unlocked'),
  lockExpiresAtMs: z.number().nullable().describe('Unix ms the lock lapses. Null when unlocked'),
  payload: z.unknown().describe('Event body, redacted and byte-capped for display — never the raw stored payload'),
  payloadTruncated: z.boolean().describe('True when the payload was cut to fit the cap, so what is shown is a prefix'),
  responseBody: z
    .string()
    .nullable()
    .describe('What the endpoint returned, redacted and capped. Null when nothing was recorded'),
  responseBodyTruncated: z
    .boolean()
    .describe('True when the response body was cut to fit its own cap, which is separate from the payload cap'),
});
export type WebhookDeliveryRow = z.infer<typeof WebhookDeliveryRowSchema>;

export const WebhookDeliveryPageSchema = z.object({
  rows: z
    .array(WebhookDeliveryRowSchema)
    .describe('Deliveries newest first. Empty is a measurement that none match only when readError is null'),
  skipped: z
    .number()
    .int()
    .describe('Rows this build could not parse. Non-zero means the list is short by that many, rather than complete'),
  readError: z
    .string()
    .nullable()
    .describe('Null when the read succeeded. Otherwise why it did not, in which case an empty rows list means unknown'),
});
export type WebhookDeliveryPage = z.infer<typeof WebhookDeliveryPageSchema>;

export const LifecycleJobEventRowSchema = z.object({
  id: z.string().describe('LifecycleJobEvent.id'),
  sagaName: z.string().describe('Saga the bridge was running'),
  stepName: z.string().describe('Step within that saga'),
  eventType: z.string().describe('Kind of transition or bridge message'),
  status: z.string().describe('Outcome the bridge reported for the step'),
  attempt: z.number().int().describe('Attempt number for this step'),
  error: z.string().nullable().describe('Failure text for the step. Null when it did not fail'),
  occurredAtMs: z.number().nullable().describe('Unix ms the bridge says it happened. Null when it sent none'),
  recordedAtMs: z.number().describe('Unix ms the hub ingested it, which is always known'),
});
export type LifecycleJobEventRow = z.infer<typeof LifecycleJobEventRowSchema>;

export const LifecycleJobRowSchema = z.object({
  id: z
    .string()
    .describe(
      'LifecycleJob.id, which is also the plan_id correlation key sent to bridges — the join back to a queue job',
    ),
  jobType: z.string().describe('Lifecycle operation this job performs'),
  phase: LifecycleJobPhaseSchema,
  deviceId: z.string().nullable().describe('Device the job acts on. Null for jobs not scoped to one'),
  deploymentId: z.string().nullable().describe('Deployment the job belongs to, when any'),
  source: z.string().describe('What requested the job'),
  performedBy: z.string().nullable().describe('Actor recorded on the request. Null for system-initiated work'),
  error: z.string().nullable().describe('Failure text. Null when the job has not failed'),
  scheduledAtMs: z
    .number()
    .nullable()
    .describe('Unix ms grace deadline for an interruptible op. Null when not scheduled'),
  phoneHomeDeadlineMs: z
    .number()
    .nullable()
    .describe('Unix ms watchdog deadline while AWAITING_PHONE_HOME; missing it fails the job. Null outside that phase'),
  linkedJobId: z.string().nullable().describe('The other half of an interruptible provision pair, when linked'),
  createdAtMs: z.number().describe('Unix ms the job was created'),
  updatedAtMs: z.number().describe('Unix ms the job last changed'),
  latestStep: LifecycleJobEventRowSchema.nullable().describe(
    'Newest timeline event for this job, so a phase like RUNNING says which saga step it is actually on. Null means the job has recorded no events yet, which is a measurement — a failed read is reported by readError instead',
  ),
});
export type LifecycleJobRow = z.infer<typeof LifecycleJobRowSchema>;

export const LifecyclePhaseCountSchema = z.object({
  phase: LifecycleJobPhaseSchema,
  count: z.number().int().describe('Jobs in this phase'),
});
export type LifecyclePhaseCount = z.infer<typeof LifecyclePhaseCountSchema>;

export const LifecycleJobPageSchema = z.object({
  rows: z.array(LifecycleJobRowSchema).describe('Jobs newest first'),
  skipped: z.number().int().describe('Rows this build could not parse, so the list is short by that many'),
  readError: z.string().nullable().describe('Null when the read succeeded; otherwise why it did not'),
  counts: z
    .array(LifecyclePhaseCountSchema)
    .describe(
      'Census over every job the device filter admits, deliberately ignoring the phase filter so the totals do not collapse to the selected phase. A phase absent from this list has no jobs, which is a measurement. Counted across the whole table rather than the returned page, so it is a total and not a window',
    ),
  countsReadError: z
    .string()
    .nullable()
    .describe('Null when the census ran. Otherwise why not, in which case no total is known rather than zero'),
});
export type LifecycleJobPage = z.infer<typeof LifecycleJobPageSchema>;

export const LifecycleJobDetailSchema = z.object({
  job: LifecycleJobRowSchema.nullable().describe('The job. Null when no job carries this id'),
  payload: z
    .unknown()
    .describe('Request payload, redacted and byte-capped — the stored OS password hash never survives'),
  payloadTruncated: z.boolean().describe('True when the payload was cut to fit the cap'),
  events: z
    .array(LifecycleJobEventRowSchema)
    .describe('Step timeline oldest first. Empty is a measurement of no events only when eventsReadError is null'),
  eventsTruncated: z
    .boolean()
    .describe(
      'True when the job has more events than the read cap, in which case the newest are kept and the oldest end is the part missing',
    ),
  eventsSkipped: z.number().int().describe('Event rows this build could not parse'),
  eventsReadError: z
    .string()
    .nullable()
    .describe(
      'Null when the timeline read succeeded. Otherwise why not, in which case an empty events list means unknown',
    ),
});
export type LifecycleJobDetail = z.infer<typeof LifecycleJobDetailSchema>;

export const DeviceTokenRowSchema = z.object({
  id: z.string().describe('DeviceToken.id'),
  displayId: z
    .string()
    .describe(
      'The hub\'s own non-secret identifier for the token ("dtok_" plus a hash prefix). The token hash itself is never selected by this surface',
    ),
  deviceId: z.string().describe('Device the token authenticates'),
  deploymentId: z.string().nullable().describe('Deployment it was issued for, when any'),
  context: z.string().describe('Which OS the token belongs to: the discovery image or the deployed customer OS'),
  status: DeviceTokenStatusSchema,
  rotationGeneration: z.number().int().describe('How many times the token has been rotated'),
  expiresAtMs: z.number().nullable().describe('Unix ms expiry. Null when the token does not expire'),
  lastUsedAtMs: z
    .number()
    .nullable()
    .describe(
      'Unix ms of the last successful authentication, refreshed on every phone-home but throttled to 60s, so it can lag by up to a minute. Null means never used, which is not the same as unknown',
    ),
  lastUsedIp: z.string().nullable().describe('Address the last use came from. Null when never used or not recorded'),
  usedWithinThrottleWindow: z
    .boolean()
    .nullable()
    .describe(
      'True when the live 60-second sentinel is still present, which is fresher evidence than lastUsedAtMs. Null when that probe could not be read — never false, which would assert the token is idle',
    ),
  revokedAtMs: z.number().nullable().describe('Unix ms of revocation. Null while active'),
  revokedReason: z.string().nullable().describe('Why it was revoked. Null while active'),
  issuedBy: z.string().nullable().describe('Actor that minted it, when recorded'),
  createdAtMs: z.number().describe('Unix ms the token was issued'),
});
export type DeviceTokenRow = z.infer<typeof DeviceTokenRowSchema>;

export const DeviceTokenPageSchema = z.object({
  rows: z.array(DeviceTokenRowSchema).describe('Tokens newest first'),
  skipped: z.number().int().describe('Rows this build could not parse, so the list is short by that many'),
  readError: z.string().nullable().describe('Null when the token read succeeded; otherwise why it did not'),
  recencyReadError: z
    .string()
    .nullable()
    .describe(
      'Null when the probe as a whole ran. Otherwise why not, which is why every usedWithinThrottleWindow is null rather than false. A probe that ran but could not answer for one token leaves that row null with this field still null',
    ),
});
export type DeviceTokenPage = z.infer<typeof DeviceTokenPageSchema>;

export const DeviceTokenEventRowSchema = z.object({
  id: z.string().describe('DeviceTokenAuditEvent.id'),
  event: z
    .string()
    .describe(
      'What happened to the token. USED_AFTER_REVOKE and USED_AFTER_EXPIRY are security-relevant: something still holds a token it should not',
    ),
  actor: z.string().nullable().describe('Who caused it, when recorded'),
  ip: z.string().nullable().describe('Address it came from, when recorded'),
  userAgent: z.string().nullable().describe('Client string, when recorded'),
  createdAtMs: z.number().describe('Unix ms the event was recorded'),
});
export type DeviceTokenEventRow = z.infer<typeof DeviceTokenEventRowSchema>;

export const DeviceTokenEventPageSchema = z.object({
  rows: z.array(DeviceTokenEventRowSchema).describe('Audit events newest first'),
  skipped: z.number().int().describe('Rows this build could not parse'),
  readError: z.string().nullable().describe('Null when the read succeeded; otherwise why it did not'),
});
export type DeviceTokenEventPage = z.infer<typeof DeviceTokenEventPageSchema>;

export const LifecycleQueueMatchSchema = z.object({
  queue: QueueRefSchema.describe('Saga queue the job was found in; its prefix is the zone UUID'),
  job: QueueJobSchema.describe('The BullMQ job, read through the same reader the queue inspector uses'),
});
export type LifecycleQueueMatch = z.infer<typeof LifecycleQueueMatchSchema>;

export const LifecycleQueueJoinSchema = z.object({
  joinable: z
    .boolean()
    .describe(
      'False when the join cannot be attempted at all, which is not the same as finding nothing. The saga job id embeds the device UUID, so a lifecycle job scoped to no device has no key to search on',
    ),
  unjoinableReason: z.string().nullable().describe('Why the join could not be attempted. Null when it could'),
  deviceId: z.string().nullable().describe('The device UUID the search keyed on. Null when there was none'),
  matches: z
    .array(LifecycleQueueMatchSchema)
    .describe(
      "Queue jobs whose id carries this plan id. Empty is a measurement only when joinable is true, readError is null and discoveryCapped is false — and even then a completed job may simply have been trimmed by the queue's keep-completed policy",
    ),
  searchedQueues: z
    .array(QueueRefSchema)
    .describe('The saga queues actually walked, so an empty match list can be read against where it looked'),
  discoveryCapped: z
    .boolean()
    .describe(
      "True when a queue's id discovery hit its scan cap, so jobs beyond it were never examined and the match list may be short. The scan restarts from the start of the keyspace each request, so those ids are unreachable rather than merely on a later page",
    ),
  readError: z.string().nullable().describe('Null when every searched queue answered; otherwise why one did not'),
});
export type LifecycleQueueJoin = z.infer<typeof LifecycleQueueJoinSchema>;
