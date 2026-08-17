import { Injectable } from '@nestjs/common';
import type { CollectorHandler, DeviceMutation, StorageDriveUpsert } from '../collector.types';
import { type GhwBlockInput, ghwBlockDiskSchema, ghwBlockSchema } from './ghw_block.schema';

const IGNORED_PREFIXES = ['loop', 'sr', 'dm-', 'md', 'zram'];

// model/serial/wwn are omitted (not nulled) when hardwareString() normalises them to null: bundle iteration order is not guaranteed, so a null here could clobber real lsblk values.
@Injectable()
export class GhwBlockHandler implements CollectorHandler<GhwBlockInput> {
  readonly name = 'ghw_block' as const;
  readonly schema = ghwBlockSchema;

  async handle(input: GhwBlockInput): Promise<DeviceMutation> {
    const drives: StorageDriveUpsert[] = [];
    const warnings: string[] = [];

    input.block.disks.forEach((raw, idx) => {
      const parsed = ghwBlockDiskSchema.safeParse(raw);
      if (!parsed.success) {
        warnings.push(`ghw_block.disks[${idx}] malformed`);
        return;
      }
      const disk = parsed.data;
      if (shouldIgnore(disk.name)) return;

      const upsert: StorageDriveUpsert = {
        name: disk.name,
        type: classifyDriveType(disk.name, disk.drive_type),
        sizeBytes: BigInt(disk.size_bytes),
        physicalBlockBytes: disk.physical_block_size_bytes ?? null,
        busPath: disk.bus_path,
        storageController: disk.storage_controller,
      };
      if (disk.model !== null) upsert.model = disk.model;
      if (disk.serial_number !== null) upsert.serial = disk.serial_number;
      if (disk.wwn !== null) upsert.wwn = disk.wwn;
      drives.push(upsert);
    });

    return {
      upserts: drives.length ? { storageDrives: drives } : undefined,
      warnings: warnings.length ? warnings : undefined,
    };
  }
}

function shouldIgnore(name: string): boolean {
  return IGNORED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function classifyDriveType(name: string, driveType: string | undefined): StorageDriveUpsert['type'] {
  if (name.startsWith('nvme')) return 'NVME';
  if (driveType?.toLowerCase() === 'hdd') return 'HDD';
  return 'SSD';
}
