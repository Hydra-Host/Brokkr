import { z } from 'zod';
import { hardwareString } from '../hardware-string';

const processorSchema = z
  .object({
    id: z.number().int().nonnegative(),
    model: hardwareString(),
    vendor: z.string().optional(),
    total_cores: z.number().int().positive().optional(),
    total_threads: z.number().int().positive().optional(),
    capabilities: z.array(z.string()).optional(),
  })
  .passthrough();

export const ghwCpuSchema = z
  .object({
    cpu: z
      .object({
        total_cores: z.number().int().positive(),
        total_threads: z.number().int().positive(),
        processors: z.array(processorSchema).min(1),
      })
      .passthrough(),
  })
  .passthrough();

export type GhwCpuInput = z.infer<typeof ghwCpuSchema>;
