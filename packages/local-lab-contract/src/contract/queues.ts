import { z } from 'zod';
import { ErrorBodySchema } from '../schemas/common';
import {
  QueueCleanableStateSchema,
  QueueJobDetailSchema,
  QueueJobPageSchema,
  QueueJobStateSchema,
  QueueMutationResultSchema,
  QueueSummarySchema,
} from '../schemas/queues';

const QueuePathParams = z.object({
  prefix: z.string().describe('BullMQ key prefix of the queue — a Zone UUID, "results", or "bull"'),
  name: z.string().describe('BullMQ queue name (lifecycle, collection, inbox, …)'),
});

const QueueJobPathParams = QueuePathParams.extend({
  jobId: z
    .string()
    .min(1)
    .describe(
      'BullMQ job id within this queue. May contain ":" — a repeatable job\'s id is literally "repeat:<schedulerId>:<millis>". Ids that instead address one of the queue\'s own keys are rejected by the handler as a 404, not here as a 400',
    ),
});

const QueueJobStatesQuery = z
  .string()
  .optional()
  .transform((raw) =>
    raw
      ? raw
          .split(',')
          .map((state) => state.trim())
          .filter((state) => state.length > 0)
      : [],
  )
  .pipe(z.array(QueueJobStateSchema))
  .describe('Comma-separated states to read; omit for every state. An unrecognised state is rejected, never ignored');

