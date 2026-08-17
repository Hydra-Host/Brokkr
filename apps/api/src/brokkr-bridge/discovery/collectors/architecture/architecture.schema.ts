import { z } from 'zod';

export const architectureSchema = z
  .object({
    machine: z.string().min(1),
  })
  .passthrough();

export type ArchitectureInput = z.infer<typeof architectureSchema>;
