import { z } from 'zod';
import { hardwareString } from '../hardware-string';

const diskSchema = z
  .object({
    name: z.string().min(1),
    size_bytes: z.number().int().nonnegative(),
    physical_block_size_bytes: z.number().int().positive().optional(),
    drive_type: z.string().optional(),
    storage_controller: hardwareString(),
    bus_path: hardwareString(),
    vendor: hardwareString(),
    model: hardwareString(),
    serial_number: hardwareString(),
    wwn: hardwareString(),
  })
  .passthrough();

export const ghwBlockSchema = z
  .object({
    block: z
      .object({
        total_size_bytes: z.number().int().nonnegative().optional(),
        disks: z.array(z.unknown()),
      })
      .passthrough(),
  })
  .passthrough();

export { diskSchema as ghwBlockDiskSchema };
export type GhwBlockInput = z.infer<typeof ghwBlockSchema>;
