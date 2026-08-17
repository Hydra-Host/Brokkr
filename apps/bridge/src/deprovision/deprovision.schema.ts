import { z } from 'zod';

import { bmcSecretDispatchFields } from '../common/bmc-secret.schema';

export const deprovisionSagaPayloadSchema = z
  .object({
    ...bmcSecretDispatchFields,
    tee_enabled: z.boolean(),
    boot_device: z.string().min(1),
  })
  .strict();

export type DeprovisionSagaPayload = z.infer<typeof deprovisionSagaPayloadSchema>;
