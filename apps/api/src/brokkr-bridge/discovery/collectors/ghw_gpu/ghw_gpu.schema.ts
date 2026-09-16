import { z } from 'zod';

// pci is null for non-PCI cards such as simple-framebuffer
const ghwGpuCardSchema = z
  .object({
    pci: z
      .object({
        vendor: z.object({ name: z.string().nullish() }).passthrough().nullish(),
        product: z.object({ name: z.string().nullish() }).passthrough().nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

export const ghwGpuSchema = z
  .object({
    gpu: z
      .object({
        cards: z.array(ghwGpuCardSchema).optional().default([]),
      })
      .passthrough(),
  })
  .passthrough();

export type GhwGpuInput = z.infer<typeof ghwGpuSchema>;
