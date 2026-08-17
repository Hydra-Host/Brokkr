import type { z } from 'zod';

export const ENCRYPT_RESTRICTED_MOUNTPOINTS = ['/', '/home', '/tmp', '/usr', '/var'] as const;

interface DiskLayoutEntry {
  mountpoint: string;
  encrypt?: boolean;
  wipe?: boolean;
  disks?: string[];
  config?: string;
}

const RAID_MIN_DISKS: Record<string, number> = {
  raid0: 2,
  raid1: 2,
  raid5: 3,
  raid6: 4,
  raid10: 4,
  raid50: 6,
  raid60: 8,
};

const RAID_EVEN_REQUIRED = new Set(['raid1', 'raid10']);

export function validateRaidDiskCount(config: string | undefined, diskCount: number): string | null {
  if (!config || !config.startsWith('raid')) return null;
  const min = RAID_MIN_DISKS[config];
  if (min === undefined) return null;
  if (diskCount < min) {
    return `RAID level "${config}" requires at least ${min} disks; got ${diskCount}`;
  }
  if (RAID_EVEN_REQUIRED.has(config) && diskCount % 2 !== 0) {
    return `RAID level "${config}" requires an even number of disks; got ${diskCount}`;
  }
  return null;
}

export function validateDiskLayoutEncryption(
  diskLayouts: DiskLayoutEntry[],
  ctx: z.RefinementCtx,
  mode: 'provision' | 'reprovision',
): void {
  // In `direct` mode the submission collapses to one row at "/" (see applyDirectModeToSubmission) — validating raw form rows would flag rows that never reach the API.
  const directIndex = diskLayouts.findIndex((l) => l.config === 'direct');
  const effective: { layout: DiskLayoutEntry; index: number }[] =
    directIndex >= 0
      ? [{ layout: { ...diskLayouts[directIndex], mountpoint: '/' }, index: directIndex }]
      : diskLayouts.map((layout, index) => ({ layout, index }));

  effective.forEach(({ layout, index }) => {
    if (layout.encrypt && (ENCRYPT_RESTRICTED_MOUNTPOINTS as readonly string[]).includes(layout.mountpoint)) {
      ctx.addIssue({
        code: 'custom',
        message: `Encryption is not supported on system mountpoint "${layout.mountpoint}"`,
        path: ['diskLayouts', index, 'encrypt'],
      });
    }

    if (mode === 'reprovision' && layout.encrypt && layout.wipe === false) {
      ctx.addIssue({
        code: 'custom',
        message: 'Cannot encrypt a preserved disk group \u2014 encryption requires a fresh format',
        path: ['diskLayouts', index, 'encrypt'],
      });
    }

    if (mode === 'provision' && layout.wipe === false) {
      ctx.addIssue({
        code: 'custom',
        message: 'Disk preservation is only available during reprovision \u2014 fresh provisions must wipe all disks',
        path: ['diskLayouts', index, 'wipe'],
      });
    }

    if (mode === 'reprovision' && layout.mountpoint === '/' && layout.wipe === false) {
      ctx.addIssue({
        code: 'custom',
        message: 'Cannot preserve the root "/" disk group \u2014 the OS/root must be wiped to rebuild EFI/root',
        path: ['diskLayouts', index, 'wipe'],
      });
    }

    const raidViolation = validateRaidDiskCount(layout.config, (layout.disks ?? []).length);
    if (raidViolation) {
      ctx.addIssue({ code: 'custom', message: raidViolation, path: ['diskLayouts', index, 'disks'] });
    }
  });

  const seen = new Set<string>();
  for (const { layout, index } of effective) {
    (layout.disks ?? []).forEach((disk, diskIndex) => {
      if (seen.has(disk)) {
        ctx.addIssue({
          code: 'custom',
          message: `Disk "${disk}" appears in more than one disk group; each disk may belong to exactly one group`,
          path: ['diskLayouts', index, 'disks', diskIndex],
        });
      }
      seen.add(disk);
    });
  }
}
