import { z } from 'zod';

import { operations, type OperationName } from './operations/index.js';

// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Object.keys returns string[]; narrow to non-empty tuple required by z.enum
const OPERATION_NAMES = Object.keys(operations) as [OperationName, ...OperationName[]];
export const OperationNameSchema = z
  .enum(OPERATION_NAMES)
  .describe('Registered operation name in the agent dispatch table.');

const compositeWorkId = z.string().superRefine((s, ctx) => {
  const idx = s.indexOf(':');
  if (idx === -1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'composite work_id must contain ":"' });
    return;
  }
  const jobId = s.slice(0, idx);
  const op = s.slice(idx + 1);
  if (!/^[0-9a-zA-Z-]+$/.test(jobId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'job_id portion must be alphanumeric/hyphen (BullMQ id shape)',
    });
  }
  const opCheck = OperationNameSchema.safeParse(op);
  if (!opCheck.success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `unknown operation in composite work_id: ${op}`,
    });
  }
});

export const WorkId = z
  .union([z.string().uuid(), compositeWorkId])
  .describe(
    'Work correlation id. Either a UUIDv4 minted on dispatch, or a "{job_id}:{operation}" composite the bridge dispatcher uses for replay-safe saga retry. The composite form lets two BullMQ retries of the same saga step hit the agent\'s per-work_id cache and return STATUS_ALREADY_IN_PROGRESS rather than re-running the primitive.',
  );
export type WorkId = z.infer<typeof WorkId>;

export const OperationError = z.object({
  code: z
    .string()
    .describe(
      "Short code identifying the error class, e.g. 'INVALID_INPUT', 'OPERATION_FAILED', 'TIMEOUT', 'UNKNOWN_OPERATION'.",
    ),
  message: z.string().describe('Human-readable error message; safe to log.'),
  details: z
    .unknown()
    .optional()
    .describe('Arbitrary structured error context (stack trace, parse issues, subprocess stderr excerpt, etc.).'),
});
export type OperationError = z.infer<typeof OperationError>;

export const ZoneInfo = z.object({
  tenant_id: z.string().describe('Tenant identifier the device belongs to.'),
});
export type ZoneInfo = z.infer<typeof ZoneInfo>;

export const BridgeEndpoint = z.object({
  address: z.string().describe("Bridge host:port, e.g. 'bridge-1-76-14-956:443'."),
  bridge_id: z.string().describe('Stable per-instance bridge identifier used in topology updates.'),
});
export type BridgeEndpoint = z.infer<typeof BridgeEndpoint>;

export const Readiness = z
  .enum(['ready', 'busy', 'degraded'])
  .describe("Agent readiness for new dispatches: 'ready' | 'busy' | 'degraded'.");
export type Readiness = z.infer<typeof Readiness>;

// Bump on breaking envelope changes; .default() lets older bundles register during rollout.
export const PROTOCOL_VERSION = 1 as const;

export const AgentRegister = z.object({
  type: z.literal('agent.register').describe('Envelope discriminator for the initial registration message.'),
  protocol_version: z
    .literal(PROTOCOL_VERSION)
    .default(PROTOCOL_VERSION)
    .describe(
      'Wire-protocol version. Older bundles that predate the field default in; a future bump will tighten this to require the new literal explicitly.',
    ),
  device_id: z
    .string()
    .describe('Device identifier the agent claims to be; the bridge maps the WS connection to this ID.'),
  zone: ZoneInfo.describe('Zone identity (tenant) identifying which zone this agent belongs to.'),
  agent_version: z
    .string()
    .describe('Agent build version; compared against the bridge expected version for drift detection.'),
  mac: z.string().optional().describe('Primary NIC MAC address, when known — informational.'),
  ip: z.string().ip().optional().describe('Agent IP address, when known — informational.'),
  arch: z.enum(['amd64', 'arm64']).optional().describe('CPU architecture the agent was built for.'),
  readiness: Readiness.default('ready').describe(
    'Self-reported readiness at registration time. Bridge surfaces this for operators and uses it to decide whether to dispatch heavy jobs.',
  ),
});
export type AgentRegister = z.infer<typeof AgentRegister>;

export const RejectionCode = z.enum([
  'invalid_registration',
  'unknown_device',
  'auth_failed',
  'version_unsupported',
  'bridge_overloaded',
  'registration_race',
  'internal_error',
]);
export type RejectionCode = z.infer<typeof RejectionCode>;

export const Rejection = z.object({
  code: RejectionCode.describe('Rejection code the agent uses to decide whether to retry.'),
  message: z.string().describe('Human-readable explanation suitable for logging on the agent side.'),
});
export type Rejection = z.infer<typeof Rejection>;

export const PERMANENT_REJECTION_CODES: ReadonlySet<RejectionCode> = new Set([
  'invalid_registration',
  'unknown_device',
  'auth_failed',
  'version_unsupported',
]);

export function isPermanentRejection(code: RejectionCode): boolean {
  return PERMANENT_REJECTION_CODES.has(code);
}

export const AgentRegistered = z.object({
  type: z.literal('agent.registered').describe("Envelope discriminator for the bridge's reply to agent.register."),
  accepted: z.boolean().describe('Whether the registration was accepted. When false, `rejection` is populated.'),
  bridge_id: z.string().describe('The bridge instance identifier the agent just connected to.'),
  topology: z
    .array(BridgeEndpoint)
    .describe('Full current bridge topology for the zone; agent reconciles its connection set against this list.'),
  rejection: Rejection.optional().describe('Populated iff `accepted === false`; classifies why and whether to retry.'),
});
export type AgentRegistered = z.infer<typeof AgentRegistered>;

