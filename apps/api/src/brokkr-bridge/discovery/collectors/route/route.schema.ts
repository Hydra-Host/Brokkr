import { z } from 'zod';

const routeEntrySchema = z
  .object({
    destination: z.string(),
    gateway: z.string(),
    genmask: z.string(),
    flags: z.string(),
    metric: z.number().int(),
    iface: z.string(),
    flags_pretty: z.array(z.string()).optional(),
  })
  .passthrough();

export const routeSchema = z.array(routeEntrySchema);

export type RouteInput = z.infer<typeof routeSchema>;
