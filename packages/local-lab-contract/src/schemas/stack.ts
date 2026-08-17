import { z } from 'zod';
import { ProcHealthSchema, StackCountsSchema, StackSlotSchema } from './common';
import { FleetPendingSchema } from './fleet';

export { StackSlotSchema } from './common';

export const StackOpSchema = z.object({
  id: z.string().describe('Stable op id'),
  label: z.string().describe('Human label'),
  task: z.string().describe('Short prose summary of the underlying command sequence'),
  description: z.string().describe('What the op does, shown in the info popover'),
  section: z.enum(['stack', 'fleet']).describe('Which control-center section owns the op'),
  group: z.enum(['status', 'bringup', 'destructive']).describe('Category the op is shown under'),
  destructive: z.boolean().describe('Whether the op tears down / wipes state'),
  needsSudo: z.boolean().describe('Whether the op requires root (e.g. vbmcd on :623)'),
});
export type StackOp = z.infer<typeof StackOpSchema>;

/** Cross-process invariant: the lab reports `stale` while it is alive, but the case that matters is a
 *  recreation that never restores the API, so the client must apply the same bound during the outage. */
export const RESTART_STALE_AFTER_MS = 30 * 60 * 1000;

export const RESTART_STALE_AFTER_LABEL = `${RESTART_STALE_AFTER_MS / 60_000} minutes`;

export const RestartStatusSchema = z
  .enum(['idle', 'pending', 'stale', 'failed'])
  .describe(
    `Single discriminant for the detached stack recreation. idle = nothing in flight (render nothing); pending = the API may drop and come back under it; stale = still pending past ${RESTART_STALE_AFTER_LABEL}, read the log instead of waiting; failed = the child recorded a non-zero wipe or bring-up, see logPath. Branch on this — there is deliberately no separate pending/failed boolean to get the precedence wrong.`,
  );
export type RestartStatus = z.infer<typeof RestartStatusSchema>;

export const RestartStateSchema = z.object({
  status: RestartStatusSchema,
  reason: z.string().optional().describe('Why the restart was started, e.g. "reinit (nuke + rebuild)"'),
  opId: z.string().optional().describe('Stack op that launched the restart'),
  runId: z.string().optional().describe('Run the restart was launched from; its log holds the pre-detach output'),
  startedAt: z.number().optional().describe('Epoch ms the restart child was spawned'),
  logPath: z
    .string()
    .optional()
    .describe('Host path the detached child appends its own output to, including a refused wipe’s reason'),
});
export type RestartState = z.infer<typeof RestartStateSchema>;

export const InitTaskSchema = z.object({
  name: z.string().describe('devenv task name, colons included (e.g. "hub:init")'),
  label: z.string().describe('Display name; falls back to the raw task name for an unmapped task'),
  state: z
    .enum(['pending', 'running', 'completed', 'failed'])
    .describe(
      'pending = did not run this bring-up (cached or gated); running = the log is fresh with no result yet; completed/failed = this bring-up’s exit-status sidecar',
    ),
  exitCode: z.number().nullable().describe('Exit code from the status sidecar; null unless the task finished'),
  detail: z.string().nullable().describe('One-line human status — the log tail on a failure, else null'),
  updatedAt: z.number().nullable().describe('Epoch ms of the newest artifact (log or status) for this task'),
});
export type InitTask = z.infer<typeof InitTaskSchema>;

/** What the collapsed strip reports and what its log button opens: a failure outranks a task still
 *  running, being the one an operator has to act on. */
export const initFocusTask = (tasks: InitTask[]): InitTask | undefined =>
  tasks.find((t) => t.state === 'failed') ?? tasks.find((t) => t.state === 'running');

export const initAggregateState = (tasks: InitTask[]): InitTask['state'] =>
  initFocusTask(tasks)?.state ?? (tasks.some((t) => t.state === 'completed') ? 'completed' : 'pending');

export const DatastoreStatusSchema = z.object({
  id: z.string().describe('postgres | redis | nginx | thanos'),
  label: z.string(),
  status: ProcHealthSchema,
  restarts: z.number().optional().describe('process-compose restart count (climbing ⇒ crash-looping)'),
  exitCode: z.number().optional().describe('last exit code when stopped/failed'),
  detail: z.string().optional().describe('human one-liner: blocked-on reason, or the last error line from the log'),
});
// MUST stay identical to apps/local-sim/scripts/local/progress.py (Phase/Step) — parity test enforces it.
export const BringupPhaseSchema = z
  .enum(['idle', 'init', 'up', 'supervising', 'down'])
  .describe('Coarse bring-up phase: init=building artifacts; up=render/daemons/power-on; supervising=ready+blocking.');

