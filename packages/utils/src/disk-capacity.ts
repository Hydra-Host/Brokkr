export const GPT_SECONDARY_HEADER_BYTES = 16385;
export const GPT_TAIL_SLACK_BYTES = 5242880;

export const UEFI_EFI_OFFSET = 1048576;
export const UEFI_EFI_SIZE = 1127219200;
export const UEFI_ROOT_OFFSET = UEFI_EFI_OFFSET + UEFI_EFI_SIZE;

export const LEGACY_BIOS_OFFSET = 1048576;
export const LEGACY_BIOS_SIZE = 1048576;
export const LEGACY_BOOT_OFFSET = 2097152;
export const LEGACY_BOOT_SIZE = 2147483648;
export const LEGACY_ROOT_OFFSET = LEGACY_BOOT_OFFSET + LEGACY_BOOT_SIZE;

export const DATA_PARTITION_OFFSET = 1048576;

export const ROOT_SIZE_MIN_BYTES = 8589934592;
export const DATA_SIZE_MIN_BYTES = 1073741824;

export const ROOT_PARTITION_OVERHEAD_BYTES = BigInt(
  LEGACY_BOOT_OFFSET + LEGACY_BOOT_SIZE + GPT_SECONDARY_HEADER_BYTES + GPT_TAIL_SLACK_BYTES,
);
export const DATA_PARTITION_OVERHEAD_BYTES = BigInt(
  DATA_PARTITION_OFFSET + GPT_SECONDARY_HEADER_BYTES + GPT_TAIL_SLACK_BYTES,
);

function dataStripes(config: string, diskCount: number): number {
  switch (config) {
    case 'lvm':
    case 'raid0':
      return diskCount;
    case 'raid5':
      return diskCount - 1;
    case 'raid6':
    case 'raid50':
      return diskCount - 2;
    case 'raid10':
      return Math.floor(diskCount / 2);
    case 'raid60':
      return diskCount - 4;
    default:
      return 1;
  }
}

export function raidDataMultiplier(config: string, diskCount: number): number {
  return Math.max(1, dataStripes(config, diskCount));
}

export function raidUsableCapacityBytes(config: string, diskCount: number, perDiskBytes: bigint): bigint {
  return perDiskBytes * BigInt(raidDataMultiplier(config, diskCount));
}

export function perDiskBytesForUsable(config: string, diskCount: number, usableBytes: bigint): bigint {
  const k = BigInt(raidDataMultiplier(config, diskCount));
  return (usableBytes + k - 1n) / k;
}
