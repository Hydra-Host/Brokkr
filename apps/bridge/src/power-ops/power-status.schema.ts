import { z } from 'zod';

import { bmcSecretDispatchFields } from '../common/bmc-secret.schema';

export const powerStatusSagaPayloadSchema = z
  .object({
    ...bmcSecretDispatchFields,
  })
  .strict();

export type PowerStatusSagaPayload = z.infer<typeof powerStatusSagaPayloadSchema>;
