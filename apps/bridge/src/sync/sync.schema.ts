import { z } from 'zod';

export const syncSagaPayloadSchema = z
  .object({
    sync_type: z.string().nullish(),
    force: z.boolean().nullish(),
  })
  .strict();

export type SyncSagaPayload = z.infer<typeof syncSagaPayloadSchema>;
