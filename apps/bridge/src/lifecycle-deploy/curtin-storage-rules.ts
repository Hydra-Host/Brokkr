export const ENCRYPT_RESTRICTED_MOUNTPOINTS: ReadonlySet<string> = new Set(['/', '/home', '/tmp', '/usr', '/var']);

export function isEncryptRestrictedMountpoint(mountpoint: string | null | undefined): boolean {
  if (!mountpoint) return false;
  return ENCRYPT_RESTRICTED_MOUNTPOINTS.has(mountpoint);
}
