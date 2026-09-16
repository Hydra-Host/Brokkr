import { z } from 'zod';

const addrInfoSchema = z
  .object({
    family: z.string().optional(),
    local: z.string().optional(),
    scope: z.string().optional(),
    prefixlen: z.number().optional(),
  })
  .passthrough();

const ipInterfaceSchema = z
  .object({
    ifname: z.string().min(1),
    link_type: z.string().optional(),
    operstate: z.string().optional(),
    flags: z.array(z.string()).optional().default([]),
    address: z.string().optional(),
    // Burned-in hardware MAC, reported only when the live `address` differs —
    // bond enslavement, a manual `ip link set … address`, an SR-IOV VF.
    // Detect bonds via `master`, not this field.
    permaddr: z.string().optional(),
    // Names the bond/bridge this interface is a member of.
    master: z.string().optional(),
    // Parent device of a sub-interface — the `@eno1` in `eno1.100@eno1`.
    link: z.string().optional(),
    // udev names
    altnames: z.array(z.string()).optional().default([]),
    addr_info: z.array(addrInfoSchema).optional().default([]),
  })
  .passthrough();

export const ipASchema = z.array(z.unknown());
export { ipInterfaceSchema };
export type IpAInput = z.infer<typeof ipASchema>;
