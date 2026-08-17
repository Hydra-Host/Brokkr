import { z } from 'zod';

import { isValidHostMaskCidr } from '../shared/ip-schemas';

export const VrrpAtomSchema = z
  .object({
    vip: z
      .string()
      .min(1)
      .refine(isValidHostMaskCidr)
      .describe('VRRP floating IP in host/mask CIDR form, e.g. "10.0.1.1/24".'),
    ifaceByBridge: z
      .record(z.string().min(1))
      .describe(
        "Per-bridge NIC to bind the VIP on, keyed by the bridge's Device.name (== BRIDGE_HOSTNAME). " +
          "A zone's bridges can name the VIP-facing NIC differently; a bridge absent from this map does not bind the VIP.",
      ),
    garpCount: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('Gratuitous ARPs the leader sends on a fresh VIP bind (zone-level tuning; bridge defaults to 5).'),
  })
  .strict();

export type VrrpAtom = z.infer<typeof VrrpAtomSchema>;
