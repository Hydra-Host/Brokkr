import { z } from 'zod';

export const dhcpStandbyHealthSchema = z.object({
  is_leader: z.boolean().describe('Whether this bridge currently holds DHCP leadership.'),
  hydrated: z.boolean().describe('Whether the in-RAM lease state has been hydrated from the lease store.'),
  answering: z
    .boolean()
    .describe('Whether this bridge is actively answering DHCP (leader AND hydrated); false on any standby.'),
  pxe_port_bound: z
    .boolean()
    .describe('Whether this bridge holds the udp/4011 proxy boot-service socket; PROXY replies need it.'),
  claim_failure_count: z
    .number()
    .int()
    .describe('Cumulative count of opportunistic leadership-claim attempts that errored since startup.'),
  last_claim_error: z
    .string()
    .nullable()
    .describe('Sanitized, length-capped message from the most recent claim failure; null while healthy or leading.'),
  hydrate_stalled_since: z
    .number()
    .nullable()
    .describe('Epoch-ms when the leader-holds-lock-but-cannot-hydrate stall began, or null when not stalled.'),
});

export const dhcpPrimaryInterfaceSchema = z.object({
  name: z.string().describe('Host NIC the DHCP server-id fallback was derived from.'),
  ip: z.string().describe('IPv4 address of that NIC; equals the fallback DHCP server-id.'),
});

export const discoverySyncStatusSchema = z.object({
  at: z.number().int().describe('Epoch-ms when the last discovery image sync pass finished.'),
  outcome: z
    .enum(['ok', 'skipped', 'failed'])
    .describe('ok: every flavor that ran synced files; skipped: every flavor was already synced; failed: see error.'),
  error: z
    .string()
    .nullable()
    .describe(
      'Whitespace-collapsed and length-capped reason for a failed pass, not redacted — it may name the ' +
        'asset host and path; null when the pass was ok or skipped.',
    ),
  base_url: z.string().describe('Flavor-less discovery root the pass synced from (DISCOVERY_BASE_URL).'),
  version: z.string().describe('Configured BROKKR_LIVE_VERSION for the pass; may be a latest-* alias.'),
  flavors: z.array(z.string()).describe('Discovery flavors the pass covered, in sync order.'),
});

export const bridgeStatusResponseSchema = z.object({
  bridge_pubkeys: z.array(z.string()).default([]),
  bridge_url: z.string(),
  version: z.string(),
  leader_election: z.record(z.unknown()).nullable().default(null),
  dhcp_standby_health: dhcpStandbyHealthSchema
    .nullable()
    .optional()
    .describe('DHCP hot-standby health snapshot for this bridge; absent/null when DHCP is disabled.'),
  readiness_error_count: z
    .number()
    .int()
    .nonnegative()
    .describe(
      'Error-severity boot-readiness findings recorded at startup; GET /api/boot-readiness re-evaluates against live state.',
    ),
  discovery_sync: discoverySyncStatusSchema
    .nullable()
    .optional()
    .describe('Outcome of the last discovery image sync pass on this bridge; absent until the first pass finishes.'),
  primary_interface: dhcpPrimaryInterfaceSchema
    .nullable()
    .optional()
    .describe('NIC the DHCP engine picked as its primary; null when DHCP is off or no interface qualified.'),
});

export type BridgeStatusResponse = z.infer<typeof bridgeStatusResponseSchema>;

export const healthCheckResponseSchema = z.object({
  status: z.string(),
  bridge_version: z.string(),
});

export type HealthCheckResponse = z.infer<typeof healthCheckResponseSchema>;
