import { z } from 'zod';

// Empty `{}` when the driver is absent or CC mode hides GPUs — existing Gpu rows must not be clobbered then.
const nvidiaGpuSchema = z
  .object({
    index: z.number().int().nonnegative(),
    name: z.string().min(1),
    uuid: z.string().min(1),
    'memory.total': z.number().int().positive().optional(),
    vbios: z.string().optional(),
    serial: z.string().optional(),
  })
  .passthrough();

const nvidiaPopulatedSchema = z
  .object({
    count: z.number().int().nonnegative(),
    model: z.string().min(1),
    gpus: z.array(nvidiaGpuSchema),
  })
  .passthrough();

const nvidiaEmptySchema = z.object({}).strict();

export const nvidiaSchema = z.union([nvidiaPopulatedSchema, nvidiaEmptySchema]);
export type NvidiaInput = z.infer<typeof nvidiaSchema>;
