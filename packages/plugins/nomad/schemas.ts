import { z } from 'zod';

/** Primary shipped jobspec id (filename without .hcl). Shared by contract + runtime allowlist. */
export const BRIDGE_SERVICES_JOBSPEC_ID = 'bridge-services' as const;

/** Allowlisted shipped jobspec ids — single source for Zod contract and filesystem loader. */
export const SHIPPED_JOBSPEC_IDS = [BRIDGE_SERVICES_JOBSPEC_ID] as const;
export type ShippedJobspecId = (typeof SHIPPED_JOBSPEC_IDS)[number];

/** Nomad plugin settings from host env (see README / plugins-config). Nothing hardcoded. */
export const NomadConfigSchema = z
  .object({
    address: z.string().url().describe('Nomad HTTP API base URL (NOMAD_ADDR), e.g. http://127.0.0.1:4646.'),
    token: z.string().min(1).describe('Nomad ACL token SecretID (NOMAD_TOKEN). Sent as the X-Nomad-Token header.'),
    namespace: z
      .string()
      .min(1)
      .default('default')
      .describe('Nomad namespace for API requests (NOMAD_NAMESPACE). Defaults to "default".'),
    region: z.string().min(1).optional().describe('Nomad region (NOMAD_REGION). Omit to use the Nomad agent default.'),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .default(30_000)
      .describe('HTTP client timeout in milliseconds (NOMAD_HTTP_TIMEOUT_MS).'),
    tlsSkipVerify: z
      .boolean()
      .default(false)
      .describe('When true, skip TLS certificate verification (NOMAD_SKIP_VERIFY). Intended for lab use only.'),
    adminOrganizationId: z
      .string()
      .default('')
      .describe(
        'Organization UUID allowed to call the Nomad orchestration API (BROKKR_ADMIN_ORG_ID). ' +
          'Empty string disables the org-id grant, leaving only the instance-operator designation.',
      ),
  })
  .describe('Nomad plugin settings.');

export type NomadConfig = z.infer<typeof NomadConfigSchema>;

export const NomadHealthResponseSchema = z
  .object({
    ok: z.literal(true),
    pluginId: z.literal('nomad'),
  })
  .describe('Liveness stub for the nomad plugin.');

/** Outcome of a single deploy step (validate, plan, or submit). */
export const NomadStepStatusSchema = z.enum(['ok', 'error', 'skipped']);
export type NomadStepStatus = z.infer<typeof NomadStepStatusSchema>;

export const NomadValidateResultSchema = z.object({
  status: NomadStepStatusSchema.describe('Outcome of the Nomad job validation step'),
  errors: z.array(z.string()).optional().describe('Nomad validation errors, if any'),
  warnings: z.string().nullable().optional().describe('Nomad validation warnings, null if none'),
  job: z.record(z.unknown()).optional().describe('Parsed Job JSON when parse succeeded (handy for plan/submit)'),
  jobId: z.string().nullable().optional().describe('Job ID from the parsed Job, null if unavailable'),
});
export type NomadValidateResult = z.infer<typeof NomadValidateResultSchema>;

export const NomadPlanResultSchema = z.object({
  status: NomadStepStatusSchema.describe('Outcome of the Nomad plan step'),
  error: z.string().nullable().optional().describe('Error message if the plan step failed'),
  diffSummary: z.string().nullable().optional().describe('Human-readable plan diff summary'),
  failedPlacements: z.boolean().describe('True if the plan reported FailedTGAllocs'),
  warnings: z.string().nullable().optional().describe('Nomad plan warnings, null if none'),
  jobId: z.string().nullable().optional().describe('Job ID used for the plan'),
});
export type NomadPlanResult = z.infer<typeof NomadPlanResultSchema>;

export const NomadSubmitResultSchema = z.object({
  status: NomadStepStatusSchema.describe('Outcome of the Nomad job submission step'),
  error: z.string().nullable().optional().describe('Error message if submission failed'),
  evalId: z.string().nullable().describe('Nomad evaluation ID on success, null otherwise'),
  jobId: z.string().nullable().describe('Registered Nomad job ID, null otherwise'),
  submittedAt: z.string().nullable().optional().describe('ISO 8601 submit time when status is ok'),
});
export type NomadSubmitResult = z.infer<typeof NomadSubmitResultSchema>;

/** Body for POST /plugins/nomad/stop (deregister). */
export const NomadStopRequestSchema = z
  .object({
    jobId: z.string().min(1).describe('Registered Nomad job ID to stop/deregister'),
    purge: z.boolean().optional().describe('When true, purge the job from Nomad GC history (default false)'),
    namespace: z.string().min(1).optional().describe('Nomad namespace override for this request'),
  })
  .describe('Stop/deregister a registered Nomad job');
