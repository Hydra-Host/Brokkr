import { z } from 'zod';

const DISK_NAME_PATTERN = /^(sd[a-z]+\d*|nvme\d+n\d+(?:p\d+)?|md\d+)$/;
export const DiskName = z
  .string()
  .regex(DISK_NAME_PATTERN)
  .describe("Device name without /dev/ prefix, e.g. 'sda', 'nvme0n1', 'md0'.");

// eslint-disable-next-line no-control-regex -- intentional: exclude control bytes from target path segments
const TARGET_PATH_PATTERN = /^\/(target|mnt)(\/[^/\x00-\x1f]+)*$/;
export const TargetPath = z
  .string()
  .regex(TARGET_PATH_PATTERN, { message: 'must be /target or /mnt, optionally followed by path segments' })
  .refine((p) => p.split('/').every((s) => s !== '.' && s !== '..'), {
    message: "must not contain '.' or '..' path segments",
  })
  .describe(
    'Chroot root for an install-time operation. Must be /target or /mnt, ' +
      "optionally followed by non-dot path segments (no '.' or '..').",
  );

export const DiskType = z
  .enum(['nvme', 'ssd', 'rotational'])
  .describe("Disk media classification used to pick the NIST wipe strategy chain. 'rotational' = spinning HDD.");
export type DiskType = z.infer<typeof DiskType>;

export const Environment = z
  .enum(['production', 'development'])
  .describe("Wipe-mode toggle authoritative on the bridge. 'development' skips the long HDD random-overwrite pass.");
export type Environment = z.infer<typeof Environment>;

export const DiskLayout = z.object({
  disks: z.array(z.string()).describe('Disk identifiers (WWN, serial, or device name); agent resolves to /dev/ paths.'),
  wipe: z.boolean().describe('True to sanitize the disks in this group; false to preserve existing data.'),
  mountpoint: z.string().optional().describe('Where the resolved volume will be mounted after preparation.'),
  fs_type: z
    .string()
    .optional()
    .describe(
      "Filesystem type the layout will be formatted as (e.g. 'ext4', 'xfs'). For preserved-LUKS volumes the agent uses this as the fs_type in the generated fstab entry, since the LUKS probe can't see inside the container.",
    ),
});
export type DiskLayout = z.infer<typeof DiskLayout>;

export const ResolvedDiskLayout = z.object({
  disks: z.array(z.string()).describe("Concrete device names (no /dev/ prefix), e.g. 'sda', 'nvme0n1'."),
  size_bytes: z
    .number()
    .int()
    .nonnegative()
    .describe(
      'Size of the smallest disk in the group, in bytes — partition geometry must fit on every member, so the group is bounded by its smallest disk.',
    ),
  wipe: z.boolean().describe('Echoes the layout wipe flag.'),
  mountpoint: z.string().optional().describe('Echoes the layout mountpoint.'),
  fs_type: z.string().optional().describe('Echoes the layout fs_type.'),
});
export type ResolvedDiskLayout = z.infer<typeof ResolvedDiskLayout>;

export const BlockDevice = z.object({
  name: z.string().describe("Device name without /dev/ prefix, e.g. 'sda'."),
  rota: z.boolean().describe('lsblk ROTA flag: true for rotational (HDD), false for flash (SSD/NVMe).'),
  type: z.string().describe("lsblk TYPE, e.g. 'disk', 'part', 'raid1', 'crypt'."),
  size: z.number().int().nonnegative().describe('Device size in bytes (lsblk -b).'),
  ro: z.boolean().describe('True iff the device is read-only.'),
  model: z.string().nullable().describe('Vendor model string, when reported.'),
  serial: z.string().nullable().describe('Serial number, when reported. Used as a disk identifier in layouts.'),
  wwn: z
    .string()
    .optional()
    .describe('World-wide name, when reported and non-null; omitted otherwise. Used as a disk identifier in layouts.'),
  tran: z.string().nullable().describe("Transport type, e.g. 'sata', 'nvme', 'usb'."),
  mountpoints: z.array(z.string().nullable()).optional().describe('Current mountpoints (may contain null entries).'),
});
export type BlockDevice = z.infer<typeof BlockDevice>;

