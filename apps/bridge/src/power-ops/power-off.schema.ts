import { z } from 'zod';

import { bmcSecretDispatchFields } from '../common/bmc-secret.schema';

export const powerOffSagaPayloadSchema = z
  .object({
    ...bmcSecretDispatchFields,
  })
  .strict();

export type PowerOffSagaPayload = z.infer<typeof powerOffSagaPayloadSchema>;