export const queuesRoutes = {
  listQueues: {
    method: 'GET',
    path: '/api/queues',
    responses: { 200: z.array(QueueSummarySchema), 500: ErrorBodySchema },
    summary: 'List the hub/spoke BullMQ queues with per-state job counts',
    description:
      'Read-only. Discovers the inventory by unioning the configured zones times the saga queue names with a cursor-based SCAN for existing ":meta" keys, so an orphan queue (a spoke that fell back to the default "bull" prefix) stays visible instead of being filtered out. Each queue then reports BullMQ per-state counts, SCARD of the stalled set, the paused flag, and the registered worker count. A prefix/name is only instantiated once its meta key exists, so opening the inspector never creates a queue.',
  },
  listQueueJobs: {
    method: 'GET',
    path: '/api/queues/:prefix/:name/jobs',
    pathParams: QueuePathParams,
    query: z.object({
      states: QueueJobStatesQuery,
      limit: z.coerce.number().int().min(1).max(200).default(50).describe('Jobs to read per state, capped at 200'),
      offset: z.coerce.number().int().min(0).default(0).describe('Index into each state list to start at'),
      deviceId: z
        .string()
        .uuid()
        .optional()
        .describe(
          'Restrict the listing to one device; must be a UUID, since it is spliced into a SCAN match pattern. Check "deviceFilterSupported" on the response before reading an empty result as an answer',
        ),
    }),
    responses: { 200: QueueJobPageSchema, 404: ErrorBodySchema, 500: ErrorBodySchema },
    summary: 'List the jobs in one queue, filterable by state and by device. Read-only.',
    description:
      'Read-only: nothing is retried, promoted, or removed. 404 when the prefix/name is not in the discovered inventory. The two filter paths differ and the difference matters. Without deviceId this is an index-based window — limit/offset are applied to EACH requested state list and the result is hard-capped at 200 jobs, so a full window sets "truncated" and is only the head of the queue, never a complete answer. With deviceId the device\'s job ids are discovered by cursor-based SCAN of "{prefix}:{name}:*{deviceId}*" — the UUID is matched anywhere in the id, not only leading it, because a hub-local id reads "device-<uuid>-<status>-<epochMs>" — and each is fetched directly, so an empty result means the device genuinely has no jobs rather than none inside a window. A matched id whose own device attribution is a different UUID is dropped, so hitting the plan-id half of an id never reports it as that device\'s job. The global results inbox cannot be filtered this way at all and says so via "deviceFilterSupported". That discovery is capped as well, and because the SCAN restarts from the beginning of the keyspace on every request, ids past the cap are unreachable at every offset rather than merely on this page — "discoveryCapped" reports exactly that and a load-more control must stop on it. Each state is read in its own round trip, so a page is not an atomic snapshot across states: a job a worker moves while the page is being read (wait to active, say) is reported once, at the state it was first seen in. Note that "delayed" is a normal in-flight state for a healthy saga, not a failure.',
  },
  getQueueJob: {
    method: 'GET',
    path: '/api/queues/:prefix/:name/jobs/:jobId',
    pathParams: QueueJobPathParams,
    responses: { 200: QueueJobDetailSchema, 404: ErrorBodySchema, 500: ErrorBodySchema },
    summary:
      'Get one job: timing, attempts, failure detail, and the redacted payload — a sealed job exposes only its AAD header. Read-only.',
    description:
      'Read-only. 404 when the prefix/name is not in the discovered inventory or the job is absent. A job id that names one of the queue\'s own reserved keys (":meta", ":wait", ":delayed", ":stalled", ":id", ":events", …) also 404s and is never read: those keys live in the same namespace as the job hashes, so ":meta" in particular would otherwise read back as a fabricated job. The same holds for a job\'s own side keys ("<id>:processed" is a hash and fabricates just as readily as ":meta") and for a job scheduler\'s hash at "repeat:<schedulerId>" — but a repeatable job itself, "repeat:<schedulerId>:<millis>", is a real job and is served normally. Returns the job\'s timing, attempt count, failedReason and stacktrace. The job payload IS returned as "payload", redacted for display: every secret-keyed value is replaced (a secret-keyed array is reported as its item count), DSN userinfo is masked wherever it appears in a string, and the walk stops at an 8 KiB content budget (the serialized result can modestly exceed it) — "payloadTruncated" tells a prefix from the whole job data, since collector payloads reach several MiB and are never rendered whole. An enrolled zone seals its payloads: such a job reports sealed=true with a null payload — the only readable part of its envelope is the "aad", the cleartext AAD header restricted to the six frozen fields — never the ciphertext, tag, or ephemeral key. Device, saga, and plan are parsed from the job id, so they are present even for a sealed job.',
  },
  retryQueueJob: {
    method: 'POST',
    path: '/api/queues/:prefix/:name/jobs/:jobId/retry',
    pathParams: QueueJobPathParams,
    body: z.object({
      state: z
        .enum(['failed', 'completed'])
        .default('failed')
        .describe(
          'Finished state the job must still be in for the retry to proceed — anything else is a 409, since the job moved on between the page read and this call',
        ),
      resetAttempts: z
        .boolean()
        .default(false)
        .describe('Zero the attempts-made counter on retry, so the job gets its full attempt budget again'),
    }),
    responses: { 200: QueueMutationResultSchema, 404: ErrorBodySchema, 409: ErrorBodySchema },
    summary: 'Retry one finished job back onto the wait list',
    description:
      'Moves a failed or completed job back onto the wait list, optionally zeroing its attempts counter. 404 when the prefix/name is not in the discovered inventory, when the id addresses one of the queue\'s own keys rather than a job, or when the job is absent. 409 when the job is not in the requested finished state — it went active or was removed between the page read and this call. A refusal determined before anything is written (unknown queue or job, the state precheck) mints no run; a retry that is attempted and then refused by the queue mid-write — the state raced away after the precheck, or the job hash was removed after the listing read — is still a 409, but leaves a finalized failed run on purpose as the audit trail of the attempt. A successful retry mints a finalized "queues" run-ledger entry and returns its id. Loopback-only: a valid LAB_API_TOKEN is not sufficient and a remote caller gets 403.',
  },
  removeQueueJob: {
    method: 'DELETE',
    path: '/api/queues/:prefix/:name/jobs/:jobId',
    pathParams: QueueJobPathParams,
    responses: { 200: QueueMutationResultSchema, 404: ErrorBodySchema, 409: ErrorBodySchema },
    summary: 'Remove one job from the queue, keeping its children',
    description:
      'Deletes one job. Children are deliberately kept — the call passes removeChildren: false — and because bullmq only refuses a parent with pending children when it is asked to remove them too, this route counts the unprocessed dependencies itself and refuses with a 409 so the children are never left pointing at a deleted parent. An active job is likewise a 409 because a worker holds its lock; a second remove of an already-removed job reports the same conflict, which is the right answer to a duplicate. A job-scheduler occurrence ("repeat:<schedulerId>:<millis>") is a 409 as well — remove the schedule at its source, not the occurrence. 404s exactly like the job detail read: unknown queue, an id that addresses a queue key, or an absent job. A refusal determined before anything is written mints no run; a remove that is attempted and then refused by the queue mid-write is still a 409, but leaves a finalized failed run on purpose as the audit trail of the attempt. A successful remove mints a finalized "queues" run-ledger entry. Loopback-only: a valid LAB_API_TOKEN is not sufficient and a remote caller gets 403.',
  },
  drainQueue: {
    method: 'POST',
    path: '/api/queues/:prefix/:name/drain',
    pathParams: QueuePathParams,
    body: z.object({
      delayed: z
        .boolean()
        .default(false)
        .describe('Also remove the delayed set; without it only wait, paused, and prioritized jobs are drained'),
    }),
    responses: { 200: QueueMutationResultSchema, 404: ErrorBodySchema },
    summary: 'Remove every pending job from one queue',
    description:
      'Removes every wait, paused, and prioritized job; delayed jobs are removed only when "delayed" is true. Active, completed, failed, and waiting-children jobs are never touched, and a repeatable scheduler\'s current delayed job is spared either way, so draining never breaks a schedule. 404 when the prefix/name is not in the discovered inventory. The minted "queues" run-ledger entry logs the per-state before/after counts. Loopback-only: a valid LAB_API_TOKEN is not sufficient and a remote caller gets 403.',
  },
  cleanQueue: {
    method: 'POST',
    path: '/api/queues/:prefix/:name/clean',
    pathParams: QueuePathParams,
    body: z.object({
      state: QueueCleanableStateSchema,
      grace: z.coerce
        .number()
        .int()
        .min(0)
        .default(0)
        .describe('Only remove jobs whose last state entry is at least this many ms old; 0 removes regardless of age'),
      limit: z.coerce.number().int().min(1).max(10_000).default(1_000).describe('Maximum jobs to remove in one call'),
    }),
    responses: { 200: QueueMutationResultSchema, 404: ErrorBodySchema },
    summary: 'Bulk-remove retained jobs of one state from one queue',
    description:
      'Deletes up to "limit" jobs in "state" that have been in it for at least "grace" ms, and logs the removed count to the minted "queues" run-ledger entry. Only the six cleanable states are accepted: "active" is excluded because a clean would delete a job a worker has locked, and "waiting-children" because removing the parent would orphan its child jobs. A body outside those rules is rejected by request validation before the handler runs. 404 when the prefix/name is not in the discovered inventory. Loopback-only: a valid LAB_API_TOKEN is not sufficient and a remote caller gets 403.',
  },
} as const;
