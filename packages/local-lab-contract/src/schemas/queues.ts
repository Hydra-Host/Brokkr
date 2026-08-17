import { z } from 'zod';

export const QueueKindSchema = z
  .enum(['saga', 'results', 'hub'])
  .describe(
    'Which queue family this is: saga (a per-zone hub→spoke saga queue), results (the single global spoke→hub results inbox), hub (a hub-local queue under the default "bull" prefix)',
  );
export type QueueKind = z.infer<typeof QueueKindSchema>;

export const QueueRefSchema = z.object({
  prefix: z
    .string()
    .describe(
      'BullMQ key prefix — the Zone UUID for saga queues, "results" for the inbox, "bull" for hub-local queues. A prefix that is not a configured zone id is an orphan (a spoke that fell back to the default prefix)',
    ),
  name: z.string().describe('BullMQ queue name, i.e. the middle segment of its Redis keys (lifecycle, inbox, …)'),
  kind: QueueKindSchema,
});
export type QueueRef = z.infer<typeof QueueRefSchema>;

export const QueueCountsSchema = z.object({
  wait: z.number().int().describe('Jobs queued and waiting for a worker to pick them up'),
  active: z.number().int().describe('Jobs currently checked out by a worker'),
  paused: z.number().int().describe('Jobs parked in the paused list, waiting for the queue to resume'),
  delayed: z.number().int().describe('Jobs scheduled to become ready at a future timestamp'),
  prioritized: z.number().int().describe('Jobs waiting in the priority set rather than the plain wait list'),
  'waiting-children': z.number().int().describe('Parent jobs blocked until their child jobs finish'),
  completed: z.number().int().describe('Retained finished jobs (bounded by the keep-completed policy of the queue)'),
  failed: z.number().int().describe('Retained failed jobs that exhausted their attempts'),
});
export type QueueCounts = z.infer<typeof QueueCountsSchema>;

export const QueueSummarySchema = QueueRefSchema.extend({
  counts: QueueCountsSchema.describe('Per-state job counts as reported by BullMQ for this queue'),
  stalled: z
    .number()
    .int()
    .describe('Size of the stalled set — a Redis SET that the BullMQ job-count call does not cover, read via SCARD'),
  paused: z
    .boolean()
    .nullable()
    .describe(
      'Whether the queue itself is paused, so workers will not take new jobs from it. Null when that probe failed, which is not the same as false — the pause state could not be determined',
    ),
  workers: z
    .number()
    .int()
    .nullable()
    .describe(
      'Number of workers currently registered against this queue. Null when the worker probe (a Redis CLIENT LIST call) failed, which is not the same as zero — the worker count could not be determined',
    ),
  inFlight: z
    .number()
    .int()
    .describe('Display total of the not-yet-finished states (wait + active + paused + delayed + prioritized)'),
  readError: z
    .string()
    .nullable()
    .describe(
      'Null when the counts on this row were read successfully, including for a queue that simply does not exist yet. Otherwise the reason the counts read failed, in which case every count on the row is a placeholder zero and not a measurement — an unreadable queue must never be presented as an empty one. A failure of only the paused or workers probe stays null here and nulls that field instead',
    ),
});
export type QueueSummary = z.infer<typeof QueueSummarySchema>;

export const QUEUE_JOB_STATES = [
  'wait',
  'active',
  'paused',
  'delayed',
  'prioritized',
  'waiting-children',
  'completed',
  'failed',
] as const;

export const QueueJobStateSchema = z
  .enum(QUEUE_JOB_STATES)
  .describe(
    'A BullMQ job state, the same vocabulary as the per-state counts. "delayed" is a normal in-flight state here and not a failure or a retry signal: cross-bridge agent handoff, lock loss, and device-lock contention all re-delay a job without consuming an attempt, so a healthy saga sits in delayed with an unchanged attemptsMade',
  );
export type QueueJobState = z.infer<typeof QueueJobStateSchema>;

export const QueueJobObservedStateSchema = z
  .enum([...QUEUE_JOB_STATES, 'unknown'])
  .describe(
    'The state the job was actually found in. "unknown" means BullMQ could not place it in any state list, which normally means it was finished or removed between discovery and this read. A job parked in a paused queue reports "wait" — BullMQ\'s per-job state lookup does not distinguish the paused list',
  );