export type NomadStopRequest = z.infer<typeof NomadStopRequestSchema>;

export const NomadStopResultSchema = z.object({
  status: NomadStepStatusSchema.describe('Outcome of the Nomad stop/deregister step'),
  error: z.string().nullable().optional().describe('Error message if stop failed'),
  evalId: z.string().nullable().describe('Nomad evaluation ID on success, null otherwise'),
  jobId: z.string().nullable().describe('Job ID that was stopped, null if unavailable'),
  purge: z.boolean().describe('Whether purge was requested'),
});
export type NomadStopResult = z.infer<typeof NomadStopResultSchema>;

/** Query for GET /plugins/nomad/allocs. */
export const NomadAllocsQuerySchema = z.object({
  jobId: z
    .string()
    .min(1)
    .describe('Nomad job ID to list allocations for (dispatched child IDs like "facts/dispatch-..." work)'),
  namespace: z.string().min(1).optional().describe('Nomad namespace override for this request'),
});
export type NomadAllocsQuery = z.infer<typeof NomadAllocsQuerySchema>;

export const NomadAllocTaskStateSchema = z.object({
  task: z.string().describe('Task name'),
  state: z.string().describe('Raw Nomad task state (pending, running, dead)'),
  failed: z.boolean().describe('True if the task has Failed: true'),
  finishedAt: z.string().nullable().describe('ISO 8601 finish time, null if not finished or unavailable'),
});
export type NomadAllocTaskState = z.infer<typeof NomadAllocTaskStateSchema>;

export const NomadAllocSummarySchema = z.object({
  id: z.string().describe('Allocation ID'),
  name: z.string().nullable().describe('Allocation name, null if unavailable'),
  nodeId: z.string().nullable().describe('ID of the node the alloc is placed on, null if unavailable'),
  nodeName: z.string().nullable().describe('Name of the node the alloc is placed on, null if unavailable'),
  clientStatus: z.string().describe('Client status (pending, running, complete, failed, lost)'),
  taskGroup: z.string().nullable().describe('Task group name, null if unavailable'),
  tasks: z.array(NomadAllocTaskStateSchema).describe('Per-task state summary'),
  createTime: z.number().nullable().describe('Alloc CreateTime (Unix nanoseconds), null if unavailable'),
  modifyTime: z.number().nullable().describe('Alloc ModifyTime (Unix nanoseconds), null if unavailable'),
});
export type NomadAllocSummary = z.infer<typeof NomadAllocSummarySchema>;

export const NomadAllocsResultSchema = z.object({
  status: NomadStepStatusSchema.describe('Outcome of the Nomad allocations read'),
  error: z.string().nullable().optional().describe('Error message if the read failed'),
  jobId: z.string().describe('Job ID the allocations belong to'),
  allocs: z.array(NomadAllocSummarySchema).describe('Allocation summaries, empty on error'),
});
export type NomadAllocsResult = z.infer<typeof NomadAllocsResultSchema>;

/** Query for GET /plugins/nomad/job. */
export const NomadJobQuerySchema = z.object({
  jobId: z.string().min(1).describe('Registered Nomad job ID to read'),
  namespace: z.string().min(1).optional().describe('Nomad namespace override for this request'),
});
export type NomadJobQuery = z.infer<typeof NomadJobQuerySchema>;

export const NomadJobTaskSchema = z.object({
  task: z.string().describe('Task name'),
  config: z.record(z.unknown()).nullable().describe('Task driver Config (image, args, ...), null if unavailable'),
  resources: z
    .object({
      cpu: z.number().nullable().describe('CPU reservation in MHz, null if unavailable'),
      memoryMB: z.number().nullable().describe('Memory reservation in MB, null if unavailable'),
    })
    .describe('Task resource reservations'),
  env: z.record(z.string()).nullable().describe('Task Env key/value pairs, null if unavailable'),
});
export type NomadJobTask = z.infer<typeof NomadJobTaskSchema>;

export const NomadJobTaskGroupSchema = z.object({
  name: z.string().describe('Task group name'),
  tasks: z.array(NomadJobTaskSchema).describe('Tasks in the group'),
});
export type NomadJobTaskGroup = z.infer<typeof NomadJobTaskGroupSchema>;

export const NomadJobReadResultSchema = z.object({
  status: NomadStepStatusSchema.describe('Outcome of the Nomad job read'),
  error: z.string().nullable().optional().describe('Error message if the read failed'),
  jobId: z.string().describe('Job ID that was read'),
  name: z.string().nullable().describe('Nomad job Name, null if unavailable'),
  jobStatus: z.string().nullable().describe('Nomad job Status (pending, running, dead), null if unavailable'),
  taskGroups: z.array(NomadJobTaskGroupSchema).describe('Task groups with task Config/Resources/Env, empty on error'),
});
export type NomadJobReadResult = z.infer<typeof NomadJobReadResultSchema>;

