import { Prisma, StorageDriveType } from '@repo/database';
import { convertSize, MIB_PER_GIB } from '@repo/utils';

export type HardwareSummary = {
  cpuModel: string | null;
  cpuPhysicalCount: number | null;
  cpuCoreCount: number | null;
  cpuThreadCount: number | null;
  architecture: string | null;
  memoryGb: number | null;
  gpuModel: string | null;
  gpuCount: number | null;
  nvmeSize: number | null;
  nvmeCount: number | null;
  ssdSize: number | null;
  ssdCount: number | null;
  hddSize: number | null;
  hddCount: number | null;
};

type CpuInput = {
  model: string;
  architecture: string | null;
  coreCount: number | null;
  threadCount: number | null;
};
type GpuInput = { model: string };
type StorageInput = { type: StorageDriveType; sizeBytes: bigint };
type MemoryInput = { totalSizeMb: number };

export type HardwareSummaryInput = {
  cpus: readonly CpuInput[];
  gpus: readonly GpuInput[];
  storageDrives: readonly StorageInput[];
  memoryConfig: MemoryInput | null;
};

export const hardwareSummaryInclude = {
  cpus: { orderBy: { socketIndex: 'asc' as const } },
  gpus: { orderBy: { index: 'asc' as const } },
  storageDrives: { orderBy: { name: 'asc' as const } },
  memoryConfig: true,
} satisfies Prisma.DeviceInclude;

export function projectHardwareSummary(input: HardwareSummaryInput): HardwareSummary {
  return {
    ...projectCpu(input.cpus),
    memoryGb: input.memoryConfig != null ? Math.round(input.memoryConfig.totalSizeMb / MIB_PER_GIB) : null,
    ...projectGpu(input.gpus),
    ...projectStorage(input.storageDrives),
  };
}

function projectCpu(
  cpus: readonly CpuInput[],
): Pick<HardwareSummary, 'cpuModel' | 'cpuPhysicalCount' | 'cpuCoreCount' | 'cpuThreadCount' | 'architecture'> {
  if (cpus.length === 0) {
    return {
      cpuModel: null,
      cpuPhysicalCount: null,
      cpuCoreCount: null,
      cpuThreadCount: null,
      architecture: null,
    };
  }
  return {
    cpuModel: cpus[0].model,
    cpuPhysicalCount: cpus.length,
    cpuCoreCount: sumNullable(cpus, (c) => c.coreCount),
    cpuThreadCount: sumNullable(cpus, (c) => c.threadCount),
    architecture: cpus[0].architecture,
  };
}

function projectGpu(gpus: readonly GpuInput[]): Pick<HardwareSummary, 'gpuModel' | 'gpuCount'> {
  if (gpus.length === 0) {
    return { gpuModel: null, gpuCount: null };
  }
  return {
    gpuModel: gpus[0].model,
    gpuCount: gpus.length,
  };
}

function projectStorage(
  drives: readonly StorageInput[],
): Pick<HardwareSummary, 'nvmeSize' | 'nvmeCount' | 'ssdSize' | 'ssdCount' | 'hddSize' | 'hddCount'> {
  if (drives.length === 0) {
    return {
      nvmeSize: null,
      nvmeCount: null,
      ssdSize: null,
      ssdCount: null,
      hddSize: null,
      hddCount: null,
    };
  }
  return {
    nvmeSize: sumSizeGb(drives, StorageDriveType.NVME),
    nvmeCount: countByType(drives, StorageDriveType.NVME),
    ssdSize: sumSizeGb(drives, StorageDriveType.SSD),
    ssdCount: countByType(drives, StorageDriveType.SSD),
    hddSize: sumSizeGb(drives, StorageDriveType.HDD),
    hddCount: countByType(drives, StorageDriveType.HDD),
  };
}

/** Sums GiB (fixed unit for the Int column); rounds per drive so totals match per-drive display. */
function sumSizeGb(drives: readonly StorageInput[], type: StorageDriveType): number {
  let total = 0;
  for (const d of drives) {
    if (d.type === type) {
      total += Math.round(convertSize(d.sizeBytes));
    }
  }
  return total;
}

function countByType(drives: readonly StorageInput[], type: StorageDriveType): number {
  let count = 0;
  for (const d of drives) {
    if (d.type === type) count += 1;
  }
  return count;
}

function sumNullable<T>(items: readonly T[], pick: (item: T) => number | null): number | null {
  let total = 0;
  let anyNumber = false;
  for (const item of items) {
    const v = pick(item);
    if (v !== null) {
      total += v;
      anyNumber = true;
    }
  }
  return anyNumber ? total : null;
}
