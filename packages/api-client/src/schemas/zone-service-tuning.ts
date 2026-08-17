import { z } from 'zod';

export const ZoneServiceTuningSchema = z.object({
  dhcpLeaderPollMs: z
    .number()
    .int()
    .min(1)
    .max(300_000)
    .describe('Bridge DHCP leader-status/atom poll interval in milliseconds (max 5 minutes)'),
  dhcpPruneIntervalMs: z
    .number()
    .int()
    .min(1)
    .max(3_600_000)
    .describe('Bridge DHCP expired-lease prune interval in milliseconds (max 1 hour)'),
  dhcpDeclineBackoffSeconds: z
    .number()
    .int()
    .min(0)
    .max(86_400)
    .describe('Quarantine window in seconds for an address after a client DHCPDECLINE (max 1 day)'),
  vrrpGarpCount: z
    .number()
    .int()
    .min(1)
    .max(50)
    .describe('Gratuitous ARPs the leader bridge sends when it binds a VRRP virtual IP (max 50)'),
});

export type ZoneServiceTuning = z.infer<typeof ZoneServiceTuningSchema>;
