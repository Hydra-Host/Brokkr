import { z } from 'zod';

export const lsblkEntrySchema = z
  .object({
    name: z.string().min(1),
    size: z.number().int().nonnegative(),
    rota: z.boolean(),
    serial: z.string().nullable().optional(),
    wwn: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
  })
  .passthrough();

export const lsblkSchema = z.array(z.unknown());

export type LsblkEntry = z.infer<typeof lsblkEntrySchema>;
export type LsblkInput = z.infer<typeof lsblkSchema>;
