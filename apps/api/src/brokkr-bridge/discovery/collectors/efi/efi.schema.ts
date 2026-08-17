import { z } from 'zod';

export const efiSchema = z
  .object({
    detected: z.boolean(),
  })
  .passthrough();

export type EfiInput = z.infer<typeof efiSchema>;
