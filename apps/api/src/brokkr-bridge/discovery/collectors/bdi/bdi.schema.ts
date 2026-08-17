import { z } from 'zod';

export const bdiSchema = z
  .object({
    station_mac: z.string().min(1),
    station_arch: z.string().optional(),
    station_mode: z.string().optional(),
    station_ip: z.string().optional(),
    station_netmask: z.string().optional(),
    station_gateway: z.string().optional(),
    bridge_type: z.string().optional(),
  })
  .passthrough();

export type BdiInput = z.infer<typeof bdiSchema>;
