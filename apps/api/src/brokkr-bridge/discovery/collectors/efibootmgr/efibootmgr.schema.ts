import { z } from 'zod';

const bootOptionSchema = z
  .object({
    boot_option_reference: z.string().min(1),
    display_name: z.string(),
    uefi_device_path: z.string().nullable().optional(),
    boot_option_enabled: z.boolean(),
  })
  .passthrough();

export const efibootmgrSchema = z
  .object({
    boot_current: z.string().optional(),
    timeout_seconds: z.number().int().nonnegative().optional(),
    boot_order: z.array(z.string()).optional(),
    boot_options: z.array(bootOptionSchema).default([]),
  })
  .passthrough();

export type EfibootmgrInput = z.infer<typeof efibootmgrSchema>;
