import { SUPPORTED_DISK_FORMATS } from '@repo/api-client';
import { z } from 'zod';

export type DiskFormat = (typeof SUPPORTED_DISK_FORMATS)[number];

export const DiskLayoutSchema = z.array(
  z.object({
    config: z.string().min(1),
    format: z.enum(SUPPORTED_DISK_FORMATS),
    mountpoint: z.string().min(1),
    diskType: z.string().min(1),
    disks: z.array(z.string().min(1)),
    wipe: z.boolean().default(true),
  }),
);

export const customizationsSchema = z
  .record(z.string(), z.union([z.string(), z.array(z.string())]))
  .nullable()
  .optional()
  .describe(
    'OS layer customizations keyed by layer slug (e.g. {"gpuDriver": "nvidia-driver-580", "miscSoftware": ["docker"]}). Null/omitted for legacy images or an un-customized base.',
  );

export function toDiskFormat(format: string): DiskFormat {
  return (SUPPORTED_DISK_FORMATS as readonly string[]).includes(format)
    ? (format as DiskFormat)
    : SUPPORTED_DISK_FORMATS[0];
}

export function coerceDefaultDiskLayouts<T extends { format: string }>(
  layouts: readonly T[],
): (T & { format: DiskFormat; wipe: boolean })[] {
  return layouts.map((dl) => ({
    ...dl,
    format: toDiskFormat(dl.format),
    wipe: (dl as { wipe?: boolean }).wipe ?? true,
  }));
}
