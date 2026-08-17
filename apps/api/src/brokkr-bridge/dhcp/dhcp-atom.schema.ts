import { isIPv4 } from 'node:net';

import { DhcpRelayAgentIpSchema, IpxeBuildTargetSchema } from '@repo/api-client';
import { z } from 'zod';

import { cidrSchema } from '../shared/ip-schemas';

const ipv4 = z.string().refine(isIPv4, 'must be a valid IPv4 address');

export const BOOT_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}$/;

const cidr = cidrSchema;

const mac = z
  .string()
  .regex(/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/, 'must be a colon-separated MAC address, e.g. "aa:bb:cc:dd:ee:ff"');

// Keep in sync with apps/bridge/src/dhcp/dhcp-atom-value.schema.ts (separate app/deploy).
export const DhcpAtomSchema = z
  .object({
    mode: z
      .enum(['AUTHORITATIVE', 'PROXY', 'OFF'])
      .describe('DHCP server mode: AUTHORITATIVE serves full leases, PROXY only PXE-boots, OFF disables.'),
    subnet: cidr.describe('Subnet in CIDR notation, e.g. "10.0.1.0/24".'),
    pools: z
      .array(
        z
          .object({
            start: ipv4.describe('First usable IP in the pool range.'),
            end: ipv4.describe('Last usable IP in the pool range.'),
          })
          .strict(),
      )
      .describe('IP address pools for dynamic lease allocation.'),
    routers: z.array(ipv4).describe('Default gateway IP(s) advertised to clients.'),
    dnsServers: z
      .array(ipv4)
      .describe(
        'DNS server IP(s) advertised to clients. Empty = bridge derives from self + peers; for relayed prefixes the hub sets the bridge IPs from the associated prefix.',
      ),
    // Bridge enforces MIN_LEASE_TTL = 120s; values below that are clamped or rejected.
    leaseTtlSeconds: z.number().int().min(120).max(0x7fffffff).describe('DHCP lease duration in seconds.'),
    reservations: z
      .array(
        z
          .object({
            mac: mac.describe('Client MAC address for the reservation (lowercase, colon-separated).'),
            ip: ipv4.describe('Reserved IP address bound to the MAC.'),
            ipxeBuildTarget: IpxeBuildTargetSchema.nullable()
              .optional()
              .describe(
                'Per-device iPXE firmware build override for this reservation. Absent/null = use the prefix-level ipxeBuildTarget.',
              ),
            bootFilename: z
              .string()
              .regex(BOOT_FILENAME_RE)
              .optional()
              .describe(
                'Exact boot filename advertised to this reservation (DHCP option 67), overriding ipxeBuildTarget-derived names. Bare filename servable from the bridge TFTP root; max 127 chars (BOOTP file field). Served only to first-stage PXE ROM requests — chained iPXE (user-class "iPXE") deliberately receives no filename and follows the HTTP chain instead.',
              ),
          })
          .strict(),
      )
      .describe('Static MAC-to-IP reservations (host entries).'),
    proxyAllowedMacs: z
      .array(mac)
      .max(65535)
      .default([])
      .describe(
        "MACs permitted to PXE-boot in PROXY mode; empty = deny-all (fail-closed). Auto-derived from the prefix's known device MACs.",
      ),
    proxyPeerAuthoritative: z
      .boolean()
      .default(false)
      .describe(
        'Operator declaration that an external authoritative DHCP server owns this segment in PROXY mode; ' +
          "silences the bridge's no-lease-authority warning.",
      ),
    dhcpOptions: z
      .array(
        z
          .object({
            code: z.number().int().min(1).max(254).describe('DHCP option code (1..254).'),
            value: z
              .string()
              .describe(
                'Option value in DHCP_OPTIONS grammar (e.g. "10.0.1.1", "aa:bb", "42s"). Bridge encodes to bytes via parseDhcpOptionValue.',
              ),
          })
          .strict(),
      )
      .describe('Raw DHCP options sent to clients beyond the standard fields.'),
    nextServer: ipv4
      .nullable()
      .describe(
        'TFTP next-server IP for PXE boot. Null = bridge derives from its own address; for relayed prefixes with an ipxeBuildTarget the hub sets a bridge IP from the associated prefix; never set for management prefixes.',
      ),
    ipxeBuildTarget: IpxeBuildTargetSchema.nullable().describe(
      'iPXE firmware build variant served to PXE clients. Null when PXE is not used on this prefix.',
    ),
    relay: z
      .object({
        relayAgentIp: DhcpRelayAgentIpSchema.describe('IP of the DHCP relay agent (giaddr).'),
      })
      .strict()
      .nullable()
      .describe('DHCP relay configuration. Null when this prefix does not use relay.'),
  })
  .strict();

export type DhcpAtom = z.infer<typeof DhcpAtomSchema>;

// Zone-global runtime tuning for the bridge DHCP engine, published at `{zoneUuid}:config:dhcp`.
// Keep in sync with apps/bridge/src/dhcp/dhcp-atom-value.schema.ts (separate app/deploy).
export const DhcpZoneOpsAtomSchema = z
  .object({
    leaderPollMs: z.number().int().min(1).describe('Bridge DHCP leader-status/atom poll interval in milliseconds.'),
    pruneIntervalMs: z.number().int().min(1).describe('Expired-lease prune interval in milliseconds.'),
    declineBackoffSeconds: z
      .number()
      .int()
      .min(0)
      .describe('Quarantine window in seconds for an address after a DHCPDECLINE.'),
  })
  .strict();

export type DhcpZoneOpsAtom = z.infer<typeof DhcpZoneOpsAtomSchema>;
