import { z } from 'zod';

import { bmcSecretDispatchFields } from '../common/bmc-secret.schema';

// BMC credentials ride sealed in `secrets.bmc`, never as plaintext payload-root fields.
export const solSagaPayloadSchema = z
  .object({
    ...bmcSecretDispatchFields,
    port: z.number().int().default(623),
    timeout: z.number().int().default(300),
    pass_strings: z.array(z.string()).default(() => [' login:']),
    fail_strings: z.array(z.string()).default(() => ['timeout', 'grub>']),
    device_id: z.string().nullable().default(null),
  })
  .strict();

export type SolSagaPayload = z.infer<typeof solSagaPayloadSchema>;