export const WorkRequest = z.object({
  type: z.literal('work.request').describe('Envelope discriminator for a bridge->agent dispatch.'),
  work_id: WorkId,
  operation: z
    .string()
    .describe(
      "Fully-qualified operation name, e.g. 'collection.collectAll'. Validated against the registered handler set at dispatch time, not at envelope parse.",
    ),
  input: z
    .unknown()
    .describe(
      'Operation-specific input payload; validated by the agent against the per-operation schema at dispatch time, not at envelope parse.',
    ),
  job_id: z.string().optional().describe('Saga/BullMQ correlation id; propagated into agent logs for tracing.'),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Per-operation timeout in milliseconds; the agent aborts the handler if exceeded.'),
  traceparent: z
    .string()
    .optional()
    .describe(
      "W3C traceparent captured from the dispatching bridge's active span; parents the agent execution span. Absent when bridge telemetry is disabled.",
    ),
  tracestate: z
    .string()
    .optional()
    .describe('W3C tracestate accompanying traceparent; forwarded verbatim, best-effort.'),
});
export type WorkRequest = z.infer<typeof WorkRequest>;

export const WorkResponse = z.object({
  type: z.literal('work.response').describe('Envelope discriminator for the terminal agent->bridge reply.'),
  work_id: WorkId,
  status: z
    .enum(['success', 'failure'])
    .describe('Terminal outcome; exactly one of `output` or `error` is populated accordingly.'),
  output: z
    .unknown()
    .optional()
    .describe(
      'Operation-specific output payload when status === `success`; validated against the per-operation output schema.',
    ),
  error: OperationError.optional().describe('Structured error details when status === `failure`.'),
});
export type WorkResponse = z.infer<typeof WorkResponse>;

export const WorkProgress = z.object({
  type: z.literal('work.progress').describe('Envelope discriminator for a mid-operation progress update.'),
  work_id: WorkId,
  progress: z
    .number()
    .min(0)
    .max(1)
    .describe('Fractional progress in [0.0, 1.0]; monotonically non-decreasing per work_id.'),
  message: z.string().optional().describe('Optional human-readable status for log output.'),
});
export type WorkProgress = z.infer<typeof WorkProgress>;

export const CollectionResult = z.object({
  type: z
    .literal('collection.result')
    .describe('Envelope discriminator for a per-collector streaming result inside collection.collectAll.'),
  work_id: WorkId,
  collector: z
    .string()
    .describe(
      "Collector name, e.g. 'architecture', 'lsblk', 'nvidia_detailed'. Matches the operation suffix under 'collection.*'.",
    ),
  status: z
    .enum(['success', 'failure'])
    .describe('Outcome for this collector only; sibling collectors may have different status.'),
  data: z.unknown().optional().describe("Collector's top-level output dict on success; shape is collector-specific."),
  error: OperationError.optional().describe('Populated when status === `failure`.'),
  duration_ms: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Wall-clock time spent running this collector, in milliseconds.'),
});
export type CollectionResult = z.infer<typeof CollectionResult>;

const MS_SINCE_2020 = 1_577_836_800_000;

export const Heartbeat = z.object({
  type: z.literal('heartbeat').describe('Envelope discriminator for the periodic liveness ping.'),
  ts: z
    .number()
    .int()
    .min(MS_SINCE_2020)
    .describe(
      'Unix **milliseconds** at the sender (e.g. `Date.now()` in Node, `int(time.time()*1000)` in Python). Used only for staleness detection, never for wall-clock sync. Bounded at 2020-01-01 to catch accidental seconds-since-epoch values.',
    ),
});
export type Heartbeat = z.infer<typeof Heartbeat>;

export const TopologyUpdate = z.object({
  type: z.literal('topology.update').describe('Envelope discriminator for a bridge->agent topology refresh.'),
  bridges: z
    .array(BridgeEndpoint)
    .describe('Full current bridge set for the zone; agent reconciles its connection set against this list.'),
});
export type TopologyUpdate = z.infer<typeof TopologyUpdate>;

export const Envelope = z.discriminatedUnion('type', [
  AgentRegister,
  AgentRegistered,
  WorkRequest,
  WorkResponse,
  WorkProgress,
  CollectionResult,
  Heartbeat,
  TopologyUpdate,
]);
export type Envelope = z.infer<typeof Envelope>;

export function parseEnvelope(raw: string | Buffer): Envelope {
  return Envelope.parse(JSON.parse(raw.toString()));
}

export type SafeParseEnvelopeResult =
  | { success: true; data: Envelope }
  | { success: false; kind: 'invalid_json'; error: SyntaxError }
  | { success: false; kind: 'schema_violation'; error: z.ZodError };

export function safeParseEnvelope(raw: string | Buffer): SafeParseEnvelopeResult {
  let json: unknown;
  try {
    json = JSON.parse(raw.toString());
  } catch (e) {
    return {
      success: false,
      kind: 'invalid_json',
      error: e instanceof SyntaxError ? e : new SyntaxError(String(e)),
    };
  }
  const parsed = Envelope.safeParse(json);
  if (parsed.success) {
    return { success: true, data: parsed.data };
  }
  return { success: false, kind: 'schema_violation', error: parsed.error };
}
