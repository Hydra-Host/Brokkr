import { Injectable } from '@nestjs/common';
import type { CollectorHandler, DeviceMutation, MemoryConfigUpsert } from '../collector.types';
import { type DmidecodeMemoryInput, dmidecodeMemorySchema, dmidecodeRecordSchema } from './dmidecode_memory.schema';

const TYPE_PHYSICAL_ARRAY = 16;
const TYPE_MEMORY_DEVICE = 17;

@Injectable()
export class DmidecodeMemoryHandler implements CollectorHandler<DmidecodeMemoryInput> {
  readonly name = 'dmidecode_memory' as const;
  readonly schema = dmidecodeMemorySchema;

  async handle(input: DmidecodeMemoryInput): Promise<DeviceMutation> {
    const warnings: string[] = [];
    const devices: Record<string, unknown>[] = [];
    let totalSlotsFromArrays = 0;
    let eccString: string | undefined;

    input.forEach((raw, idx) => {
      const parsed = dmidecodeRecordSchema.safeParse(raw);
      if (!parsed.success) {
        warnings.push(`dmidecode_memory[${idx}] malformed`);
        return;
      }
      const { type, values } = parsed.data;
      if (type === TYPE_PHYSICAL_ARRAY) {
        totalSlotsFromArrays += parseInt((values.number_of_devices as string | undefined) ?? '0', 10) || 0;
        eccString ??= values.error_correction_type as string | undefined;
      } else if (type === TYPE_MEMORY_DEVICE) {
        devices.push(values);
      }
    });

    const populated = devices.filter((d) => isPopulated(d.size as string | undefined));
    const dimmSizeMb = uniformSizeMb(populated);
    const dimmType = uniformDimmType(populated);
    const dimmSpeed = uniformStringField(populated, 'speed');
    const configuredSpeed = uniformStringField(populated, 'configured_memory_speed');

    const sizesMb = populated.map((d) => parseSizeToMb(d.size as string | undefined) ?? 0);
    const totalSizeMb = sizesMb.reduce((a, b) => a + b, 0);

    const memoryConfig: MemoryConfigUpsert = {
      totalSizeMb,
      populatedDimms: populated.length,
      totalSlots: totalSlotsFromArrays || devices.length,
      dimmSizeMb,
      dimmType,
      dimmSpeed,
      configuredSpeed,
      eccType: mapEccType(eccString),
      configSummary:
        populated.length && dimmSizeMb && dimmType
          ? `${populated.length}x${dimmSizeMb / 1024}GB ${dimmType} ${configuredSpeed ?? dimmSpeed ?? ''}`.trim()
          : null,
    };

    return {
      upserts: { memoryConfig },
      warnings: warnings.length ? warnings : undefined,
    };
  }
}

function isPopulated(size: string | undefined): boolean {
  if (!size) return false;
  const s = size.toLowerCase();
  if (s.includes('no module installed') || s.includes('not installed') || s === '0 mb' || s === '0 gb') {
    return false;
  }
  return true;
}

function parseSizeToMb(size: string | undefined): number | null {
  if (!size) return null;
  const match = size.match(/^([\d,]+)\s*(MB|GB|TB)$/i);
  if (!match) return null;
  const n = parseInt(match[1].replace(/,/g, ''), 10);
  if (Number.isNaN(n)) return null;
  const unit = match[2].toUpperCase();
  if (unit === 'MB') return n;
  if (unit === 'GB') return n * 1024;
  return n * 1024 * 1024;
}

function uniformSizeMb(devices: Record<string, unknown>[]): number | null {
  const sizes = new Set(devices.map((d) => parseSizeToMb(d.size as string | undefined)));
  if (sizes.size === 1) return [...sizes][0];
  return null;
}

function uniformStringField(devices: Record<string, unknown>[], key: string): string | null {
  const values = new Set(devices.map((d) => (d[key] as string | undefined) ?? null));
  values.delete(null);
  if (values.size === 1) return [...values][0] as string;
  return null;
}

function uniformDimmType(devices: Record<string, unknown>[]): MemoryConfigUpsert['dimmType'] | null {
  const raw = uniformStringField(devices, 'type');
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (upper === 'DDR3') return 'DDR3';
  if (upper === 'DDR4') return 'DDR4';
  if (upper === 'DDR5') return 'DDR5';
  if (upper === 'LPDDR4') return 'LPDDR4';
  if (upper === 'LPDDR5') return 'LPDDR5';
  return null;
}

function mapEccType(raw: string | undefined): MemoryConfigUpsert['eccType'] | null {
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (s.includes('single-bit')) return 'SINGLE_BIT_ECC';
  if (s.includes('multi-bit')) return 'MULTI_BIT_ECC';
  if (s === 'none') return 'NONE';
  return null;
}
