import { z } from 'zod';

import { bmcSecretDispatchFields } from '../common/bmc-secret.schema';

export const bmcResetSagaPayloadSchema = z
  .object({
    ...bmcSecretDispatchFields,
  })
  .strict();

export type BmcResetSagaPayload = z.infer<typeof bmcResetSagaPayloadSchema>;