export type QueueJobObservedState = z.infer<typeof QueueJobObservedStateSchema>;

export const QueueJobSchema = z.object({
  id: z.string().describe('BullMQ job id — for a saga job the hub composes it as "<deviceId>-<sagaName>[-<planId>]"'),
  name: z
    .string()
    .describe(
      'BullMQ job name (saga.run, job.result, discovery.complete, …). Deliberately a plain string: the hub owns the name set and the control center must not carry a copy of it that can drift',
    ),
  state: QueueJobObservedStateSchema,
  attemptsMade: z
    .number()
    .int()
    .describe(
      'Attempts consumed so far. A re-delay for agent handoff or lock contention deliberately does not raise this, so a climbing count means real processing failures',
    ),
  timestamp: z.number().nullable().describe('Epoch ms when the job was created, or null if the hash carries no stamp'),
  processedOn: z.number().nullable().describe('Epoch ms a worker last started processing the job; null if never'),
  finishedOn: z
    .number()
    .nullable()
    .describe('Epoch ms the job completed or failed for the last time; null if unfinished'),
  delay: z.number().int().describe('Configured delay in ms; non-zero while the job waits in the delayed set'),
  failedReason: z.string().nullable().describe('Failure message from the last failed attempt, or null'),
  deviceId: z
    .string()
    .nullable()
    .describe(
      'Device UUID parsed out of the job id, or null when the id names no device — either it is not saga-shaped, or the UUID it carries equals the queue prefix, which for a saga queue IS the zone: the zone-scoped sagas (enrich_via_pxe, network_scan) are enqueued with the zone id in the device slot, so such an id is provably not device-scoped and the zone is reported under zoneId instead. Read from the id, never the payload, so it survives a sealed job',
    ),
  sagaName: z
    .string()
    .nullable()
    .describe('Saga name parsed out of the job id, or null when the id is not saga-shaped'),
  planId: z
    .string()
    .nullable()
    .describe('Lifecycle plan UUID parsed off the tail of the job id, or null when the id carries no plan'),
  sealed: z
    .boolean()
    .describe(
      'True when the payload is a sealed zone envelope (an enrolled zone encrypts hub↔spoke payloads). Only its cleartext AAD header can be shown; the ciphertext never leaves the datastore',
    ),
  zoneId: z
    .string()
    .nullable()
    .describe(
      'Zone the job belongs to. Attributed from the job itself where it says so — payload zone_prefix, zone_id for a render request, or the sealed AAD zone_id — which is load-bearing for the global results inbox, whose queue prefix does not identify the sending zone. Otherwise, and for a saga queue only, the queue prefix, which IS the zone UUID: a plaintext hub-to-bridge saga payload carries no zone field at all, so this is the answer for every saga job in an unenrolled zone. Null when neither applies, i.e. a results-inbox or hub-queue job whose payload names no zone. A value that disagrees with the queue prefix on a saga queue is reported as found rather than corrected — that is a mis-sealed envelope worth seeing',
    ),
});
export type QueueJob = z.infer<typeof QueueJobSchema>;

// A whitelist of the six frozen AAD fields, not a passthrough record: the header is safe to render because
// this shape cannot carry anything else, whatever the envelope actually holds.
export const QueueJobAadSchema = z.object({
  aad_v: z.number().int().describe('AAD schema version the sealing side stamped'),
  zone_id: z.string().describe('Zone the envelope was sealed for or by'),
  queue_name: z.string().describe('Queue name bound into the AAD, which a decrypt checks against the real queue'),
  direction: z.string().describe('Seal direction — hub_to_bridge or bridge_to_hub'),
  job_id: z.string().describe('Job id bound into the AAD, so an envelope cannot be replayed onto another job'),
  created_at: z.number().describe('Epoch ms the envelope was sealed'),
});
export type QueueJobAad = z.infer<typeof QueueJobAadSchema>;

