import { BringupPhaseSchema, BringupStepSchema } from '@repo/local-lab-contract';
import { z } from 'zod';

// safeParse throwing `label: path: message` — a raw ZodError.message is a multi-line JSON blob that
// wraps badly in log sinks and error bodies.
export function parseBoundary<S extends z.ZodTypeAny>(schema: S, data: unknown, label: string): z.infer<S> {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const issues = result.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
  throw new Error(`${label}: ${issues}`);
}

/** One row of process-compose's `GET /processes` response. Only the fields the control center maps
 *  are shaped; other extras process-compose emits pass through. */
export const PcProcessSchema = z
  .object({
    name: z.string(),
    // process-compose emits `null` (not just omission) for unset fields, so optional scalars are
    // `.nullish()` — a bare `.optional()` rejects null and would fail-hard the whole status poll.
    namespace: z.string().nullish(),
    status: z.string(), // "Running" | "Completed" | "Disabled" | "Pending" | "Error" | …
    is_ready: z.string().nullish(), // "Ready" | "Not Ready" | "-"
    pid: z.number().nullish(),
    restarts: z.number().nullish(),
    exit_code: z.number().nullish(),
    replica: z.number().nullish(),
    cpu: z.number().nullish(), // percent, e.g. 0.24
    mem: z.number().nullish(), // resident bytes
    system_time: z.string().nullish(), // pre-formatted age, e.g. "2d5h"
  })
  .passthrough();

/** `GET /processes` → `{ data: [...] }`. */
export const ProcessesResponseSchema = z.object({ data: z.array(PcProcessSchema).nullish() }).passthrough();

/** One process entry in the rendered process-compose config — only the fields the loadYaml sites read.
 *  All `.nullish()` (rendered YAML can emit explicit null, as PcProcessSchema above); extras pass through. */
const RenderedProcessSchema = z
  .object({
    namespace: z.string().nullish(),
    description: z.string().nullish(),
    disabled: z.boolean().nullish(),
    readiness_probe: z
      .object({ http_get: z.object({ port: z.number().nullish() }).passthrough().nullish() })
      .passthrough()
      .nullish(),
    depends_on: z.record(z.unknown()).nullish(),
    environment: z.array(z.string()).nullish(),
  })
  .passthrough();

/** The rendered process-compose config (`devenv build … configFile`) as loadYaml parses it. */
export const RenderedConfigSchema = z.object({ processes: z.record(RenderedProcessSchema).nullish() }).passthrough();
export type RenderedConfig = z.infer<typeof RenderedConfigSchema>;

// ---- `devenv eval` seed JSON (overlay-store.ts seedMirror) ----

const FleetEvalNodeSchema = z.object({ enable: z.boolean().optional(), index: z.number().optional() }).passthrough();
const FleetEvalZoneSchema = z
  .object({
    index: z.number().optional(),
    bridges: z.number().optional(),
    nodes: z.record(FleetEvalNodeSchema).optional(),
  })
  .passthrough();
const BaremetalEvalSchema = z
  .object({
    nics: z.array(z.string()).optional(),
    iface: z.string().optional(),
    arch: z.string().optional(),
    nodes: z.record(FleetEvalNodeSchema).optional(),
  })
  .passthrough();
const FleetEvalSchema = z
  .object({
    network: z.record(z.unknown()).optional(),
    defaults: z.record(z.unknown()).optional(),
    nodes: z.record(FleetEvalNodeSchema).optional(),
    zones: z.record(FleetEvalZoneSchema).optional(),
    mode: z.string().optional(),
    baremetal: BaremetalEvalSchema.optional(),
  })
  .passthrough();

const PortGroupsEvalSchema = z
  .object({ editable: z.array(z.string()).optional(), readOnly: z.array(z.string()).optional() })
  .passthrough();

const StackDefaultsEvalSchema = z
  .object({
    hub: z.record(z.string()).optional(),
    spoke: z.record(z.string()).optional(),
    hubKnobEnv: z.record(z.array(z.string())).optional(),
  })
  .passthrough();

const LabBridgeEvalSchema = z
  .object({
    proc: z.string().optional(),
    zone: z.string().optional(),
    replica: z.unknown().optional(),
    port: z.unknown().optional(),
    grpc: z.unknown().optional(),
  })
  .passthrough();

/** `devenv eval …` seed output, shaped only as far as seedMirror reads it (counts/ports stay `unknown`,
 *  re-coerced via Number()). Fail-soft: a parse failure falls back to defaults in seedMirror. */
export const DevenvSeedEvalSchema = z
  .object({
    'stack.slot': z.number().optional(),
    stackOverrides: z
      .object({ hub: z.record(z.string()).optional(), spoke: z.record(z.string()).optional() })
      .passthrough()
      .optional(),
    stackDefaults: StackDefaultsEvalSchema.optional(),
    portGroups: PortGroupsEvalSchema.optional(),
    labBridges: z.array(LabBridgeEvalSchema).optional(),
    stackCounts: z.object({ hub: z.unknown().optional(), spoke: z.unknown().optional() }).passthrough().optional(),
    identity: z
      .object({
        pg: z
          .object({ user: z.string().optional(), password: z.string().optional(), db: z.string().optional() })
          .passthrough()
          .optional(),
        orgId: z.string().optional(),
      })
      .passthrough()
      .optional(),
    osLayerCache: z
      .object({ originHost: z.string().optional(), resolvers: z.string().optional() })
      .passthrough()
      .optional(),
    lan: z.object({ expose: z.boolean().optional() }).passthrough().optional(),
    telemetry: z.object({ enable: z.boolean().optional() }).passthrough().optional(),
    ports: z.record(z.unknown()).optional(),
    portDefaults: z.record(z.unknown()).optional(),
    fleet: FleetEvalSchema.optional(),
  })
  .passthrough();

/** The engine's fleet-progress.json (apps/local-sim/scripts/local/progress.py) — phase/step reuse the
 *  contract's Python-parity enums; the rest is shaped as progress.py writes it. */
export const FleetProgressSchema = z
  .object({
    phase: BringupPhaseSchema,
    step: BringupStepSchema,
    label: z.string(),
    node: z.string().nullable(),
    index: z.number(),
    total: z.number(),
    stepOrdinal: z.number(), // position in BRINGUP_SEQUENCE, -1 if off-sequence
    stepCount: z.number(),
    startedAt: z.number(), // epoch SECONDS
    updatedAt: z.number(),
    error: z.string().nullable(),
  })
  .passthrough();
export type FleetProgress = z.infer<typeof FleetProgressSchema>;
