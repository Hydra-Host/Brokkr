import { z } from 'zod';

export const COLLECTORS = [
  'bdi',
  'bmc',
  'cpld',
  'ghw_baseboard',
  'ghw_chassis',
  'ghw_product',
  'ghw_bios',
  'ghw_net',
  'ghw_memory',
  'ghw_cpu',
  'ip_a',
  'ib_data',
  'lldp',
  'public_ip',
  'lsblk',
  'lscpu',
  'nvidia',
  'pci',
  'dmidecode',
  'dmidecode_memory',
  'version',
  'is_virtual',
  'firmware_type',
  'serial_ports',
  'architecture',
  'virtualization',
  'kernel_params',
] as const;

export type CollectorName = (typeof COLLECTORS)[number];

export const REQUIRED_COLLECTORS: CollectorName[] = [
  'bdi',
  'bmc',
  'ghw_baseboard',
  'ghw_chassis',
  'ghw_product',
  'lsblk',
  'lscpu',
  'ghw_cpu',
];

export const discoveryCompleteDataSchema = z.object({
  device_id: z.string(),
  zone_prefix: z.string(),
  fields: z.array(z.string()),
  job_id: z.string().default('discovery'),
  timestamp: z.number(),
});

export type DiscoveryCompleteData = z.infer<typeof discoveryCompleteDataSchema>;

export function deviceDiscoveryCollectorKey(zonePrefix: string, deviceId: string, field: string): string {
  return zonePrefix ? `${zonePrefix}:device:${deviceId}:discovery:${field}` : `device:${deviceId}:discovery:${field}`;
}
