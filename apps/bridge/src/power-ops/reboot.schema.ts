import { z } from 'zod';

import { bmcSecretDispatchFields } from '../common/bmc-secret.schema';

export const rebootSagaPayloadSchema = z
  .object({
    ...bmcSecretDispatchFields,
    boot_device: z.string().min(1).default('disk'),
    boot_target: z.string().min(1).default('os'),
  })
  .strict();

export type RebootSagaPayload = z.infer<typeof rebootSagaPayloadSchema>;
