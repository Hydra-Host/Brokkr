import { z } from 'zod';

export const lscpuSchema = z
  .object({
    total_cpu_sockets: z.number().int().positive(),
    total_cpu_cores: z.number().int().positive(),
    total_cpu_threads: z.number().int().positive(),
    per_cpu_cores: z.number().int().positive().optional(),
    per_cpu_threads: z.number().int().positive().optional(),
    cpu_family: z.string().optional(),
    cpu_model: z.string().optional(),
  })
  .passthrough();

export type LscpuInput = z.infer<typeof lscpuSchema>;
