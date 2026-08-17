import { z } from 'zod';

export const ghwGpuSchema = z
  .object({
    gpu: z
      .object({
        cards: z.array(z.unknown()).optional().default([]),
      })
      .passthrough(),
  })
  .passthrough();

export type GhwGpuInput = z.infer<typeof ghwGpuSchema>;
