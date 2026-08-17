import { z } from 'zod';

import { forwardedSecretSchema } from '../zone-crypto/device-secret-open';

export const bmcSecretDispatchFields = {
  bmc_ip: z.string().min(1),
  device_id: z.string(),
  secrets: z
    .object({
      bmc: forwardedSecretSchema,
    })
    .strict(),
} as const;
