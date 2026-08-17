import { z } from 'zod';

export const getArchitecture = {
  input: z.object({}),
  output: z.object({
    arch: z
      .enum(['x86_64', 'aarch64', 'unknown'])
      .describe("Normalised architecture: 'x86_64', 'aarch64', or 'unknown' when the probe didn't match."),
    raw: z.string().describe('Unmodified `uname -m` output, preserved for debugging and for future arch values.'),
  }),
} as const;

export const EfiBootOption = z
  .object({
    boot_option_reference: z
      .string()
      .describe("EFI boot option reference, e.g. 'Boot0001'. Includes the 'Boot' prefix."),
    display_name: z
      .string()
      .describe(
        'Human-readable boot entry name, e.g. "Ubuntu", "ipxe disk". Used by cleanup_os_boot_entries for keyword matching.',
      ),
  })
  .passthrough();

export const getEfiBootMenu = {
  input: z.object({}),
  output: z.object({
    boot_current: z
      .string()
      .nullable()
      .describe("Currently-booted EFI entry id (no 'Boot' prefix), e.g. '0001'. Null when firmware reports none."),
    boot_order: z
      .array(z.string())
      .nullable()
      .describe('Ordered list of EFI entry ids reflecting BootOrder. Null when firmware reports none.'),
    boot_options: z
      .array(EfiBootOption)
      .nullable()
      .describe('All enumerated boot entries. Null when firmware reports none.'),
    boot_next: z.string().nullable().describe('One-shot BootNext override, if set. Null when firmware reports none.'),
  }),
} as const;

export const removeEfiBootEntry = {
  input: z.object({
    // Hex-only: passed verbatim into `efibootmgr -B -b <boot_id>` as root — a dash-prefixed value would be argument injection.
    boot_id: z
      .string()
      .regex(/^[0-9A-Fa-f]{1,4}$/, "boot_id must be 1-4 hex digits (EFI entry id, e.g. '0001')")
      .describe("Boot entry id to remove, without the 'Boot' prefix, e.g. '0001'."),
  }),
  output: z.object({
    success: z
      .boolean()
      .describe("True iff efibootmgr exited 0; false when the entry didn't exist or firmware refused the delete."),
  }),
} as const;

export const cleanupOsBootEntries = {
  input: z.object({}),
  output: z.object({
    removed: z.array(z.string()).describe('Display names of boot entries that were removed, in enumeration order.'),
    count: z.number().int().nonnegative().describe('Number of entries removed; equals `removed.length`.'),
  }),
} as const;

export const forceBootDevice = {
  input: z.object({}),
  output: z.object({
    boot_current: z.string().nullable().describe('Pre-cleanup boot_current (see system.getEfiBootMenu).'),
    boot_order: z.array(z.string()).nullable().describe('Pre-cleanup boot_order snapshot.'),
    entries_removed: z
      .number()
      .int()
      .nonnegative()
      .describe(
        'Number of non-current entries removed. Zero when boot_current or boot_order is missing (no-op fast path).',
      ),
  }),
} as const;

export const operations = {
  getArchitecture,
  getEfiBootMenu,
  removeEfiBootEntry,
  cleanupOsBootEntries,
  forceBootDevice,
} as const;
