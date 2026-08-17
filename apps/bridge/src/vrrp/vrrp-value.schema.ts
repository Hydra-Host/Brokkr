import { z } from 'zod';

import { isValidHostMaskCidr } from './cidr';

export const VrrpValueSchema = z.object({
  vip: z.string().min(1).refine(isValidHostMaskCidr, 'vip must be a canonical IPv4 host/mask CIDR, e.g. "10.0.1.1/24"'),
  ifaceByBridge: z.record(z.string().min(1)),
  // Absent on atoms from an older hub — the reconciler falls back to DEFAULT_GARP_COUNT.
  garpCount: z.number().int().min(1).optional(),
});
