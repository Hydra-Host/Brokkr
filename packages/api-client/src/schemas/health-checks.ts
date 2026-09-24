import { z } from 'zod';
import { createPaginatedResponseSchema } from './pagination';

export const HEALTH_CHECK_RETENTION_DAYS = 7;

const triState = (what: string) =>
  z
    .boolean()
    .nullable()
    .describe(`${what}. Null means the probe was skipped or threw; false means it failed; true means it passed`);

export const DeviceReachabilitySchema = z
  .enum(['ok', 'auth-failed', 'unreachable', 'unconfigured', 'unknown'])
  .describe(
    'BMC reachability derived from the probe booleans: ok = a BMC protocol answered and the credential was accepted; auth-failed = a protocol answered and the credential was rejected; unreachable = every BMC probe failed; unconfigured = every BMC probe was skipped; unknown = a protocol answered but the credential was not tested',
  );
export type DeviceReachability = z.infer<typeof DeviceReachabilitySchema>;

export const HealthChecksSchema = z.object({
  primaryReachable: triState('Primary IP answered ICMP'),
  bmcIcmpReachable: triState('BMC IP answered ICMP'),
  bmcIpmiReachable: triState('BMC answered IPMI'),
  bmcRedfishReachable: triState('BMC answered Redfish'),
  bmcCredsValid: triState('The stored BMC credential was accepted'),
  poweredOn: triState('BMC reported power on'),
  brokkrLiveRunning: triState('The discovery OS agent answered'),
});
export type HealthChecks = z.infer<typeof HealthChecksSchema>;

/** The probes a customer may see; the hub nulls every other key and the ui hides its column. */
export const CUSTOMER_HEALTH_KEYS: ReadonlySet<keyof HealthChecks> = new Set(['primaryReachable', 'poweredOn']);

export const DeviceHealthCheckSchema = HealthChecksSchema.extend({
  id: z.string().describe('Health check row id'),
  testedAt: z
    .string()
    .describe(
      'ISO 8601 time the change was recorded. Not the time of the last check: the bridge sends a row only when a result changed',
    ),
  reachability: DeviceReachabilitySchema,
});
export type DeviceHealthCheck = z.infer<typeof DeviceHealthCheckSchema>;

export const DeviceHealthChecksListResponseSchema = createPaginatedResponseSchema(DeviceHealthCheckSchema).extend({
  retentionDays: z.literal(HEALTH_CHECK_RETENTION_DAYS).describe('Rows older than this are deleted daily'),
  edgeTriggered: z
    .literal(true)
    .describe('A row is written only when a check result changed; no rows means no change, not no checks'),
});
export type DeviceHealthChecksListResponse = z.infer<typeof DeviceHealthChecksListResponseSchema>;

export const DeviceHealthSummarySchema = z.object({
  view: z
    .enum(['owner', 'customer'])
    .describe(
      "'owner' for the supplier organization, every field populated; 'customer' for the renting organization, only source, checkedAt, poweredOn and primaryReachable populated",
    ),
  source: z
    .enum(['snapshot', 'history', 'none'])
    .describe(
      "'snapshot' = the bridge live snapshot (at most 10 minutes old); 'history' = the newest recorded change; 'none' = nothing known",
    ),
  checkedAt: z
    .string()
    .nullable()
    .describe('Time of the last check from the snapshot, or the last recorded change from history; null when none'),
  checks: HealthChecksSchema.extend({ reachability: DeviceReachabilitySchema.nullable() })
    .nullable()
    .describe('Latest values; null when none. In the customer view every BMC protocol field and reachability is null'),
  isHealthy: z.boolean().nullable().describe('Null when nothing is known; never true by default'),
  reason: z.string().nullable().describe('First failing probe in the ladder the hub applies, or null'),
  icmpFiltered: z
    .boolean()
    .describe('True when the BMC did not answer ICMP but IPMI or Redfish proved it reachable; ICMP is advisory then'),
});
export type DeviceHealthSummary = z.infer<typeof DeviceHealthSummarySchema>;

export const RequestDeviceHealthCheckResponseSchema = z.object({
  jobId: z.string().describe('Saga job id; coalesces with a pending scheduled check'),
});
export type RequestDeviceHealthCheckResponse = z.infer<typeof RequestDeviceHealthCheckResponseSchema>;

/** The plain JSON the bridge SETs at `{zone}:device-health:{deviceId}` with a 600 s TTL. */
export const DeviceHealthSnapshotSchema = z.object({
  device_id: z.string().describe('Device the probes ran against'),
  primary_reachable: z.boolean().nullable().describe('Primary IP answered ICMP; null when skipped'),
  bmc_icmp_reachable: z.boolean().nullable().describe('BMC IP answered ICMP; null when skipped'),
  bmc_ipmi_reachable: z.boolean().nullable().describe('BMC answered IPMI; null when skipped'),
  bmc_redfish_reachable: z.boolean().nullable().describe('BMC answered Redfish; null when skipped'),
  bmc_creds_valid: z.boolean().nullable().describe('Stored BMC credential accepted; null when not tested'),
  powered_on: z.boolean().nullable().describe('BMC reported power on; null when unknown'),
  brokkr_live_running: z.boolean().nullable().describe('Discovery OS agent answered; null when skipped'),
  checked_at: z
    .number()
    .nonnegative()
    .describe(
      'Bridge clock when the probes ran, Unix epoch seconds with a fractional part, as the bridge writes Date.now() / 1000',
    ),
});
export type DeviceHealthSnapshot = z.infer<typeof DeviceHealthSnapshotSchema>;
