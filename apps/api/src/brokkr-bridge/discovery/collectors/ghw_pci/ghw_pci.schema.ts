import { z } from 'zod';

const idNameSchema = z
  .object({
    id: z.string(),
    name: z.string().optional().default(''),
  })
  .passthrough();

const ghwPciDeviceSchema = z
  .object({
    address: z.string().min(1),
    driver: z.string().optional().default(''),
    vendor: idNameSchema,
    product: idNameSchema,
    class: idNameSchema.optional(),
    subclass: idNameSchema.optional(),
    subsystem: idNameSchema.optional(),
  })
  .passthrough();

export const ghwPciSchema = z
  .object({
    pci: z
      .object({
        Devices: z.array(z.unknown()).optional().default([]),
      })
      .passthrough(),
  })
  .passthrough();

export { ghwPciDeviceSchema };
export type GhwPciInput = z.infer<typeof ghwPciSchema>;