export const EncryptedVolume = z.object({
  device: z.string().describe('Leaf LUKS device path, e.g. /dev/nvme0n1p3 or /dev/md0.'),
  mapper: z.string().describe("Mapper name without /dev/mapper/ prefix, e.g. 'crypt-data'."),
  mountpoint: z.string().describe("Mountpoint for the decrypted volume, e.g. '/mnt/data'."),
  fs_type: z.string().describe("Filesystem type inside the LUKS container, e.g. 'xfs', 'ext4'."),
  label: z.string().describe('Filesystem label; used by the rekey script to locate the volume.'),
  luks_uuid: z
    .string()
    .optional()
    .describe(
      'Stored LUKS UUID of a preserved volume; lets luks-unlock pair a baked mapper to its own array by UUID. Absent for newly-provisioned volumes (UUID not yet known at render time).',
    ),
});
export type EncryptedVolume = z.infer<typeof EncryptedVolume>;

export const PreservedDiskInfo = z.object({
  detected_luks: z.boolean().describe('True iff a LUKS header was found on the leaf device.'),
  luks_uuid: z.string().describe('LUKS UUID when detected; empty string otherwise.'),
  fs_uuid: z.string().describe('Plain-filesystem UUID when detected; empty string otherwise.'),
  fs_type: z.string().describe('Plain-filesystem type when detected; empty string otherwise.'),
  leaf_device: z.string().describe("Leaf device path the probe ran against, e.g. '/dev/sda1' or '/dev/md0'."),
  dm_name: z.string().optional().describe('dm-crypt mapper name when detected from an active mapping.'),
});
export type PreservedDiskInfo = z.infer<typeof PreservedDiskInfo>;

export const discoverDisks = {
  input: z.object({}),
  output: z.object({
    blockdevices: z.array(BlockDevice).describe('All block devices reported by lsblk, minus USB and floppy drives.'),
  }),
} as const;

export const resolveDisks = {
  input: z.object({
    disk_layouts: z.array(DiskLayout).describe('Disk layouts with unresolved identifiers (WWN/serial/device name).'),
  }),
  output: z.object({
    layouts: z.array(ResolvedDiskLayout).describe('Layouts with identifiers resolved to concrete device names.'),
  }),
} as const;

export const detectUefiMode = {
  input: z.object({}),
  output: z.object({
    uefi_mode: z.boolean().describe('True iff /sys/firmware/efi exists on the booted system.'),
  }),
} as const;

export const detectExistingVolumeGroups = {
  input: z.object({}),
  output: z.object({
    volume_group_names: z.array(z.string()).describe('LVM volume group names active on the system.'),
  }),
} as const;

export const detectExistingRaidArrays = {
  input: z.object({}),
  output: z.object({
    md_device_names: z
      .array(z.string())
      .describe("Assembled md array names (e.g. 'md0', 'md127') active on the system."),
  }),
} as const;

export const detectRaidControllers = {
  input: z.object({}),
  output: z.object({
    disk_raid_status: z
      .record(z.string(), z.boolean())
      .describe("Map from device name (e.g. 'sda') to true when behind a RAID/storage controller; false otherwise."),
    controllers: z
      .array(
        z.object({
          pci_address: z.string().describe("PCI address in BDF form, e.g. '0000:04:00.0'."),
          description: z.string().describe('lspci verbose description of the controller.'),
          attached_disks: z.array(z.string()).describe('Device names attached to this controller.'),
        }),
      )
      .describe('RAID/storage controllers detected on the system.'),
  }),
} as const;

export const detectPreservedDiskInfo = {
  input: z.object({
    disk_name: DiskName,
    claimed_md_devices: z
      .array(z.string())
      .default([])
      .describe(
        'MD devices already claimed by earlier disk groups in this pass; prevents the md-fallback from double-claiming.',
      ),
  }),
  output: PreservedDiskInfo,
} as const;

export const unmountDisks = {
  input: z.object({}),
  output: z.object({
    unmounted_paths: z.array(z.string()).describe('Mountpoint paths that were successfully unmounted.'),
  }),
} as const;

export const wipeDisk = {
  input: z.object({
    disk_name: DiskName,
    disk_type: DiskType.describe('Media classification; selects the strategy chain.'),
    is_raid_controller: z
      .boolean()
      .describe('Whether the disk sits behind a RAID controller; affects SSD/HDD strategy.'),
    environment: Environment.describe('Wipe mode; gates the full-overwrite HDD pass.'),
    controller_has_preserved_sibling: z
      .boolean()
      .default(false)
      .describe(
        'NVMe only: true iff ANOTHER namespace on the same controller is preserved. ' +
          'NVMe Sanitize is controller-wide, so when set the agent refuses Sanitize and uses ' +
          'only namespace-scoped erasure (nvme format <namespace>, blkdiscard) to spare the sibling.',
      ),
  }),
  output: z.object({
    method_used: z
      .string()
      .describe("Exact technique string matching the Python port, e.g. 'NVMe Sanitize Block Erase (Purge)'."),
  }),
} as const;