export const QueueJobDetailSchema = QueueJobSchema.extend({
  aad: QueueJobAadSchema.nullable().describe(
    "A sealed job's cleartext AAD header — the only part of a sealed envelope that is readable, and cleartext by construction since a decrypt must verify it. Null for an unsealed job, and null when the header is absent or not all six fields. The ciphertext, tag, and ephemeral key are never exposed",
  ),
  payload: z
    .unknown()
    .nullable()
    .describe(
      'The job payload with every secret-keyed value replaced (secret arrays reported as a count), DSN userinfo masked, and the walk stopped by an 8 KiB content budget — the rendered result stays within a small multiple of it, so it is safe to render. Null for a sealed job — the only readable part of its envelope is the aad header — and when the job data is not a JSON object',
    ),
  payloadTruncated: z
    .boolean()
    .describe(
      'True when the content budget cut the payload short, so what is shown is a prefix and not the whole job data — collector payloads reach several MiB and are never rendered whole',
    ),
  stacktrace: z.array(z.string()).describe('Stack frames BullMQ retained for the failed attempts, oldest first'),
});
export type QueueJobDetail = z.infer<typeof QueueJobDetailSchema>;

export const QueueMutationResultSchema = z.object({
  runId: z.string().describe('Run ledger id minted for the mutation; finalized before the response returns'),
});
export type QueueMutationResult = z.infer<typeof QueueMutationResultSchema>;

export const QueueCleanableStateSchema = z
  .enum(['completed', 'failed', 'wait', 'paused', 'delayed', 'prioritized'])
  .describe(
    'The states a queue clean may target. "active" is deliberately not cleanable — it would delete locked in-flight work — and neither is "waiting-children", whose removal would orphan the child jobs the parent is parked on',
  );
export type QueueCleanableState = z.infer<typeof QueueCleanableStateSchema>;

export const QueueJobPageSchema = z.object({
  queue: QueueRefSchema.describe('The resolved queue this page was read from'),
  states: z.array(QueueJobStateSchema).describe('States actually read, i.e. the requested filter or every state'),
  limit: z.number().int().describe('Requested page size — the window applied per state, not a total across states'),
  offset: z
    .number()
    .int()
    .describe('Requested index into each state list; BullMQ getters are index-based, not cursored'),
  deviceId: z
    .string()
    .nullable()
    .describe('The device filter this page was read under, or null when the page is a plain state window'),
  deviceFilterSupported: z
    .boolean()
    .describe(
      'Whether a device filter can be answered at all for this queue, which is a property of the queue and is reported whether or not deviceId was passed. True for saga and hub queues, whose job ids carry the device UUID. False for the global results inbox: its jobs are enqueued without an explicit id, so BullMQ numbers them 1, 2, 3 and the device appears only in the payload, which is ciphertext for an enrolled zone. A device-filtered read of such a queue returns an empty jobs array that means "cannot be determined from job ids" and must never be presented as "this device has no jobs here"',
    ),
  cap: z.number().int().describe('Hard job ceiling applied on top of limit, regardless of what was requested'),
  jobs: z
    .array(QueueJobSchema)
    .describe('The jobs found, in queue order per state, or newest-first when device-filtered'),
  truncated: z
    .boolean()
    .describe(
      'True when this page is not the whole answer, so jobs beyond it exist or may exist. On the plain state-window path that means a per-state window filled or the hard cap cut the read short, and raising offset reaches the rest. On the device-filter path it means the discovered set is larger than this window, and raising offset reaches the rest of THAT set only — never past the discovery cap, which is what discoveryCapped reports. A truncated page must never be read as "no more jobs for this device"',
    ),
  discoveryCapped: z
    .boolean()
    .describe(
      'Device-filter path only; always false without a deviceId. True when the job-id SCAN hit the cap, so the listing was assembled from only the first "cap" ids found. Those are also the only jobs this endpoint can reach for the device: the scan restarts from the beginning of the keyspace on every request, so raising offset re-reads the same ids and never advances past the cap. The count of jobs beyond it is unknown and they are not pageable — a load-more control must stop here rather than requesting a further offset',
    ),
});
export type QueueJobPage = z.infer<typeof QueueJobPageSchema>;
