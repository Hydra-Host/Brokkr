import { z } from 'zod';

export const deviceRecordSchema = z.object({
  id: z.string(),
  is_placeholder: z.boolean().default(false),
  status: z.string().nullish(),
  role: z.string().nullish(),
  installed_os: z.string().nullish(),
  rescue_os: z.string().nullish(),
  platform_tags: z.array(z.string()).default([]),
  device_type: z.string().nullish(),
  netplan: z.string().nullish(),
  serial_port_recommended: z.string().nullish(),
  serial_baud_recommended: z.number().int().nullish(),
  location_network_type: z.string().nullish(),
  is_vpc: z.boolean().default(false),
  last_job_id: z.string().nullish(),
  buildarch: z.string().nullish(),
});

export type DeviceRecord = z.infer<typeof deviceRecordSchema>;

export function isPlaceholder(record: DeviceRecord): boolean {
  return record.is_placeholder;
}