export const BringupStepSchema = z
  .enum([
    'build-live-img',
    'build-agent-img',
    'build-grub',
    'prefetch',
    'build-ipxe',
    'render',
    'daemons',
    'power-on',
    'ready',
    'tearing-down',
    'idle',
  ])
  .describe(
    'Fine bring-up step. The first nine are the ordered happy-path sequence (stepOrdinal indexes them); tearing-down/idle are off-sequence.',
  );

export const FleetHealthSchema = z
  .enum(['ready', 'coming-up', 'stopped', 'failed', 'disabled', 'idle'])
  .describe(
    'Fleet health: ready=all VMs running; coming-up=building/powering on; stopped=down (Start to bring up); failed=crashed; disabled=autoStart off; idle=never started.',
  );
export type BringupPhase = z.infer<typeof BringupPhaseSchema>;
export type BringupStep = z.infer<typeof BringupStepSchema>;
export type FleetHealth = z.infer<typeof FleetHealthSchema>;

export const FleetStatusSchema = z.object({
  health: FleetHealthSchema,
  phase: BringupPhaseSchema.nullable().describe('Current bring-up phase, or null when no progress is recorded.'),
  step: BringupStepSchema.nullable().describe('Current bring-up step, or null.'),
  label: z.string().nullable().describe('Human-readable current step, e.g. "building per-VM iPXE binary for cpu-3".'),
  node: z.string().nullable().describe('The node the current step is working on, if any.'),
  index: z.number().describe('1-based per-node sub-progress within the current step (0 if N/A).'),
  total: z.number().describe('Per-node total for the current step / fleet node count (0 if N/A).'),
  stepOrdinal: z.number().describe('0-based position of step in the happy-path sequence; -1 if off-sequence.'),
  stepCount: z.number().describe('Length of the happy-path bring-up sequence (drives the overall progress bar).'),
  elapsedSec: z.number().nullable().describe('Seconds since bring-up started, or null.'),
  machinesExpected: z.number().describe('Number of nodes in the active fleet config.'),
  machinesRunning: z.number().describe('Number of fleet domains currently powered on.'),
  detail: z.string().describe('One-line human status for the card.'),
});
export type FleetStatus = z.infer<typeof FleetStatusSchema>;

export const StackStateSchema = z.object({
  datastoresUp: z.boolean().describe('All datastore containers are up'),
  datastores: z.array(DatastoreStatusSchema).describe('Per-container datastore state (postgres/redis/nginx/thanos)'),
  fleetProcesses: z
    .array(DatastoreStatusSchema)
    .describe('Fleet-plumbing processes (e.g. macOS virtqemud) — present only when process-compose reports them'),
  fleet: FleetStatusSchema.describe(
    'Composed fleet bring-up status (health + progress + machine counts) for the Fleet card.',
  ),
  fleetPending: FleetPendingSchema.optional().describe(
    'Desired-vs-applied fleet drift (banner on the Stack/Fleet tabs)',
  ),
});

export const ProcessEnvVarSchema = z.object({
  key: z.string(),
  value: z.string().describe('Masked to *** for secret keys unless the request passed ?reveal=true'),
  secret: z.boolean().describe('Key matched the secret heuristic (password/token/secret/_key/DSN)'),
  origin: z
    .enum(['process', 'live-only'])
    .describe(
      "'process' = the rendered pc config's per-process env; 'live-only' = present in /proc but not configured (shell-inherited or an exec-time sidecar)",
    ),
});
export const ProcessEnvSchema = z.object({
  name: z.string().describe('process-compose process name'),
  source: z
    .enum(['configured', 'live'])
    .describe(
      "'configured' = parsed from the rendered process-compose config (cross-platform); 'live' = read from /proc/<pid>/environ (Linux, running, readable)",
    ),
  note: z
    .string()
    .optional()
    .describe('Why live was unavailable (macOS / sudo-owned / stopped), when source is configured'),
  vars: z.array(ProcessEnvVarSchema),
  driftKeys: z
    .array(z.string())
    .optional()
    .describe('Configured keys whose live value differs (only when source=live)'),
});
export type ProcessEnv = z.infer<typeof ProcessEnvSchema>;
export type ProcessEnvVar = z.infer<typeof ProcessEnvVarSchema>;

