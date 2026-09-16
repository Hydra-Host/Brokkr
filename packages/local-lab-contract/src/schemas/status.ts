import { z } from 'zod';
import { CcBuildSchema, ServiceSchema, StackCountsSchema } from './common';
import { RunSchema } from './runs';
import { FleetStatusSchema } from './stack';

export const StatusRepoSchema = z.object({
  path: z.string().nullable().describe('Checkout path, or null if not configured'),
  branch: z.string().nullable().describe('Current branch (null = detached/unreadable)'),
  commit: z.string().nullable().describe('Short HEAD sha'),
  dirty: z.boolean().describe('Working tree has uncommitted changes'),
});
export const StatusFleetNodeSchema = z.object({
  name: z.string(),
  power: z.enum(['on', 'off', 'unknown']),
  lifecycleStatus: z.string().nullable().describe('Server.lifecycleStatus from the hub DB'),
  deviceId: z.string().nullable().describe('Index-derived hub Device.id'),
  gpuModel: z.string().nullable().describe('Model of the lowest-indexed Gpu row for this device in the hub DB'),
});
export const HttpProbeResultSchema = z.discriminatedUnion('ok', [
  z.object({
    target: z.string().describe('URL probed'),
    ok: z.literal(true).describe('A 2xx response arrived within the probe timeout'),
    statusCode: z.number().describe('HTTP status of the 2xx response'),
    latencyMs: z.number().describe('Round-trip time in ms'),
    detail: z.null().describe('Always null on a successful probe'),
  }),
  z.object({
    target: z.string().describe('URL probed'),
    ok: z.literal(false).describe('No 2xx response within the probe timeout (non-2xx, connection error, timeout)'),
    statusCode: z
      .number()
      .nullable()
      .describe('HTTP status of the response; null when no response arrived (refused, timeout)'),
    latencyMs: z.number().nullable().describe('Round-trip time in ms; null when no response arrived'),
    detail: z.string().describe('Why the probe failed (non-2xx, connection error, timeout)'),
  }),
]);
export type HttpProbeResult = z.infer<typeof HttpProbeResultSchema>;

export const FleetSummarySchema = z.object({
  total: z.number().describe('Fleet nodes in the snapshot'),
  on: z.number().describe('Nodes powered on'),
  off: z.number().describe('Nodes powered off'),
  unknown: z.number().describe('Nodes whose power state could not be probed'),
  byLifecycle: z
    .record(z.string(), z.number())
    .describe('Node count per non-null hub lifecycleStatus (e.g. { provisioning: 2 })'),
});
export type FleetSummary = z.infer<typeof FleetSummarySchema>;

export const InitStatusSchema = z.object({
  state: z
    .enum(['pending', 'running', 'completed', 'failed'])
    .describe('Aggregate of the init-DAG roster: a failed task outranks a task still running'),
  total: z.number().describe('Init tasks discovered from the log artifacts; pending ones may predate this bring-up'),
  completed: z
    .number()
    .describe(
      'Tasks satisfied this bring-up: exited 0 now, or cached from an earlier exit 0 by their status predicate',
    ),
  failed: z.number().describe('Tasks exited non-zero, or with an unreadable exit-status sidecar'),
  current: z
    .string()
    .nullable()
    .describe('Label of the focus task (first failed, else first running); null when nothing needs attention'),
});
export type InitStatus = z.infer<typeof InitStatusSchema>;

export const HostAccessFindingSchema = z.object({
  probe: z.enum(['groups', 'libvirt', 'docker', 'kvm']).describe('Which readiness probe produced this finding'),
  severity: z.enum(['block', 'warn', 'skip']).describe('block = the host cannot run the stack as configured'),
  title: z.string().describe('One-line statement of the problem'),
  fix: z.string().describe('The exact command or action that repairs it'),
});
export type HostAccessFinding = z.infer<typeof HostAccessFindingSchema>;

export const HostAccessSchema = z.object({
  checkedAt: z.number().describe('When host-access-check.sh last ran, unix ms'),
  hadTty: z.boolean().describe('False means blockers were downgraded and the bring-up proceeded anyway'),
  blocked: z.number().describe('Count of block-severity findings'),
  warned: z.number().describe('Count of warn-severity findings'),
  findings: z.array(HostAccessFindingSchema).describe('Every finding, in probe order'),
});
export type HostAccess = z.infer<typeof HostAccessSchema>;

export const StatusSchema = z.object({
  app: z.object({
    pid: z.number(),
    startedAt: z.number().describe('Process start, unix ms'),
    uptimeSec: z.number(),
    memlockLimit: z.string().describe('"unlimited" or bytes — /proc/self/limits "Max locked memory" soft'),
    distBuiltAt: z.number().nullable().describe('mtime of apps/local-lab/dist/main.js, unix ms'),
    stale: z.boolean().describe('Any apps/local-lab/src file is newer than dist/main.js'),
    ccBuild: CcBuildSchema.describe('Build stamp + checkout-skew state of the running control-center API'),
  }),
  repos: z.object({ lab: StatusRepoSchema, hub: StatusRepoSchema, spoke: StatusRepoSchema }),
  services: z.array(ServiceSchema),
  datastores: z.object({ postgres: z.boolean(), redis: z.boolean() }),
  stack: z.object({
    counts: StackCountsSchema,
    lifecycleWorkerConcurrency: z.number().describe('Spoke LIFECYCLE_WORKER_CONCURRENCY (override or default)'),
  }),
  hostAccess: HostAccessSchema.optional().describe(
    'Host readiness as of the last stack-up, from devenv/scripts/host-access-check.sh; absent when the marker is missing or unreadable. A blocked count above zero with hadTty false means the bring-up proceeded over a host that cannot work.',
  ),
  fleet: z.array(StatusFleetNodeSchema),
  fleetDbReadFailed: z
    .boolean()
    .optional()
    .describe(
      'The hub Device/Server read behind the fleet array failed, so lifecycleStatus, deviceId and gpuModel are blank on every node rather than measured',
    ),
  fleetSummary: FleetSummarySchema.optional().describe(
    'Rollup of the fleet array above, for the dashboard landing view',
  ),
  fleetHealth: FleetStatusSchema.optional().describe(
    'Composed fleet bring-up state (health, current step, progress ordinals, machine counts) — the same object GET /api/stack/state returns under `fleet`; absent when the fleet status could not be composed',
  ),
  hubHealth: HttpProbeResultSchema.optional().describe(
    'Live HTTP probe of the hub /healthcheck — catches a booted-but-broken hub that the process roster reads as healthy; absent when the probe batch is unavailable',
  ),
  spokeHealth: z
    .array(HttpProbeResultSchema)
    .optional()
    .describe(
      'Live HTTP probe of every overlay-roster bridge /api/health, in roster order; absent when the probe batch is unavailable',
    ),
  lastTestRun: RunSchema.optional().describe(
    "Newest ledger run with section 'test'; absent when the ledger is unreadable or no test run exists",
  ),
  recentRuns: z
    .array(RunSchema)
    .optional()
    .describe('Newest ledger runs across every section (most recent first); absent when the ledger is unreadable'),
  initStatus: InitStatusSchema.optional().describe(
    'Compact aggregate of the init-DAG roster; absent when the roster is unreadable',
  ),
});
export type Status = z.infer<typeof StatusSchema>;
