import { z } from 'zod';

export const ghwMemorySchema = z
  .object({
    memory: z
      .object({
        total_physical_bytes: z.number().int().positive(),
        total_usable_bytes: z.number().int().positive().optional(),
        supported_page_sizes: z.array(z.number()).optional(),
        modules: z.null().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export type GhwMemoryInput = z.infer<typeof ghwMemorySchema>;
