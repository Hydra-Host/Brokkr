import { z } from 'zod';

// Sibling of `DcimInterfaceIpSchema` in ./dcim, which carries `status` (IPAM lifecycle) instead of
// `prefix` (zone containment) — the two endpoints expose different facets; don't merge.
const InterfaceIpAddressSchema = z.object({
  id: z.string().uuid().describe('IpAddress UUID, for linking to the IPAM object.'),
  address: z.string().describe('IP address assigned to the interface'),
  prefix: z
    .object({
      id: z.string().uuid().describe('Prefix UUID'),
      prefix: z.string().describe('Containing prefix in CIDR notation'),
      role: z
        .string()
        .nullable()
        .describe("Containing prefix's role slug (e.g. primary, management), or null when the prefix has no role"),
    })
    .nullable()
    .optional()
    .describe(
      "Longest-match containing Prefix within the device's zone, or null when none contains this IP. Only enriched on the bridge detail read; absent on server detail and all list endpoints.",
    ),
});

// Shared network-interface shape for device detail responses (bridges + servers).
export const InterfaceSchema = z.object({
  name: z.string().describe('Name of the network interface'),
  type: z
    .string()
    .nullable()
    .optional()
    .describe('Interface type (e.g. ETHERNET_10G, BOND, VIRTUAL). Null when the type is not yet known.'),
  mac_address: z.string().describe('MAC address of the network interface'),
  ip_addresses: z.array(InterfaceIpAddressSchema).describe('List of IP addresses assigned to this interface'),
  mark_connected: z.boolean().describe('Whether the interface is marked as connected'),
  enabled: z.boolean().describe('Whether the interface is enabled'),
  mgmt_only: z.boolean().describe('Whether the interface is used only for management traffic'),
});

export type Interface = z.infer<typeof InterfaceSchema>;
