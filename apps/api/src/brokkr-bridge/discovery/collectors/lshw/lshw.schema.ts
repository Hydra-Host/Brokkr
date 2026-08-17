import { z } from 'zod';

export const lshwSchema = z
  .object({
    id: z.string().min(1),
    class: z.string().min(1),
    children: z.array(z.unknown()).optional(),
  })
  .passthrough();

export type LshwInput = z.infer<typeof lshwSchema>;
