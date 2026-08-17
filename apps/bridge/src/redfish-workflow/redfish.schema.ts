import { z } from 'zod';

import { bmcSecretDispatchFields } from '../common/bmc-secret.schema';

// BMC credentials ride sealed in `secrets.bmc`, never as plaintext payload-root fields.
export const redfishSagaPayloadSchema = z
  .object({
    ...bmcSecretDispatchFields,
    command: z.string().min(1),
    kwargs: z.record(z.unknown()).nullable().default(null),
  })
  .strict();

export type RedfishSagaPayload = z.infer<typeof redfishSagaPayloadSchema>;
