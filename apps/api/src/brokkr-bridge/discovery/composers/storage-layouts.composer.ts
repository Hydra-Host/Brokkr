import { Injectable } from '@nestjs/common';
import type { Prisma } from '@repo/database';
import { convertSize } from '@repo/utils';
import {
  isSsd,
  type DefaultDiskLayout,
  type DiskGroupAssignment,
  type DiskLayoutConfig,
  type StorageLayoutData,
} from '../../types/discovery-processors.types';
import type { CollectorContext, DeviceMutation } from '../collectors/collector.types';
import { ghwBaseboardSchema } from '../collectors/ghw_baseboard/ghw_baseboard.schema';
import { lsblkSchema } from '../collectors/lsblk/lsblk.schema';
import type { Composer } from './composer.types';

@Injectable()
export class StorageLayoutsComposer implements Composer {
  readonly name = 'storage-layouts';

  async compose(ctx: CollectorContext): Promise<DeviceMutation> {
    const lsblk = lsblkSchema.safeParse(ctx.rawBundle.lsblk);
    if (!lsblk.success) return {};

    const baseboard = ghwBaseboardSchema.safeParse(ctx.rawBundle.ghw_baseboard);
    const baseboardProduct = baseboard.success ? (baseboard.data.baseboard.product ?? '') : '';
    const isAsrockRome = baseboardProduct.toLowerCase().includes('rome');

    const data = checkDiskConfiguration(lsblk.data, isAsrockRome);
    return { serverUpdate: { storageLayouts: data as unknown as Prisma.InputJsonValue } };
  }
}

function checkDiskConfiguration(lsblk: unknown[], isAsrockRome: boolean): StorageLayoutData {
  const diskGroups: Record<string, Record<number, Record<string, unknown>[]>> = {};

  const NATURAL_COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

  for (const raw of lsblk) {
    if (!raw || typeof raw !== 'object') continue;
    const disk = raw as Record<string, unknown>;
    const diskSize = Number(disk.size ?? 0);
    const serialStr = String(disk.serial ?? '').toLowerCase();
    if (diskSize <= 0 || serialStr.includes('virtual')) continue;

    const name = String(disk.name ?? '');
    let diskType: string;
    if (name.includes('nvme')) diskType = 'nvme';
    else if (isSsd(disk.rota)) diskType = 'ssd';
    else diskType = 'hdd';

    diskGroups[diskType] ??= {};
    diskGroups[diskType][diskSize] ??= [];

    const { rota: __, ...cleanDisk } = disk;
    diskGroups[diskType][diskSize].push(cleanDisk);
  }

  const configs: DiskLayoutConfig[] = [];

  for (const [diskType, sizes] of Object.entries(diskGroups)) {
    for (const [sizeStr, groupedDisks] of Object.entries(sizes)) {
      const size = Number(sizeStr);
      if (size <= 0) continue;

      const knownModels = new Set(
        groupedDisks
          .map((d) =>
            String(d.model ?? '')
              .trim()
              .toLowerCase(),
          )
          .filter(Boolean),
      );
      const modelUniform = knownModels.size <= 1;

      const capabilities = buildCapabilitiesList(groupedDisks.length, modelUniform);
      const sizeGb = Math.floor(convertSize(size));

      let availableFileSystems = ['ext4'];
      if (!isAsrockRome) availableFileSystems.push('xfs');
      if ((sizeGb > 4768 || groupedDisks.length > 8) && !isAsrockRome) {
        availableFileSystems = availableFileSystems.filter((fs) => fs !== 'ext4');
      }

      const disksInGroup = [...groupedDisks]
        .sort((a, b) => NATURAL_COLLATOR.compare(String(a.name ?? ''), String(b.name ?? '')))
        .map((d) => {
          const { size: _s, model: _m, ...rest } = d;
          return rest;
        });

      configs.push({
        disk_group_name: `${diskType.toUpperCase()}_${sizeGb}GB`,
        disk_type: diskType,
        disks: disksInGroup,
        capabilities,
        size_per_disk: size,
        file_systems: availableFileSystems,
        num_disks: disksInGroup.length,
      });
    }
  }

  return { configs, default: defaultDiskLayout(diskGroups) };
}

