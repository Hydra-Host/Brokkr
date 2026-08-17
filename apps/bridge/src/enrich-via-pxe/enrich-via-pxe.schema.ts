import { z } from 'zod';

import { bmcSecretDispatchFields } from '../common/bmc-secret.schema';

// Cred-saga: BMC creds ride inside the sealed `secrets.bmc` envelope (opened via `credsFromContext`), never as plaintext root fields; `command`/`boot_device` stay at the root (not secret).
export const enrichViaPxeSagaPayloadSchema = z
  .object({
    ...bmcSecretDispatchFields,
    command: z.string().min(1),
    boot_device: z.string().min(1),
  })
  .strict();

export type EnrichViaPxeSagaPayload = z.infer<typeof enrichViaPxeSagaPayloadSchema>;
