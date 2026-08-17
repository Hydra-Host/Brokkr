import type { OperationInput, OperationOutput } from '@repo/bridge-agent-protocol';
import { z } from 'zod';

import { registerOperation } from '../../dispatch/registry';
import { getErrorMessage } from '../../errors';
import { run } from '../../exec';

type DiskLayout = OperationInput<'storage.resolveDisks'>['disk_layouts'][number];
type ResolvedDiskLayout = OperationOutput<'storage.resolveDisks'>['layouts'][number];

export interface LsblkDisk {
  name: string;
  serial: string | null;
  wwn: string | null;
  size: number;
}

const ResolveLsblkDevice = z.object({
  name: z.string().optional(),
  serial: z.string().nullable().optional(),
  wwn: z.string().nullable().optional(),
  size: z.number().optional(),
});

const ResolveLsblkOutput = z.object({
  blockdevices: z.array(ResolveLsblkDevice).optional(),
});

async function listDisksWithIds(): Promise<LsblkDisk[]> {
  const { stdout, exit_code, stderr } = await run('lsblk', ['-d', '-J', '-b', '-o', 'NAME,SERIAL,WWN,SIZE'], {
    timeout_ms: 30_000,
  });
  if (exit_code !== 0) {
    throw new Error(`lsblk failed (exit=${exit_code}): ${stderr.trim()}`);
  }

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`lsblk emitted non-JSON output: ${getErrorMessage(error)}`);
  }
  const parsed = ResolveLsblkOutput.parse(rawJson);

  return (parsed.blockdevices ?? []).map((d) => ({
    name: d.name ?? '',
    serial: d.serial ?? null,
    wwn: d.wwn ?? null,
    size: d.size ?? 0,
  }));
}

// `size_bytes` is the smallest resolved member, not the first: RAID/LVM partition geometry must fit every disk, or a larger first disk overflows a smaller member at deploy time.
export function resolveDiskLayouts(diskLayouts: DiskLayout[], allDisks: LsblkDisk[]): ResolvedDiskLayout[] {
  return diskLayouts
    .filter((l) => l.disks.length > 0)
    .map((layout) => {
      const resolved: string[] = [];
      for (const identifier of layout.disks) {
        for (const disk of allDisks) {
          if (disk.name === identifier || disk.serial === identifier || disk.wwn === identifier) {
            if (!resolved.includes(disk.name)) resolved.push(disk.name);
          }
        }
      }
      if (resolved.length === 0) {
        throw new Error(`could not resolve disk identifiers to device names: ${JSON.stringify(layout.disks)}`);
      }
      const size_bytes = Math.min(...resolved.map((name) => allDisks.find((d) => d.name === name)?.size ?? 0));
      return {
        disks: resolved,
        size_bytes,
        wipe: layout.wipe,
        mountpoint: layout.mountpoint,
        fs_type: layout.fs_type,
      };
    });
}

export function registerDiskResolver(): void {
  registerOperation('storage.resolveDisks', async ({ disk_layouts }) => {
    const allDisks = await listDisksWithIds();
    return { layouts: resolveDiskLayouts(disk_layouts, allDisks) };
  });
}