// Marker carries the random bytes (hex), not just the offset: overwrite-class methods pass when the sector CHANGED from the marker, not when it reads zero.
const ValidationMarkerSchema = z.object({
  sector: z.number().int().nonnegative().describe('Sector offset (512-byte units) where the marker was written.'),
  marker: z.string().describe('Hex-encoded 512 random bytes written at this sector pre-wipe.'),
});

export const writeValidationMarkers = {
  input: z.object({
    disk_name: DiskName,
  }),
  output: z.object({
    markers: z
      .array(ValidationMarkerSchema)
      .describe('Per-sector random markers written pre-wipe; passed back into validateWipe.'),
  }),
} as const;

// Pass criteria by method class: crypto-erase tolerates non-zero residue; overwrite-class passes when sectors differ from their markers; zeroing requires all-zero reads.
export const validateWipe = {
  input: z.object({
    disk_name: DiskName,
    markers: z.array(ValidationMarkerSchema).describe('Marker list returned by writeValidationMarkers.'),
    method: z
      .string()
      .describe(
        'Exact Python technique string from wipeDisk; classifies whether residual non-zero data passes or fails.',
      ),
  }),
  output: z.object({
    method: z.literal('sector_sampling').describe('Validation method used; currently always sector_sampling.'),
    sample_count: z.number().int().nonnegative().describe('Total sample points written pre-wipe.'),
    sectors_checked: z.number().int().nonnegative().describe('Total sectors attempted (sample count minus skipped).'),
    sectors_zeroed: z.number().int().nonnegative().describe('Sectors whose 512 bytes read back as all zero.'),
    sectors_failed: z.number().int().nonnegative().describe('Sectors with at least one non-zero byte.'),
    sectors_unreadable: z
      .number()
      .int()
      .nonnegative()
      .describe(
        'Sectors that returned EIO / other read errors. A large fraction fails the attestation (see MAX_UNREADABLE_FRACTION in validateWipe.ts).',
      ),
    result: z
      .enum(['pass', 'fail', 'pass_crypto_erase', 'skipped'])
      .describe(
        "Verdict. 'pass_crypto_erase' is the intentional pass state for crypto-erase methods with non-zero residue.",
      ),
    note: z
      .string()
      .optional()
      .describe('Human-readable context, especially for pass_crypto_erase / skipped / too-many-unreadable.'),
  }),
} as const;

export const teardownHolders = {
  input: z.object({
    disks: z.array(z.string()).describe('Disk names to tear down (no /dev/ prefix).'),
    preserve_disks: z
      .array(z.string())
      .default([])
      .describe('Disks whose data must be preserved; any array/LV/crypt with a member here is skipped entirely.'),
  }),
  output: z.object({
    crypt_closed: z.array(z.string()).describe('dm-crypt mappers that were closed.'),
    lvm_removed: z.array(z.string()).describe('Logical volumes that were removed.'),
    vg_removed: z.array(z.string()).describe('Volume groups that were removed.'),
    raid_stopped: z.array(z.string()).describe('MD devices that were stopped.'),
    swap_deactivated: z.array(z.string()).describe('Swap devices/files that were deactivated.'),
    signatures_cleared: z.array(z.string()).describe('Partition signatures cleared with wipefs.'),
    skipped_preserved: z.array(z.string()).describe('Entities skipped because they touched a preserved disk.'),
  }),
} as const;

export const clearGpt = {
  input: z.object({
    disk_name: DiskName,
  }),
  output: z.object({
    success: z.boolean().describe('True iff sgdisk and wipefs both exited zero.'),
  }),
} as const;

export const applyStorageLayout = {
  input: z.object({
    curtin_yaml: z.string().describe('Rendered curtin storage YAML; agent writes to /tmp/storage-config.yaml.'),
    target_path: TargetPath.default('/target'),
  }),
  output: z.object({
    fstab_content: z.string().describe('fstab body curtin generated from the applied layout.'),
    success: z.boolean().describe('True iff curtin exited zero.'),
    error: z.string().optional().describe('Error text when success=false.'),
  }),
} as const;

