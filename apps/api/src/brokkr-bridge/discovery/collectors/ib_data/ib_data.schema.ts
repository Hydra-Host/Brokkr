import { z } from 'zod';

const ibPortSchema = z
  .object({
    mlx5_name: z.string().min(1),
    guid: z.string().min(1),
    speed_kbps: z.number().int().nonnegative().optional(),
    max_speed_gbps: z.number().int().nullable().optional(),
    pci_device_id: z.string().optional(),
    link_type: z.string().optional(),
    port_state: z.string().optional(),
    port_phys_state: z.string().optional(),
    link_oper_up: z.boolean().optional(),
    link_physical_up: z.boolean().optional(),
  })
  .passthrough();

export const ibDataSchema = z.array(z.unknown());
export { ibPortSchema };
export type IbDataInput = z.infer<typeof ibDataSchema>;