export const StackKnobSchema = z.object({
  env: z.string(),
  label: z.string(),
  default: z.string(),
  kind: z.enum(['text', 'select', 'number', 'bool']),
  options: z.array(z.string()).optional(),
  group: z.string().describe('UI sub-section (Logging, Workers, URLs, …)'),
  danger: z.boolean().optional().describe('Render the field in red — toggling it can break the stack'),
  info: z.string().optional().describe('Tooltip shown in an ⓘ bubble next to the field'),
});
export const StackPortSchema = z.object({ label: z.string(), value: z.string(), note: z.string().optional() });
export const ServicePortSchema = z.object({
  key: z.string().describe('config.ports key (nginx, postgres, redis, redfish, vbmc, thanos*)'),
  label: z.string(),
  value: z.number().int().min(1).max(65535),
  info: z.string().optional().describe('Tooltip — e.g. apply caveats for vbmc/redfish'),
  readOnly: z
    .boolean()
    .optional()
    .describe(
      'When true the port is shown for reference only and cannot be edited (loopback-only observability sink ports)',
    ),
});
export const IdentityConfigSchema = z.object({
  pg: z.object({ user: z.string(), password: z.string(), db: z.string() }),
  orgId: z.string(),
});
export const OsLayerCacheSchema = z.object({ originHost: z.string(), resolvers: z.string() });
export const LanConfigSchema = z.object({
  expose: z
    .boolean()
    .describe('Bind sim services to 0.0.0.0 (+ relax Vite allowedHosts) for LAN reach; default false (loopback)'),
});
export const TelemetryConfigSchema = z.object({
  enable: z
    .boolean()
    .describe(
      'Bring up the local OTEL sink (OTel collector → Tempo, span-metrics to the existing Thanos, Grafana UI) and point hub/spoke tracing at it; default false',
    ),
});
export const StackConfigSchema = z.object({
  seeded: z
    .boolean()
    .describe(
      'False when the devenv eval seed failed: every value below is a bare default rather than the live stack.local.nix, so a save built from them would erase the real overlay. The server refuses such a write with 503; the editor must not submit one.',
    ),
  knobs: z.object({ hub: z.array(StackKnobSchema), spoke: z.array(StackKnobSchema) }),
  ports: z.object({ hub: z.array(StackPortSchema), spoke: z.array(StackPortSchema) }),
  servicePorts: z.array(ServicePortSchema).describe('Editable datastore/service ports (effective values)'),
  values: z.object({ hub: z.record(z.string(), z.string()), spoke: z.record(z.string(), z.string()) }),
  counts: StackCountsSchema,
  slot: StackSlotSchema,
  identity: IdentityConfigSchema,
  osLayerCache: OsLayerCacheSchema,
  lan: LanConfigSchema.describe('LAN exposure toggle — bind sim services to 0.0.0.0 for LAN reach (default off)'),
  telemetry: TelemetryConfigSchema.describe('Local OTEL sink toggle + Grafana quick-link (config.telemetry.enable)'),
});
export type StackConfig = z.infer<typeof StackConfigSchema>;
export type StackKnob = z.infer<typeof StackKnobSchema>;

export const RepoBranchSchema = z.object({
  branch: z
    .string()
    .nullable()
    .describe('Current branch name from `git rev-parse --abbrev-ref HEAD`; null when detached or unreadable'),
  error: z
    .string()
    .nullable()
    .describe(
      'Reason the branch could not be read or applied (missing path, not a git repo, detached HEAD, dirty tree, …)',
    ),
});
export type RepoBranch = z.infer<typeof RepoBranchSchema>;

export const BranchCheckoutResultSchema = RepoBranchSchema.extend({
  ccRebuildRequired: z
    .boolean()
    .describe(
      'True when the checkout left the control-center build stale (new HEAD ≠ running build sha) — rebuild + restart the lab API before driving destructive ops',
    ),
});
export type BranchCheckoutResult = z.infer<typeof BranchCheckoutResultSchema>;

export const BranchNameSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9_-])?$/,
    'branch must start alphanumeric and use only [A-Za-z0-9._/-] (no trailing "." or "/")',
  )
  .refine((s) => !s.includes('..'), 'branch must not contain ".."')
  .describe(
    "Conservative subset of valid git ref names — blocks option injection (no leading '-'), traversal ('..'), whitespace, and control characters; full git ref rules are enforced by git itself and surface in RepoBranch.error",
  );
