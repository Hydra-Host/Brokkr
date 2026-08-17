import { z } from 'zod';
import { ErrorBodySchema } from '../schemas/common';
import {
  DeliveryStatusSchema,
  DeviceTokenEventPageSchema,
  DeviceTokenPageSchema,
  DeviceTokenStatusSchema,
  LifecycleJobDetailSchema,
  LifecycleJobPageSchema,
  LifecycleJobPhaseSchema,
  LifecycleQueueJoinSchema,
  WebhookDeliveryPageSchema,
} from '../schemas/hub';

const PageQuery = {
  limit: z.coerce.number().int().min(1).max(200).default(50).describe('Rows to read, capped at 200'),
  offset: z.coerce.number().int().min(0).default(0).describe('Rows to skip before the page starts'),
};

const LifecyclePhasesQuery = z
  .string()
  .optional()
  .transform((raw) =>
    raw
      ? raw
          .split(',')
          .map((phase) => phase.trim())
          .filter((phase) => phase.length > 0)
      : [],
  )
  .pipe(z.array(LifecycleJobPhaseSchema))
  .describe(
    'Comma-separated phases to include; omit for every phase. An unrecognised phase is rejected rather than ignored, so a typo cannot silently widen the listing',
  );

const READ_ONLY =
  'Read-only: nothing is retried, revoked or re-sent. Values are bound as query parameters, never spliced into the statement, and the read runs inside a read-only transaction with a statement timeout. ';

export const hubRoutes = {
  listWebhookDeliveries: {
    method: 'GET',
    path: '/api/hub/webhook-deliveries',
    query: z.object({
      status: DeliveryStatusSchema.optional().describe('Restrict to one delivery state'),
      webhookId: z.string().optional().describe('Restrict to one webhook'),
      ...PageQuery,
    }),
    responses: { 200: WebhookDeliveryPageSchema, 500: ErrorBodySchema },
    summary: 'List webhook deliveries with their attempt, response and processing-lock state',
    description:
      READ_ONLY +
      'Read from the database rather than proxied through the hub API, deliberately: the API paginates in memory after fetching the whole organization and never returns the processing-lock columns, which are how a wedged delivery is diagnosed — a lockedBy that is still set past its lockExpiresAtMs. The parent webhook is joined for its endpoint only; its signing secret is never selected, because that column is the one thing the hub API stopped returning after creation and a debug view must not re-open it. Payloads and response bodies are redacted and byte-capped for display, so what you see is evidence rather than the stored value; each carries its own truncation flag, because they are cut against separate caps.',
  },
  listLifecycleJobs: {
    method: 'GET',
    path: '/api/hub/lifecycle-jobs',
    query: z.object({
      phases: LifecyclePhasesQuery,
      deviceId: z.string().optional().describe('Restrict to one device'),
      ...PageQuery,
    }),
    responses: { 200: LifecycleJobPageSchema, 500: ErrorBodySchema },
    summary: 'List lifecycle-engine jobs, newest first, filterable by phase and device',
    description:
      READ_ONLY +
      'There is no hub or admin route that answers this: the admin API is device-scoped, cannot filter by phase at all, and collapses the ten engine phases into four buckets — losing exactly the DEFERRED and AWAITING_PHONE_HOME distinctions worth debugging. Both filters here are backed by real indexes. A job id is also the plan_id sent to bridges, so it is the join between a queue job and the engine state that produced it. Each row carries its newest timeline event, so a phase like RUNNING says which saga step it is actually on, and the phase census is counted over the whole table rather than the returned page so a tile states a total instead of a window.',
  },
  getLifecycleJob: {
    method: 'GET',
    path: '/api/hub/lifecycle-jobs/:jobId',
    pathParams: z.object({ jobId: z.string().min(1).describe('LifecycleJob.id, which is also the bridge plan_id') }),
    responses: { 200: LifecycleJobDetailSchema, 500: ErrorBodySchema },
    summary: 'Get one lifecycle job with its redacted payload and its step timeline',
    description:
      READ_ONLY +
      'The timeline is the append-only record of every inbound bridge message and engine transition for this job, which otherwise lives only transiently in Redis. A job id that matches nothing returns a null job rather than a 404, so a stale deep link renders as "no such job" instead of an error page. The payload is redacted and capped before it leaves the process: the stored request is replayed verbatim on retry and therefore carries the OS password hash, which must not reach a browser.',
  },
  listDeviceTokens: {
    method: 'GET',
    path: '/api/hub/device-tokens',
    query: z.object({
      deviceId: z.string().optional().describe('Restrict to one device'),
      status: DeviceTokenStatusSchema.optional().describe('Restrict to active or revoked tokens'),
      ...PageQuery,
    }),
    responses: { 200: DeviceTokenPageSchema, 500: ErrorBodySchema },
    summary: 'List device tokens with phone-home recency, identified by their non-secret display id',
    description:
      READ_ONLY +
      'The token hash is never selected — the hub identifies a token by a non-secret displayId derived from it, and that is what this returns. Recency is reported twice because the two answers differ: lastUsedAtMs is the durable column, refreshed on every phone-home but throttled to sixty seconds and therefore up to a minute stale, while usedWithinThrottleWindow reflects the live sentinel and is the fresher signal. Note there is no device-level last-seen column anywhere in the schema, and the server row only moves on an actual status change, so a token is the only reliable evidence that a device is still calling home.',
  },
  getDeviceTokenEvents: {
    method: 'GET',
    path: '/api/hub/device-tokens/:tokenId/events',
    pathParams: z.object({ tokenId: z.string().min(1).describe('DeviceToken.id') }),
    query: z.object({ ...PageQuery }),
    responses: { 200: DeviceTokenEventPageSchema, 500: ErrorBodySchema },
    summary: "Get one token's audit trail, including uses after revocation or expiry",
    description:
      READ_ONLY +
      'Fetched per token rather than joined into the list, so opening the tab does not issue one query per row. The event vocabulary carries two entries worth alarming on rather than merely reading: USED_AFTER_REVOKE and USED_AFTER_EXPIRY both mean something still holds a token it should no longer be able to use.',
  },
  getLifecycleJobQueueJobs: {
    method: 'GET',
    path: '/api/hub/lifecycle-jobs/:jobId/queue-jobs',
    pathParams: z.object({ jobId: z.string().min(1).describe('LifecycleJob.id, which is also the bridge plan_id') }),
    responses: { 200: LifecycleQueueJoinSchema, 500: ErrorBodySchema },
    summary: "Find the saga queue jobs carrying this lifecycle job's plan id",
    description:
      READ_ONLY +
      'The hub composes a saga job id as "<deviceId>-<sagaName>-<planId>", so a lifecycle job and its bridge work are joined through the id rather than through any payload — which is why this still answers for an enrolled zone, whose payloads are sealed ciphertext. The search keys on the device UUID because that is what the id discovery can scan for; a lifecycle job scoped to no device therefore reports joinable false rather than an empty list. Reuses the queue inspector\'s own registry and reader, so the allowlist gate, the scan cap and the sealed-payload handling are the same code and cannot drift. Note that finding nothing is not evidence of a fault: a queue retains completed jobs only as far as its keep-completed policy allows, so a finished lifecycle job routinely has no queue job left.',
  },
} as const;