export const VerificationResult = z
  .discriminatedUnion('result', [
    z.object({
      method: z.literal('sector_sampling'),
      sample_count: z.number().int().nonnegative(),
      sectors_checked: z.number().int().nonnegative(),
      sectors_zeroed: z.number().int().nonnegative(),
      sectors_failed: z.number().int().nonnegative(),
      sectors_unreadable: z.number().int().nonnegative(),
      result: z.literal('pass'),
      note: z.string().optional(),
    }),
    z.object({
      method: z.literal('sector_sampling'),
      sample_count: z.number().int().nonnegative(),
      sectors_checked: z.number().int().nonnegative(),
      sectors_zeroed: z.number().int().nonnegative(),
      sectors_failed: z.number().int().nonnegative(),
      sectors_unreadable: z.number().int().nonnegative(),
      result: z.literal('fail'),
      note: z.string().optional(),
    }),
    z.object({
      method: z.literal('sector_sampling'),
      sample_count: z.number().int().nonnegative(),
      sectors_checked: z.number().int().nonnegative(),
      sectors_zeroed: z.number().int().nonnegative(),
      sectors_failed: z.number().int().nonnegative(),
      sectors_unreadable: z.number().int().nonnegative(),
      result: z.literal('pass_crypto_erase'),
      note: z.string().optional(),
    }),
    z.object({
      method: z.literal('sector_sampling'),
      sample_count: z.number().int().nonnegative(),
      sectors_checked: z.number().int().nonnegative(),
      sectors_zeroed: z.number().int().nonnegative(),
      sectors_failed: z.number().int().nonnegative(),
      sectors_unreadable: z.number().int().nonnegative(),
      result: z.literal('skipped'),
      note: z.string().optional(),
    }),
    z.object({
      result: z.literal('not_validated'),
    }),
  ])
  .describe(
    'Per-disk verification outcome. `not_validated` = no sampling ran (e.g. pure crypto-erase on a skipped disk).',
  );
export type VerificationResult = z.infer<typeof VerificationResult>;

export const DiskReport = z.object({
  name: z.string().describe('Device name without /dev/ prefix.'),
  device_path: z.string().describe('Full device path, e.g. /dev/sda.'),
  media_type: z.enum(['NVMe', 'SSD', 'HDD']).describe('Media type in the canonical upper-cased report form.'),
  model: z.string().nullable(),
  serial: z.string().nullable(),
  wwn: z.string().nullable(),
  transport: z.string().nullable().describe('Transport string from lsblk (sata/nvme/usb/...); null when unknown.'),
  size_bytes: z.number().int().nonnegative(),
  size_human: z.string().describe("Human-readable size, e.g. '1.8 TB'."),
  rotational: z.boolean(),
  sanitization_method: z
    .enum(['purge', 'clear', 'best-effort', 'none', 'unknown'])
    .describe('NIST classification of the technique used.'),
  sanitization_technique: z
    .string()
    .describe("Exact Python technique string, e.g. 'NVMe Sanitize Block Erase (Purge)'."),
  result: z
    .enum(['pass', 'fail', 'pass_crypto_erase'])
    .describe('Per-disk verdict rolled up from the verification outcome.'),
  verification: VerificationResult,
  wipe_error: z
    .object({
      message: z.string().describe('Error message captured when the wipeDisk call threw.'),
      stderr: z.string().optional().describe('Subprocess stderr excerpt when the failure surfaced one.'),
    })
    .nullable()
    .optional()
    .describe(
      'Diagnostic capture when the per-disk wipe call threw — populated only when result is "fail" and the wipeDisk handler raised. Operators should look here before re-running the wipe.',
    ),
});
export type DiskReport = z.infer<typeof DiskReport>;

export const PreservedReport = z.object({
  name: z.string(),
  device_path: z.string(),
  media_type: z.enum(['NVMe', 'SSD', 'HDD']),
  model: z.string().nullable(),
  serial: z.string().nullable(),
  wwn: z.string().nullable(),
  size_bytes: z.number().int().nonnegative(),
  reason: z
    .string()
    .describe("Why the disk was preserved, e.g. 'layout.wipe=false' or 'LUKS detected; skip per policy'."),
});
export type PreservedReport = z.infer<typeof PreservedReport>;

export const SkippedReport = z.object({
  name: z.string(),
  reason: z
    .string()
    .describe('Why the disk was skipped — typically a preservation rule triggered by a holder dependency.'),
});
export type SkippedReport = z.infer<typeof SkippedReport>;

