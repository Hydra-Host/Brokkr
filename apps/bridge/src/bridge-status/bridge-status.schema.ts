import { z } from 'zod';

export const dhcpStandbyHealthSchema = z.object({
  is_leader: z.boolean().describe('Whether this bridge currently holds DHCP leadership.'),
  hydrated: z.boolean().describe('Whether the in-RAM lease state has been hydrated from the lease store.'),
  answering: z
    .boolean()
    .describe('Whether this bridge is actively answering DHCP (leader AND hydrated); false on any standby.'),
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

export const bridgeStatusResponseSchema = z.object({
  bridge_pubkeys: z.array(z.string()).default([]),
  bridge_url: z.string(),
  version: z.string(),
  leader_election: z.record(z.unknown()).nullable().default(null),
  dhcp_standby_health: dhcpStandbyHealthSchema
    .nullable()
    .optional()
    .describe('DHCP hot-standby health snapshot for this bridge; absent/null when DHCP is disabled.'),
});

export type BridgeStatusResponse = z.infer<typeof bridgeStatusResponseSchema>;

export const healthCheckResponseSchema = z.object({
  status: z.string(),
  bridge_version: z.string(),
});

export type HealthCheckResponse = z.infer<typeof healthCheckResponseSchema>;