/** Body for POST /plugins/nomad/dispatch (parameterized job dispatch). */
export const NomadDispatchRequestSchema = z
  .object({
    jobId: z.string().min(1).describe('Parameterized Nomad job ID to dispatch'),
    meta: z
      .record(z.string())
      .optional()
      .describe('Dispatch metadata key/value pairs (must satisfy the job parameterized block)'),
    payload: z.string().optional().describe('Opaque payload string; base64-encoded by the plugin for Nomad Payload'),
    namespace: z.string().min(1).optional().describe('Nomad namespace override for this request'),
  })
  .describe('Dispatch an instance of a parameterized Nomad job');
export type NomadDispatchRequest = z.infer<typeof NomadDispatchRequestSchema>;

export const NomadDispatchResultSchema = z.object({
  status: NomadStepStatusSchema.describe('Outcome of the Nomad dispatch step'),
  error: z.string().nullable().optional().describe('Error message if dispatch failed'),
  dispatchedJobId: z.string().nullable().describe('Nomad DispatchedJobID on success, null otherwise'),
  evalId: z.string().nullable().describe('Nomad evaluation ID on success, null otherwise'),
  jobId: z.string().describe('Parent parameterized job ID the dispatch targeted'),
});
export type NomadDispatchResult = z.infer<typeof NomadDispatchResultSchema>;

export const NomadLogTypeSchema = z.enum(['stdout', 'stderr']);
export type NomadLogType = z.infer<typeof NomadLogTypeSchema>;

export const NomadLogOriginSchema = z.enum(['start', 'end']);
export type NomadLogOrigin = z.infer<typeof NomadLogOriginSchema>;

/** Query for GET /plugins/nomad/logs — a bounded single-shot tail, not a stream. */
export const NomadLogsQuerySchema = z.object({
  allocId: z.string().min(1).describe('Allocation ID to read logs from'),
  task: z.string().min(1).describe('Task name within the allocation'),
  type: NomadLogTypeSchema.default('stdout').describe('Log stream to read (stdout or stderr)'),
  origin: NomadLogOriginSchema.default('end').describe('Read from the start or the end of the log (default end)'),
  offset: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(16_384)
    .describe('Byte offset relative to origin (with origin=end this is the tail size; default 16384)'),
  namespace: z.string().min(1).optional().describe('Nomad namespace override for this request'),
});
export type NomadLogsQuery = z.infer<typeof NomadLogsQuerySchema>;

export const NomadLogsResultSchema = z.object({
  status: NomadStepStatusSchema.describe('Outcome of the Nomad log read'),
  error: z.string().nullable().optional().describe('Error message if the read failed'),
  text: z.string().nullable().describe('Raw log text (plain=true), null on error'),
  allocId: z.string().describe('Allocation ID the logs were read from'),
  task: z.string().describe('Task name the logs were read from'),
  type: NomadLogTypeSchema.describe('Log stream that was read'),
  origin: NomadLogOriginSchema.describe('Origin the offset was applied to'),
  offset: z.number().describe('Byte offset that was applied'),
});
export type NomadLogsResult = z.infer<typeof NomadLogsResultSchema>;

/** Query for GET /plugins/nomad/nodes. */
export const NomadNodesQuerySchema = z.object({
  nodeId: z
    .string()
    .min(1)
    .optional()
    .describe('When set, read the single node via GET /v1/node/:id (includes meta); otherwise list all nodes'),
});
export type NomadNodesQuery = z.infer<typeof NomadNodesQuerySchema>;

export const NomadNodeDriverStatusSchema = z.object({
  detected: z.boolean().nullable().describe('Driver Detected flag, null when Nomad omits it'),
  healthy: z.boolean().nullable().describe('Driver Healthy flag, null when Nomad omits it'),
});
export type NomadNodeDriverStatus = z.infer<typeof NomadNodeDriverStatusSchema>;

export const NomadNodeSchema = z.object({
  id: z.string().describe('Nomad node ID'),
  name: z.string().describe('Nomad node name'),
  status: z.string().describe('Node status (ready, down, ...)'),
  schedulingEligibility: z.string().describe('Scheduling eligibility (eligible, ineligible)'),
  datacenter: z.string().nullable().describe('Node datacenter, null if unavailable'),
  nodePool: z.string().nullable().describe('Node pool, null if unavailable'),
  address: z.string().nullable().describe('Node address (IP on list reads, HTTP address on detail reads)'),
  version: z.string().nullable().describe('Nomad agent version, null if unavailable'),
  drivers: z.record(NomadNodeDriverStatusSchema).describe('Driver name → detected/healthy summary'),
  meta: z
    .record(z.string())
    .nullable()
    .describe('Node Meta; populated only on nodeId detail reads (list stubs omit it), null otherwise'),
});
export type NomadNode = z.infer<typeof NomadNodeSchema>;

