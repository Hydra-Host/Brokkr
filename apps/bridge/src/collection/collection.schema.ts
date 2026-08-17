import { z } from 'zod';

export const inventoryCollectionSagaPayloadSchema = z
  .object({
    device_id: z.string(),
  })
  .strict();

export type InventoryCollectionSagaPayload = z.infer<typeof inventoryCollectionSagaPayloadSchema>;
