import { z } from 'zod';

import { bmcSecretDispatchFields } from '../common/bmc-secret.schema';

export const commissionSagaPayloadSchema = z
  .object({
    ...bmcSecretDispatchFields,
    boot_device: z.string().min(1),
    storage_layouts: z.record(z.unknown()),
  })
  .strict();

export type CommissionSagaPayload = z.infer<typeof commissionSagaPayloadSchema>;