export const NomadNodesResultSchema = z.object({
  status: NomadStepStatusSchema.describe('Outcome of the Nomad nodes read'),
  error: z.string().nullable().optional().describe('Error message if the read failed'),
  nodes: z.array(NomadNodeSchema).describe('Nodes (single element when nodeId was given), empty on error'),
});
export type NomadNodesResult = z.infer<typeof NomadNodesResultSchema>;

export const NomadStartupStageSchema = z.enum([
  'submitted',
  'scheduling',
  'placed',
  'starting',
  'running',
  'completed',
  'failed',
  'timed_out',
]);
export type NomadStartupStage = z.infer<typeof NomadStartupStageSchema>;

export const NomadStartupTaskStatusSchema = z.object({
  task: z.string().describe('Name of the Nomad task'),
  taskGroup: z.string().describe('Name of the Nomad task group'),
  allocId: z.string().describe('Allocation ID'),
  state: z.string().describe('Raw Nomad task state'),
  startedAt: z.string().nullable().describe('ISO 8601 start time, null if not started'),
  failed: z.boolean().describe('True if the task has Failed: true'),
  failureReason: z.string().nullable().optional().describe('Failing event DisplayMessage, if any'),
  detail: z.string().nullable().optional().describe('Most recent task event message, if any'),
});
export type NomadStartupTaskStatus = z.infer<typeof NomadStartupTaskStatusSchema>;

export const NomadStartupStatusSchema = z.object({
  stage: NomadStartupStageSchema.describe('Current lifecycle stage of job startup'),
  done: z.boolean().describe('True once polling has reached a terminal verdict'),
  ok: z.boolean().nullable().describe('True if started cleanly, false if failed, null while in progress'),
  tasks: z.array(NomadStartupTaskStatusSchema).describe('Per-task status snapshot'),
  failures: z.array(z.string()).describe('Human-readable failure reasons'),
  softTimeoutReached: z.boolean().describe('True once the soft timeout has elapsed without a terminal verdict'),
  message: z.string().nullable().optional().describe('Optional status note'),
});
export type NomadStartupStatus = z.infer<typeof NomadStartupStatusSchema>;

/** Variable values for Nomad parse (serialized as JSON for the Variables field). */
export const NomadVariablesSchema = z.record(z.union([z.string(), z.number(), z.boolean()]));
export type NomadVariables = z.infer<typeof NomadVariablesSchema>;

/** Shared body for validate / plan / submit: parsed job, inline HCL, or shipped jobspec id. */
export const NomadJobRequestSchema = z
  .object({
    jobspecId: z
      .enum(SHIPPED_JOBSPEC_IDS)
      .optional()
      .describe('Shipped jobspec id. Used when job and jobHCL are omitted (defaults to bridge-services).'),
    jobHCL: z.string().min(1).optional().describe('Inline Nomad job HCL. Takes precedence over jobspecId.'),
    job: z.record(z.unknown()).optional().describe('Already-parsed Nomad Job JSON; skips parse when set.'),
    variables: NomadVariablesSchema.optional().describe('Values for Nomad parse Variables (JSON-encoded).'),
    namespace: z.string().min(1).optional().describe('Nomad namespace override for this request.'),
    diff: z.boolean().optional().describe('Plan only: request a Diff object (default true).'),
  })
  .describe('Job input for validate / plan / submit.');

export type NomadJobRequest = z.infer<typeof NomadJobRequestSchema>;

export const NomadStatusQuerySchema = z.object({
  jobId: z.string().min(1).describe('Registered Nomad job ID to poll'),
  submittedAt: z
    .string()
    .datetime()
    .optional()
    .describe('ISO 8601 submit time; used to derive elapsedMs when elapsedMs is omitted'),
  elapsedMs: z.coerce
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Elapsed ms since submit (overrides submittedAt)'),
  softTimeoutMs: z.coerce.number().int().positive().optional().describe('Soft timeout override in ms'),
  hardTimeoutMs: z.coerce.number().int().positive().optional().describe('Hard timeout override in ms'),
  oneShot: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true')
    .describe('When true, all-running is not terminal; wait for complete'),
  namespace: z.string().min(1).optional().describe('Nomad namespace override'),
});
export type NomadStatusQuery = z.infer<typeof NomadStatusQuerySchema>;
