import { z } from 'zod';

export const collectionMetadataSchema = z
  .object({
    collectors_total: z.number().int().nonnegative(),
    collectors_successful: z.number().int().nonnegative(),
    fact_categories: z.number().int().nonnegative().optional(),
    collection_mode: z.string().optional(),
    collector_version: z.string().min(1),
    collection_count: z.number().int().nonnegative().optional(),
    timestamp: z.string().optional(),
  })
  .passthrough();

export type CollectionMetadataInput = z.infer<typeof collectionMetadataSchema>;