export const SanitizationReport = z.object({
  version: z.literal('1.0').describe('Report schema version; bumped if/when the shape changes.'),
  standards_reference: z
    .array(z.string())
    .describe("Standards references the report conforms to, e.g. ['NIST SP 800-88 Rev.2', 'IEEE 2883-2022']."),
  job_id: z.string().describe('Saga job id the wipe was part of; used as the audit trail correlator.'),
  mode: z
    .enum(['selective', 'full'])
    .describe("'full' wiped every disk; 'selective' only wiped layouts with wipe=true."),
  started_at: z.string().describe('ISO 8601 timestamp at the start of the wipe.'),
  completed_at: z.string().describe('ISO 8601 timestamp at the end of the wipe.'),
  duration_seconds: z.number().int().nonnegative().describe('Wall-clock duration of the full wipe pass.'),
  overall_result: z
    .enum(['pass', 'fail'])
    .describe('Aggregate verdict. Any disk with result=fail pulls the overall to fail.'),
  tool: z.object({
    name: z.string().describe('Tool identifier, e.g. `brokkr-bridge`.'),
    version: z.string().describe('Tool version — agent compile-time constant.'),
  }),
  holder_teardown: teardownHolders.output,
  disks: z.array(DiskReport).describe('Per-disk wipe result.'),
  preserved_disks: z.array(PreservedReport).describe('Disks that were preserved, with reason.'),
  skipped_disks: z.array(SkippedReport).describe('Disks skipped during teardown/wipe, with reason.'),
});
export type SanitizationReport = z.infer<typeof SanitizationReport>;

const tolerantWipeReportShape = Object.fromEntries(
  Object.entries(SanitizationReport.partial().shape).map(([key, schema]) => [
    key,
    (schema as z.ZodTypeAny).catch(undefined),
  ]),
);
export const WipeReport = z.preprocess(
  (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : { mode: 'full' }),
  z
    .object(tolerantWipeReportShape)
    .extend({ mode: z.enum(['selective', 'full']).catch('full').default('full') })
    .passthrough(),
);
export type WipeReport = z.infer<typeof WipeReport>;

export const OptimalOsDisk = z.object({
  name: z.string().describe('Device name.'),
  size: z.number().int().nonnegative().nullable().describe('Device size in bytes; nullable for tier-preference miss.'),
  type: z.enum(['nvme', 'ssd', 'hdd']).describe('Media tier the pick came from.'),
});
export type OptimalOsDisk = z.infer<typeof OptimalOsDisk>;

export const wipeDisks = {
  input: z.object({
    disk_layouts: z
      .array(DiskLayout)
      .nullable()
      .default(null)
      .describe('null = full wipe (every disk). Non-null = selective wipe (only layouts with wipe=true).'),
    environment: Environment.describe('Wipe-mode toggle; see Environment.'),
    full_wipe: z
      .boolean()
      .default(false)
      .describe(
        'Provision-lifecycle override: force a full (all-disks) wipe regardless of disk_layouts. ' +
          "PROVISION sanitizes EVERY physical disk so a fresh tenant never inherits a prior tenant's " +
          'residual data on secondary/non-enumerated disks; layouts still drive curtin downstream.',
      ),
    job_id: z.string().default('').describe('Saga job_id; surfaced in the report so audit logs can correlate.'),
  }),
  output: z.object({
    sanitization_report: WipeReport.describe('Best-effort wipe telemetry; tolerant of null/missing shape.'),
    optimal_os_disk: OptimalOsDisk.nullable().describe(
      'Best OS-disk pick, if any candidate is suitable; null otherwise.',
    ),
  }),
} as const;

export const prepareStorage = {
  input: z.object({
    disk_layouts: z.array(DiskLayout).describe('Full disk layout set for the device.'),
    target_path: TargetPath.default('/target'),
    curtin_yaml: z.string().describe("Pre-built curtin YAML from the bridge's CurtinService."),
  }),
  output: z.object({
    architecture: z.string().describe('Architecture string from `uname -m`.'),
    uefi: z.boolean().describe('UEFI-mode detection.'),
    fstab: z.string().describe('Final /etc/fstab content combining curtin output + preserved-disk injections.'),
    crypttab: z.string().describe('Final /etc/crypttab content; empty when there are no encrypted volumes.'),
    preserved_encrypted_volumes: z
      .array(EncryptedVolume)
      .describe('LUKS volumes detected on preserved disks; bridge passes these to LUKS script rendering.'),
    resolved_layouts: z
      .array(ResolvedDiskLayout)
      .describe('Layouts with identifiers resolved to concrete device names.'),
  }),
} as const;

export const operations = {
  discoverDisks,
  resolveDisks,
  detectUefiMode,
  detectExistingVolumeGroups,
  detectExistingRaidArrays,
  detectRaidControllers,
  detectPreservedDiskInfo,
  unmountDisks,
  wipeDisk,
  clearGpt,
  teardownHolders,
  writeValidationMarkers,
  validateWipe,
  applyStorageLayout,
  wipeDisks,
  prepareStorage,
} as const;