function buildCapabilitiesList(numDisks: number, modelUniform: boolean): string[] {
  const caps: string[] = [];
  if (numDisks > 0) caps.push('direct', 'lvm');
  if (modelUniform) {
    if (numDisks >= 2) {
      caps.push('raid0');
      if (numDisks % 2 === 0) caps.push('raid1');
    }
    if (numDisks >= 3) caps.push('raid5');
    if (numDisks >= 4) {
      caps.push('raid6');
      if (numDisks % 2 === 0) caps.push('raid10');
    }
    if (numDisks >= 6) caps.push('raid50');
    if (numDisks >= 8) caps.push('raid60');
  }
  caps.sort();
  return caps;
}

function defaultDiskLayout(diskGroups: Record<string, Record<number, Record<string, unknown>[]>>): DefaultDiskLayout {
  let osDiskGroup: DiskGroupAssignment | null = null;
  const dataDiskGroups: DiskGroupAssignment[] = [];
  const coldStorageDiskGroups: DiskGroupAssignment[] = [];

  if (diskGroups.nvme || diskGroups.ssd) {
    const ssdNvmeGroup: Record<number, { type: string }> = {};

    for (const size of Object.keys(diskGroups.nvme ?? {})) ssdNvmeGroup[Number(size)] = { type: 'nvme' };
    for (const size of Object.keys(diskGroups.ssd ?? {})) ssdNvmeGroup[Number(size)] = { type: 'ssd' };

    const sortedSizes = Object.keys(ssdNvmeGroup)
      .map(Number)
      .sort((a, b) => a - b);

    if (sortedSizes.length > 0) {
      const smallest = sortedSizes[0]!;
      const label = ssdNvmeGroup[smallest]!.type === 'nvme' ? 'NVME' : 'SSD';
      osDiskGroup = {
        config: 'lvm',
        file_system: 'ext4',
        group: `${label}_${Math.floor(convertSize(smallest))}GB`,
        mountpoint: '/',
      };

      for (const size of sortedSizes.slice(1)) {
        const typeLabel = ssdNvmeGroup[size]!.type === 'nvme' ? 'NVME' : 'SSD';
        dataDiskGroups.push({
          config: 'lvm',
          file_system: 'ext4',
          group: `${typeLabel}_${Math.floor(convertSize(size))}GB`,
          mountpoint: `/data${dataDiskGroups.length}`,
        });
      }
    }
  }

  let hddUsedForOs: number | null = null;
  if (!osDiskGroup && diskGroups.hdd) {
    const sortedHddSizes = Object.keys(diskGroups.hdd)
      .map(Number)
      .sort((a, b) => a - b);
    hddUsedForOs = sortedHddSizes[0]!;
    osDiskGroup = {
      config: 'lvm',
      file_system: 'ext4',
      group: `HDD_${Math.floor(convertSize(hddUsedForOs))}GB`,
      mountpoint: '/',
    };
  }

  if (diskGroups.hdd) {
    const sortedHddSizes = Object.keys(diskGroups.hdd)
      .map(Number)
      .sort((a, b) => a - b);

    for (const size of sortedHddSizes) {
      if (size !== hddUsedForOs) {
        dataDiskGroups.push({
          config: 'lvm',
          file_system: 'ext4',
          group: `HDD_${Math.floor(convertSize(size))}GB`,
          mountpoint: `/data${dataDiskGroups.length}`,
        });
      }
    }

    for (const size of sortedHddSizes) {
      if (size !== hddUsedForOs) {
        coldStorageDiskGroups.push({
          config: 'lvm',
          file_system: 'ext4',
          group: `HDD_${Math.floor(convertSize(size))}GB`,
          mountpoint: `/cold${coldStorageDiskGroups.length}`,
        });
      }
    }
  }

  return {
    os_disks_group: osDiskGroup,
    data_disks_groups: dataDiskGroups,
    cold_storage_disks_groups: coldStorageDiskGroups,
  };
}
