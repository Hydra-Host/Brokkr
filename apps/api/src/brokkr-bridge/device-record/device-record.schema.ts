import { z } from 'zod';

export const DeviceRecordSchema = z
  .object({
    id: z
      .string()
      .describe('Brokkr Device UUID for real devices; a deterministic placeholder UUIDv5 for unknown devices.'),
    is_placeholder: z
      .boolean()
      .default(false)
      .describe(
        'True for hub-minted placeholder records (unknown PXE-booting device); false/omitted for real devices.',
      ),
    status: z
      .string()
      .nullable()
      .describe('Server.lifecycleStatus (falling back to Device.status) — drives boot target.'),
    role: z
      .string()
      .nullable()
      .describe('Canonical hyphenated device-role boot slug (e.g. discovered-hosts, brokkr-bridge).'),
    installed_os: z
      .string()
      .nullable()
      .describe("The deployment's selected OS slug — booted off disk when no rescue_os is set."),
    rescue_os: z
      .string()
      .nullable()
      .describe(
        'Transient boot override slug (brokkr-discovery during provision/deprovision, ubuntu-rescue-os for rescue mode); booted instead of installed_os when set.',
      ),
    platform_tags: z
      .array(z.string())
      .default([])
      .describe(
        'Lowercased, sorted slugs of the tags assigned to the device, read by the spoke when it renders the boot chain; always empty on a placeholder.',
      ),
    device_type: z
      .string()
      .nullable()
      .describe(
        'DeviceModel slug. Bridge computes `pci_realloc_off` / `purge_ttys` from this — no change to that logic.',
      ),
    netplan: z.string().nullable().describe('Raw netplan YAML. Hub computes including DHCP fallback if needed.'),
    serial_port_recommended: z
      .string()
      .nullable()
      .describe(
        'Console serial port (e.g. ttyS1) — the in-band probed answer when available, else the heuristic recommendation; bridge injects into the kernel cmdline.',
      ),
    serial_baud_recommended: z
      .number()
      .int()
      .nullable()
      .describe(
        'Console baud for serial_port_recommended; bridge injects into the kernel cmdline (defaults to 115200 when null).',
      ),
    location_network_type: z.string().nullable().describe('East-west fabric type — from Zone.eastWestNetworkType.'),
    is_vpc: z.boolean().default(false).describe('Location is a VPC fabric — sourced from Zone.networkType === VPC.'),
    last_job_id: z.string().nullable().describe('Last lifecycle job id touching this device.'),
    buildarch: z
      .string()
      .nullable()
      .describe(
        'iPXE buildarch from PXE boot — used for placeholder records only; null on real records (bridge has buildarch from the request).',
      ),
  })
  .strict();

export type DeviceRecord = z.infer<typeof DeviceRecordSchema>;
