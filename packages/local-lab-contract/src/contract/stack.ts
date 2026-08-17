import { z } from 'zod';
import { ErrorBodySchema } from '../schemas/common';
import {
  BranchCheckoutResultSchema,
  BranchNameSchema,
  InitTaskSchema,
  ProcessEnvSchema,
  RepoBranchSchema,
  RESTART_STALE_AFTER_LABEL,
  RestartStateSchema,
  StackConfigSchema,
  StackOpSchema,
  StackSlotSchema,
  StackStateSchema,
} from '../schemas/stack';

export const stackRoutes = {
  listStackOps: {
    method: 'GET',
    path: '/api/stack/ops',
    responses: { 200: z.array(StackOpSchema) },
    summary: 'List available stack operations',
    description:
      'Returns the catalog of named lifecycle ops (up/down/reset/etc.) the control center can launch, used to populate the stack op menu.',
  },
  startStackRun: {
    method: 'POST',
    path: '/api/stack/runs',
    body: z.object({
      opId: z.string().describe('Id of the stack/fleet op to launch (from listStackOps)'),
      allowDataLoss: z
        .boolean()
        .optional()
        .describe(
          'Authorize a destructive (disk-recreate) fleet apply — set only after the user confirmed the data-loss prompt; the apply aborts if the recomputed plan needs data loss without it',
        ),
      force: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Override the active-saga guard on a fleet-mode-apply — set only after the user confirmed the "force apply despite N running jobs" prompt; without it the op returns 409 when any in-flight BullMQ jobs exist across the configured zones',
        ),
    }),
    responses: {
      200: z.object({ runId: z.string() }),
      404: ErrorBodySchema,
      409: ErrorBodySchema.extend({
        activeJobs: z
          .number()
          .int()
          .optional()
          .describe(
            'For the fleet-mode-apply active-saga block: the number of in-flight BullMQ jobs across the configured zones. Drives the "force apply despite N jobs" confirm. Absent for a plain lane-contention 409.',
          ),
      }).describe('A lifecycle op is already running in this domain, or the active-saga guard blocked a mode flip'),
    },
    summary: 'Start a stack operation',
    description:
      'Kicks off the named stack op as a background child and returns its runId; progress and logs are streamed separately over SSE at /api/runs/:runId/stream. Returns 409 if a lifecycle op is already running in the domain. Loopback-only (every op spawns a host command — process-compose lifecycle, prisma, or a bash/python script): a valid LAB_API_TOKEN is not sufficient and a remote caller gets 403.',
  },
  getStackState: {
    method: 'GET',
    path: '/api/stack/state',
    responses: { 200: StackStateSchema },
    summary: 'Get current stack state',
    description:
      'Read-only per-datastore status the UI uses to gate which lifecycle ops are valid right now (e.g. block a reset while a datastore is mid-restart).',
  },
  getRestartState: {
    method: 'GET',
    path: '/api/stack/restart-state',
    responses: { 200: RestartStateSchema },
    summary: 'Get the detached stack-restart state',
    description: `Read-only: reports where a cockpit-launched stack recreation (reinit/reset/purge, or a rebind redeploy) stands, since the API itself goes down and comes back under it. A single status discriminant covers idle / pending / stale (past ${RESTART_STALE_AFTER_LABEL}) / failed, alongside the reason and the log path the child writes to.`,
  },
  getInitTasks: {
    method: 'GET',
    path: '/api/stack/init',
    responses: { 200: z.array(InitTaskSchema) },
    summary: 'List the bring-up init tasks',
    description:
      "Read-only: derives the init DAG's roster and per-task state from the log + exit-status artifacts each instrumented devenv task leaves in the process-compose log dir, in the DAG's declared order (stable across polls; an unrecognised task sorts last). Follow one task's live log over SSE at /api/stack/init/:name/log.",
  },
  controlDatastore: {
    method: 'POST',
    path: '/api/stack/datastores/control',
    body: z.object({ id: z.string(), action: z.enum(['start', 'stop', 'restart']) }),
    responses: {
      200: z.object({ ok: z.boolean(), detail: z.string().optional() }),
      404: ErrorBodySchema,
      409: ErrorBodySchema.describe('A control-plane lifecycle op is running'),
    },
    summary: 'Start/stop/restart a stack process',
    description:
      'Issues the lifecycle action to the supervised datastore or fleet-plumbing process (like virtqemud) and returns once accepted; watch the per-process SSE log at /api/stack/datastores/:id/log for progress. Returns 409 if a control-plane lifecycle op is in flight. Loopback-only (it starts and stops the host Postgres/Redis processes): a valid LAB_API_TOKEN is not sufficient and a remote caller gets 403.',
  },
  getProcessEnv: {
    method: 'GET',
    path: '/api/stack/processes/:name/env',
    query: z.object({
      reveal: z
        .enum(['true', 'false'])
        .transform((v) => v === 'true')
        .optional()
        .describe('Unmask secret-looking values. Pass the string "true" to reveal; omit to keep them masked.'),
    }),
    responses: { 200: ProcessEnvSchema, 404: ErrorBodySchema },
    summary: "Get a process's runtime environment",
    description:
      'Used to debug a process by inspecting exactly what env it sees: the configured env from the rendered process-compose config, live-augmented from /proc on Linux. Secret-looking values are redacted by default; pass reveal=true to unmask them. Returns 404 for an unknown process.',
  },
  getStackConfig: {
    method: 'GET',
    path: '/api/stack/config',
    responses: { 200: StackConfigSchema },
    summary: 'Get the stack config catalog',
    description:
      'Backs the Settings Stack editor: returns the editable hub/spoke env knobs, the read-only port map, and whatever overrides are currently applied via the stack.local.nix overlay.',
  },
  putStackConfig: {
    method: 'PUT',
    path: '/api/stack/config',
    body: z.object({
      hub: z.record(z.string(), z.string()),
      spoke: z.record(z.string(), z.string()),
      counts: z.object({ hub: z.number().int().optional(), spoke: z.number().int().optional() }).optional(),
      identity: z
        .object({
          pg: z.object({ user: z.string(), password: z.string(), db: z.string() }).partial(),
          orgId: z.string(),
        })
        .partial()
        .optional(),
      osLayerCache: z.object({ originHost: z.string(), resolvers: z.string() }).partial().optional(),
      ports: z
        .record(z.string(), z.number().int().min(1).max(65535))
        .optional()
        .describe('Editable datastore/service port overrides (config.ports key → port)'),
      lan: z
        .object({ expose: z.boolean() })
        .optional()
        .describe('LAN exposure toggle (config.lan.expose) — bind sim services to 0.0.0.0 for LAN reach'),
      telemetry: z
        .object({ enable: z.boolean() })
        .optional()
        .describe(
          'Local OTEL sink toggle (config.telemetry.enable) — auto-applies on save (starts/stops the sink + reloads the hub-api/spoke OTLP consumers)',
        ),
      slot: StackSlotSchema.optional().describe(
        'Instance slot to move this stack to (stack.slot) — drops any fleet/port overrides back to the new slot’s derived defaults and recreates the stack on Redeploy; 409 when a live sibling checkout already owns the slot',
      ),
    }),
    responses: {
      200: z.object({
        ok: z.boolean().describe('The stack.local.nix overlay was written'),
        applied: z
          .array(z.string())
          .describe(
            "Dotted keys actually written as overrides ('hub.LOG_LEVEL', 'ports.postgres'). Blank-valued known env keys and default-valued ports leave no override and appear in neither list.",
          ),
        rejected: z
          .array(z.string())
          .describe(
            "Dotted keys silently dropped from the open-keyed sections: env keys not in the knob catalog and non-editable/unknown port keys (e.g. 'ports.grafana'). Fixed-shape fields (counts/identity/lan/telemetry) are schema-validated and never listed.",
          ),
      }),
      409: ErrorBodySchema.describe(
        'The requested instance slot is already claimed by another live checkout — the body names the owning checkout; nothing was written',
      ),
    },
    summary: 'Persist stack config overrides',
    description:
      'Writes the hub/spoke env overrides plus counts, service identity, and datastore/service ports to the gitignored stack.local.nix overlay only — changes are inert until a redeploy or reload regenerates the process-compose config. Toggling telemetry additionally auto-applies (starts/stops the observability sink and reloads the hub-api + spoke bridges that consume the OTLP env) — unless a port/LAN rebind is staged, in which case the sink still stops on a disable but the reload applies with the next Redeploy. A slot change drops any fleet/port overrides (they would outrank the new slot’s derived defaults) and takes effect on the next Redeploy, which recreates the whole stack. Returns which override keys were applied vs rejected (unknown knob/port keys are dropped, not errors). Loopback-only (it writes the devenv overlay): a valid LAB_API_TOKEN is not sufficient and a remote caller gets 403.',
  },
  redeployStack: {
    method: 'POST',
    path: '/api/stack/redeploy',
    body: z.object({}),
    responses: {
      200: z.object({
        runId: z
          .string()
          .describe(
            'Run id of the redeploy run — appears in listRuns; logs stream over SSE at /api/runs/:runId/stream',
          ),
      }),
    },
    summary: 'Redeploy the whole hub/spoke roster',
    description:
      'Heavyweight: tears down and brings the full hub/spoke roster back up in dependency order so changed instance counts and overrides take effect. Prefer the per-group reload for env-only tweaks. When the save staged a datastore/LAN rebind the run finalizes at the detach point (the API itself restarts) after logging where the restart continues. Loopback-only (it tears down and restarts host processes): a valid LAB_API_TOKEN is not sufficient and a remote caller gets 403.',
  },
  getStackBranches: {
    method: 'GET',
    path: '/api/stack/branches',
    responses: { 200: RepoBranchSchema },
    summary: 'Get the stack repo branch',
    description:
      'Read-only: reports the branch the single polyrepo checkout (HUB_REPO_PATH — hub and spoke run from the same checkout) is currently on so the UI can show what code the running hub/spoke are built from.',
  },
  putStackBranches: {
    method: 'PUT',
    path: '/api/stack/branches',
    body: z.object({ branch: BranchNameSchema.describe('Target branch for the stack checkout') }),
    responses: { 200: BranchCheckoutResultSchema },
    summary: 'Switch the stack repo branch',
    description:
      'Idempotent checkout of the single hub/spoke checkout — same-as-current is a no-op; a local branch is checked out; a remote-only branch tracks origin; otherwise a new branch from HEAD. Running processes pick up the new code on the next redeploy. Loopback-only (it runs a git checkout in the host repo): a valid LAB_API_TOKEN is not sufficient and a remote caller gets 403. The response flags ccRebuildRequired when the checkout moved the repo the control center itself runs from past its running build.',
  },
} as const;
