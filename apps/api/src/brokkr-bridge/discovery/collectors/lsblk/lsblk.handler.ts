import { Injectable } from '@nestjs/common';
import type { CollectorHandler, DeviceMutation, StorageDriveUpsert } from '../collector.types';
import { type LsblkEntry, type LsblkInput, lsblkEntrySchema, lsblkSchema } from './lsblk.schema';

const IGNORED_PREFIXES = ['loop', 'sr', 'dm-', 'md', 'zram'];

@Injectable()
export class LsblkHandler implements CollectorHandler<LsblkInput> {
  readonly name = 'lsblk' as const;
  readonly schema = lsblkSchema;

  async handle(input: LsblkInput): Promise<DeviceMutation> {
    const drives: StorageDriveUpsert[] = [];
    const warnings: string[] = [];

    input.forEach((raw, idx) => {
      const parsed = lsblkEntrySchema.safeParse(raw);
      if (!parsed.success) {
        warnings.push(`lsblk[${idx}] failed to parse`);
        return;
      }
      const entry = parsed.data;
      if (shouldIgnore(entry.name)) return;
      drives.push({
        name: entry.name,
        type: classifyDriveType(entry),
        model: entry.model ?? null,
        serial: entry.serial ?? null,
        wwn: entry.wwn ?? null,
        sizeBytes: BigInt(entry.size),
      });
    });

    return {
      upserts: { storageDrives: drives },
      warnings: warnings.length ? warnings : undefined,
    };
  }
}

function shouldIgnore(name: string): boolean {
  return IGNORED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function classifyDriveType(entry: LsblkEntry): StorageDriveUpsert['type'] {
  if (entry.name.startsWith('nvme')) return 'NVME';
  return entry.rota ? 'HDD' : 'SSD';
}
