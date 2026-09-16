import { z } from 'zod';

export const ErrorBodySchema = z.object({
  error: z.string().describe('Human-readable error message explaining why the request failed'),
});

export const RequestOriginSchema = z.object({
  ip: z.string().nullable().describe('Effective client address; X-Forwarded-For honoured only when LAB_TRUST_PROXY=1'),
  loopback: z
    .boolean()
    .describe(
      'Effective client address was loopback, X-Forwarded-For honoured only when LAB_TRUST_PROXY=1 — recorded on denied rows too',
    ),
  tokenAuth: z.boolean().describe('A valid LAB_API_TOKEN was presented, evaluated independently of the loopback grant'),
});
export type RequestOrigin = z.infer<typeof RequestOriginSchema>;

export const ProcHealthSchema = z
  .enum(['up', 'unhealthy', 'crashlooping', 'failed', 'blocked', 'down', 'disabled', 'missing'])
  .describe('up | unhealthy | crashlooping | failed | blocked | down | disabled | missing');

export const ServiceSchema = z.object({
  id: z.string().describe('Stable service id (hub-api | hub-web | spoke | lab | lab-web)'),
  label: z.string().describe('Human label'),
  group: z
    .string()
    .describe(
      'The process-compose namespace this surface belongs to (hub | spoke | control | …) — the UI groups services into a section per namespace, so a new namespace appears as its own section with no code change',
    ),
  zone: z
    .string()
    .nullable()
    .describe('Spoke bridge zone name (null for hub services, control services, and single-zone/legacy spokes)'),
  port: z.number().describe('Port probed for readiness'),
  running: z.boolean().describe('Tracked process group is alive'),
  ready: z.boolean().describe('Running AND its readiness port accepts connections'),
  pid: z.number().nullable().describe('Process-group leader pid, or null if stopped'),
  health: ProcHealthSchema.describe(
    'Reconcile-aware health (richer than running/ready) — drives the status dot + the "why" detail',
  ),
  canStop: z
    .boolean()
    .describe(
      'Whether the UI exposes Stop — false for control-plane services (lab/lab-web) that would kill the control center if stopped',
    ),
  restarts: z.number().optional().describe('process-compose restart count (climbing ⇒ crash-looping)'),
  exitCode: z.number().optional().describe('last exit code when stopped/failed'),
  detail: z.string().optional().describe('human one-liner: blocked-on reason, or the last error line from the log'),
  cpuPct: z
    .number()
    .optional()
    .describe('process cpu percent from process-compose (absent when stopped or unreported)'),
  memBytes: z
    .number()
    .optional()
    .describe('resident memory in bytes from process-compose (absent when stopped or unreported)'),
  age: z
    .string()
    .optional()
    .describe('human-readable process age from process-compose (e.g. 2d5h; absent when stopped)'),
  features: z
    .array(z.string())
    .optional()
    .describe(
      'Feature flags the rendered environment turns on in this process (TFTP, iPXE strict) — bare-metal mode is delivered as these flags on the spoke, not as extra processes',
    ),
});
export type Service = z.infer<typeof ServiceSchema>;

export const StackCountsSchema = z.object({
  hub: z
    .number()
    .int()
    .min(1)
    .max(1)
    .describe(
      'Hub replica count, pinned to 1 — the devenv hub processes pin every replica readiness probe to the base port, so a second hub would report the primary health and is unobservable',
    ),
  spoke: z
    .number()
    .int()
    .min(1)
    .max(8)
    .describe('Spoke replica count — HA bridges sharing the zone Redis prefix and queues, one process per replica'),
});

export const StackSlotSchema = z
  .number()
  .int()
  .min(0)
  .max(46)
  .describe(
    'Multi-stack instance slot (0–46) this stack owns — every host-colliding resource (ports, subnets, MACs, node names, state paths) derives from it; 0 is the legacy single-stack layout',
  );

export const AppLinkSchema = z.object({
  id: z.string().describe('process-compose process id backing this UI (e.g. hub-web, grafana, mailpit)'),
  label: z.string().describe('Human label from the process\'s LAB_WEB_UI marker (e.g. "Hub", "Hub Swagger")'),
  port: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .describe('Port the UI listens on — the LAB_WEB_PORT marker override, else the readiness-probe port'),
  path: z
    .string()
    .regex(/^\//, 'path must start with /')
    .describe('URL path to open — the LAB_WEB_PATH marker, default "/"'),
  ready: z.boolean().describe('Whether the backing process is running and passing its readiness probe'),
  loopback: z
    .boolean()
    .describe(
      'True when the UI binds loopback-only (never the LAN, whatever lan.mode is) — the client must target localhost, not the LAN host',
    ),
});
export type AppLink = z.infer<typeof AppLinkSchema>;

export const CcBuildSchema = z.object({
  sha: z
    .string()
    .nullable()
    .describe(
      'Full HEAD sha the running control-center dist was built from, captured by the build-written dist/build-info.json stamp; null when the stamp is absent/unreadable (dev watch builds)',
    ),
  builtAt: z
    .number()
    .nullable()
    .describe('When the running dist was produced, unix ms (stamp; falls back to the dist/main.js mtime)'),
  headSha: z
    .string()
    .nullable()
    .describe('Live HEAD sha of the control-center checkout at request time; null when the checkout is unreadable'),
  stale: z
    .boolean()
    .describe(
      'sha and headSha are both known and differ — the running API predates the checkout (branch-checkout skew); false when either side is unknown (fail-quiet, never a false alarm)',
    ),
});
export type CcBuild = z.infer<typeof CcBuildSchema>;
