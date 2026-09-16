import { randomUUID } from 'node:crypto';

import { dump } from 'js-yaml';

import {
  DATA_PARTITION_OFFSET,
  GPT_SECONDARY_HEADER_BYTES,
  GPT_TAIL_SLACK_BYTES,
  LEGACY_BIOS_OFFSET,
  LEGACY_BIOS_SIZE,
  LEGACY_BOOT_OFFSET,
  LEGACY_BOOT_SIZE,
  LEGACY_ROOT_OFFSET,
  UEFI_EFI_OFFSET,
  UEFI_EFI_SIZE,
  UEFI_ROOT_OFFSET,
  perDiskBytesForUsable,
} from '@repo/utils';

import { isEncryptRestrictedMountpoint } from './curtin-storage-rules.js';

import { getLogger } from '../logger/logger.service';

const logDebug = (msg: string, ctx?: { jobId?: string }): void => void getLogger().debug(msg, ctx);
const logInfo = (msg: string, ctx?: { jobId?: string }): void => void getLogger().info(msg, ctx);
const logWarning = (msg: string, ctx?: { jobId?: string }): void => void getLogger().warning(msg, ctx);
const logError = (msg: string, ctx?: { jobId?: string }): void => void getLogger().error(msg, ctx);

export class CurtinServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CurtinServiceError';
  }
}

export class StorageConfigError extends CurtinServiceError {
  constructor(message: string) {
    super(message);
    this.name = 'StorageConfigError';
  }
}

export class StorageLayoutError extends CurtinServiceError {
  constructor(message: string) {
    super(message);
    this.name = 'StorageLayoutError';
  }
}

export function computeUefiPartitionGeometry(diskSize: number): Record<string, number>;
export function computeUefiPartitionGeometry(diskSize: bigint): Record<string, bigint>;
export function computeUefiPartitionGeometry(
  diskSize: number | bigint,
): Record<string, number> | Record<string, bigint> {
  if (typeof diskSize === 'bigint') {
    const rootSize =
      diskSize - BigInt(UEFI_ROOT_OFFSET) - BigInt(GPT_SECONDARY_HEADER_BYTES) - BigInt(GPT_TAIL_SLACK_BYTES);
    return {
      efi_offset: BigInt(UEFI_EFI_OFFSET),
      efi_size: BigInt(UEFI_EFI_SIZE),
      root_offset: BigInt(UEFI_ROOT_OFFSET),
      root_size: rootSize,
    };
  }
  const rootSize = diskSize - UEFI_ROOT_OFFSET - GPT_SECONDARY_HEADER_BYTES - GPT_TAIL_SLACK_BYTES;
  return {
    efi_offset: UEFI_EFI_OFFSET,
    efi_size: UEFI_EFI_SIZE,
    root_offset: UEFI_ROOT_OFFSET,
    root_size: rootSize,
  };
}

export function computeLegacyPartitionGeometry(diskSize: number): Record<string, number>;
export function computeLegacyPartitionGeometry(diskSize: bigint): Record<string, bigint>;
export function computeLegacyPartitionGeometry(
  diskSize: number | bigint,
): Record<string, number> | Record<string, bigint> {
  if (typeof diskSize === 'bigint') {
    const rootSize =
      diskSize -
      BigInt(LEGACY_BOOT_SIZE) -
      BigInt(LEGACY_BOOT_OFFSET) -
      BigInt(GPT_SECONDARY_HEADER_BYTES) -
      BigInt(GPT_TAIL_SLACK_BYTES);
    return {
      bios_offset: BigInt(LEGACY_BIOS_OFFSET),
      bios_size: BigInt(LEGACY_BIOS_SIZE),
      boot_offset: BigInt(LEGACY_BOOT_OFFSET),
      boot_size: BigInt(LEGACY_BOOT_SIZE),
      root_offset: BigInt(LEGACY_ROOT_OFFSET),
      root_size: rootSize,
    };
  }
  const rootSize = diskSize - LEGACY_BOOT_SIZE - LEGACY_BOOT_OFFSET - GPT_SECONDARY_HEADER_BYTES - GPT_TAIL_SLACK_BYTES;
  return {
    bios_offset: LEGACY_BIOS_OFFSET,
    bios_size: LEGACY_BIOS_SIZE,
    boot_offset: LEGACY_BOOT_OFFSET,
    boot_size: LEGACY_BOOT_SIZE,
    root_offset: LEGACY_ROOT_OFFSET,
    root_size: rootSize,
  };
}

export interface DiskGroupInit {
  disks: string[];
  config: string;
  format: string;
  mountpoint: string;
  diskSize?: number | string | null;
  size?: number | null;
  wipe?: boolean | null;
  encrypt?: boolean | null;
}

export class DiskGroup {
  disks: string[];
  config: string;
  format: string;
  mountpoint: string;
  diskSize: number | string | null;
  size: number | null;
  wipe: boolean;
  encrypt: boolean;

  constructor(init: DiskGroupInit) {
    this.disks = init.disks;
    this.config = init.config;
    this.format = init.format;
    this.mountpoint = init.mountpoint;
    this.diskSize = init.diskSize ?? null;
    this.size = init.size ?? null;
    const rawWipe = init.wipe === undefined ? true : init.wipe;
    const rawEncrypt = init.encrypt === undefined ? false : init.encrypt;

    if (this.disks.length === 0) {
      throw new StorageConfigError('Disk group must have at least one disk');
    }
    if (!this.config) {
      throw new StorageConfigError('Disk group must have a configuration type');
    }
    if (!this.format) {
      throw new StorageConfigError('Disk group must have a filesystem format');
    }
    if (!this.mountpoint) {
      throw new StorageConfigError('Disk group must have a mountpoint');
    }
    if (!!rawEncrypt && !rawWipe) {
      throw new StorageConfigError('Cannot encrypt a preserved disk group — encryption requires wipe=True');
    }
    if (this.size !== null && (!Number.isInteger(this.size) || this.size <= 0)) {
      throw new StorageConfigError('Disk group size must be a positive integer number of bytes');
    }
    if (this.size !== null && !!rawEncrypt) {
      throw new StorageConfigError('Cannot set a size on an encrypted disk group');
    }
    if (this.size !== null && !rawWipe) {
      throw new StorageConfigError('Cannot set a size on a preserved disk group');
    }
    this.wipe = !!rawWipe;
    this.encrypt = !!rawEncrypt;
  }
}

export interface StorageConfigInit {
  targetDir: string;
  diskGroups: DiskGroup[];
  jobId?: string;
  uefi?: boolean;
}

export class StorageConfig {
  targetDir: string;
  diskGroups: DiskGroup[];
  jobId: string;
  uefi: boolean;

  constructor(init: StorageConfigInit) {
    this.targetDir = init.targetDir;
    this.diskGroups = init.diskGroups;
    this.jobId = init.jobId ?? '';
    this.uefi = init.uefi ?? false;

    if (!this.targetDir) {
      throw new StorageConfigError('target_dir is required');
    }
    if (this.diskGroups.length === 0) {
      throw new StorageConfigError('At least one disk group is required');
    }

    const rootGroups = this.diskGroups.filter((g) => g.mountpoint === '/');
    if (rootGroups.length !== 1) {
      throw new StorageConfigError(
        `Exactly one disk group must have mountpoint '/' (got ${rootGroups.length}). ` +
          'Without an OS disk, curtin builds only data volumes — no EFI/root partition is created and grub-install will fail.',
      );
    }
  }
}

export class StorageCounters {
  partition = 0;
  format = 0;
  mount = 0;
  raid = 0;
  lvm = 0;
  lvmPartition = 0;
  dmCrypt = 0;
}

interface DiskConfigEntry {
  grub_device: boolean;
  id: string;
  path: string;
  preserve: boolean;
  type: string;
  ptable?: string;
}

interface PartitionConfigEntry {
  device: string;
  id: string;
  number: number;
  offset: number;
  size: number;
  type: string;
  preserve: boolean;
  wipe?: string;
  flag?: string;
  grub_device?: boolean;
}

interface FormatConfigEntry {
  fstype: string;
  id: string;
  preserve: boolean;
  type: string;
  volume: string;
  extra_options?: string[];
}

interface MountConfigEntry {
  device: string;
  id: string;
  path: string;
  type: string;
  options?: string;
}

interface RaidConfigEntry {
  devices: string[];
  id: string;
  name: string;
  raidlevel: string;
  type: string;
  preserve: boolean;
  wipe?: string;
}

interface LvmVolgroupEntry {
  devices: string[];
  id: string;
  name: string;
  type: string;
  preserve: boolean;
  wipe?: string;
}

interface LvmPartitionEntry {
  id: string;
  name: string;
  type: string;
  volgroup: string;
  preserve: boolean;
  wipe?: string;
}

interface DmCryptEntry {
  id: string;
  type: string;
  dm_name: string;
  volume: string;
  key: string;
  preserve: boolean;
}

export type CurtinStorageEntry =
  | DiskConfigEntry
  | PartitionConfigEntry
  | FormatConfigEntry
  | MountConfigEntry
  | RaidConfigEntry
  | LvmVolgroupEntry
  | LvmPartitionEntry
  | DmCryptEntry;

export interface EncryptedVolume {
  device: string;
  mapper: string;
  mountpoint: string;
  fs_type: string;
  label: string;
}

export interface CurtinServiceOptions {
  vgNames?: ReadonlySet<unknown> | null;
  mdNames?: ReadonlySet<unknown> | null;
  luksKeyFactory?: (() => string) | null;
}

const NESTED_RAID_LEVELS: Record<string, { inner: string; outer: string }> = {
  raid50: { inner: 'raid5', outer: 'raid0' },
  raid60: { inner: 'raid6', outer: 'raid0' },
};

const RAID_MIN_MEMBERS: Record<string, number> = {
  raid0: 2,
  raid1: 2,
  raid5: 3,
  raid6: 4,
  raid10: 4,
};

export function splitIntoInnerGroups(partitionIds: string[]): string[][] {
  const half = Math.ceil(partitionIds.length / 2);
  return [partitionIds.slice(0, half), partitionIds.slice(half)];
}

export function normalizeMdName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const m = /(?:^|\/)(md\d+)\b/.exec(name.trim());
  return m ? m[1]! : null;
}

export class CurtinService {
  config: StorageConfig;
  counters = new StorageCounters();
  storageConfig: CurtinStorageEntry[] = [];
  bootMounts: MountConfigEntry[] = [];
  efiDisks: string[] = [];
  grubDisks: string[] = [];
  yamlContent = '';
  encryptedVolumes: EncryptedVolume[] = [];
  private readonly existingVgNames: Set<unknown>;
  private readonly existingMdNames: Set<string>;
  private readonly luksKeyFactory: () => string;

  constructor(config: StorageConfig, options: CurtinServiceOptions = {}) {
    this.config = config;
    this.existingVgNames = new Set(options.vgNames ?? []);
    this.existingMdNames = new Set(
      [...(options.mdNames ?? [])].map(normalizeMdName).filter((n): n is string => n !== null),
    );
    this.luksKeyFactory = options.luksKeyFactory ?? (() => randomUUID());
  }

  async buildLayout(): Promise<void> {
    try {
      logInfo('Building storage layout configuration', { jobId: this.config.jobId });

      if (this.config.diskGroups.length === 0) {
        const errorMsg = 'Failed to build storage layout: No disk groups configured';
        logError(errorMsg, { jobId: this.config.jobId });
        throw new StorageLayoutError(errorMsg);
      }

      this.counters = new StorageCounters();
      this.storageConfig = [];
      this.bootMounts = [];
      this.efiDisks = [];
      this.grubDisks = [];
      this.encryptedVolumes = [];

      await this.generateDiskLayout();

      const curtinConfig = { storage: { version: 2, config: this.storageConfig } };
      this.yamlContent = dump(curtinConfig, { sortKeys: false, noArrayIndent: true, lineWidth: 80 });

      logInfo('Storage layout configuration built successfully', { jobId: this.config.jobId });
      const redactedYaml = this.yamlContent.replace(/(key:\s+).+/g, '$1<redacted>');
      logDebug(`Curtin storage config:\n${redactedYaml}`, { jobId: this.config.jobId });
    } catch (e) {
      if (e instanceof StorageLayoutError || e instanceof StorageConfigError) {
        throw e;
      }
      const msg = e instanceof Error ? e.message : String(e);
      logError(`Failed to build storage layout: ${msg}`, { jobId: this.config.jobId });
      throw new StorageLayoutError(`Failed to build storage layout: ${msg}`);
    }
  }

  private async generateDiskLayout(): Promise<void> {
    logInfo('Generating complete disk layout', { jobId: this.config.jobId });

    for (const diskGroup of this.config.diskGroups) {
      if (diskGroup.mountpoint === '/') {
        await this.configureOsDisk(diskGroup);
      } else if (!diskGroup.wipe) {
        logInfo(
          `PRESERVING disk group: [${diskGroup.disks.map((v) => `'${v}'`).join(', ')}] (mountpoint: ${diskGroup.mountpoint}) - excluded from curtin config`,
          { jobId: this.config.jobId },
        );
        continue;
      } else {
        await this.configureDataDisk(diskGroup);
      }
    }

    this.storageConfig.push(...this.bootMounts);

    logInfo('Complete disk layout generated successfully', { jobId: this.config.jobId });
  }

  private async configureOsDisk(diskGroup: DiskGroup): Promise<void> {
    logInfo(`Configuring OS disk group: [${diskGroup.disks.map((v) => `'${v}'`).join(', ')}]`, {
      jobId: this.config.jobId,
    });

    if (diskGroup.encrypt) {
      logWarning(
        'Ignoring encrypt=True on OS disk group (mountpoint=/), LUKS encryption is only supported on data disks',
        {
          jobId: this.config.jobId,
        },
      );
      diskGroup.encrypt = false;
    }

    diskGroup.wipe = true;

    if (this.config.uefi) {
      await this.configureUefiBoot(diskGroup);
    } else {
      await this.configureLegacyBoot(diskGroup);
    }
  }

  private resolveRootPartitionSize(diskGroup: DiskGroup, availableRootSize: number): number {
    if (diskGroup.size === null) return availableRootSize;
    const perDisk = Number(perDiskBytesForUsable(diskGroup.config, diskGroup.disks.length, BigInt(diskGroup.size)));
    if (perDisk > availableRootSize) {
      throw new StorageConfigError(`Requested size exceeds the available root capacity on ${diskGroup.mountpoint}`);
    }
    return perDisk;
  }

  private async configureUefiBoot(diskGroup: DiskGroup): Promise<void> {
    logDebug('Configuring UEFI boot layout', { jobId: this.config.jobId });

    const rootPartitions: string[] = [];
    const geometry = computeUefiPartitionGeometry(coerceDiskSize(diskGroup.diskSize));
    const efiOffset = geometry['efi_offset'] ?? 0;
    const efiSize = geometry['efi_size'] ?? 0;
    const rootOffset = geometry['root_offset'] ?? 0;
    const rootSize = this.resolveRootPartitionSize(diskGroup, geometry['root_size'] ?? 0);

    let index = 0;
    for (const disk of diskGroup.disks) {
      index += 1;
      this.efiDisks.push(`/dev/${disk}`);

      const diskConfig = this.createDiskConfig({ disk, grubDevice: false, ptable: 'gpt' });
      this.storageConfig.push(diskConfig);

      const efiPartition = this.createPartitionConfig({
        device: `disk-${disk}`,
        number: 1,
        offset: efiOffset,
        size: efiSize,
        flag: 'boot',
        grubDevice: true,
      });
      this.storageConfig.push(efiPartition);

      const efiFormat = this.createFormatConfig(efiPartition.id, 'fat32', true);
      this.storageConfig.push(efiFormat);

      const efiPath = index === 1 ? '/boot/efi' : `/boot/efi${index}`;
      const efiMount = this.createMountConfig(efiFormat.id, efiPath);
      this.bootMounts.push(efiMount);

      const rootPartition = this.createPartitionConfig({
        device: `disk-${disk}`,
        number: 2,
        offset: rootOffset,
        size: rootSize,
      });
      this.storageConfig.push(rootPartition);
      rootPartitions.push(rootPartition.id);

      if (diskGroup.config === 'direct') break;
    }

    await this.configureRootFilesystem(diskGroup, rootPartitions);
  }

  private async configureLegacyBoot(diskGroup: DiskGroup): Promise<void> {
    logDebug('Configuring Legacy BIOS boot layout', { jobId: this.config.jobId });

    const bootPartitions: string[] = [];
    const rootPartitions: string[] = [];
    const geometry = computeLegacyPartitionGeometry(coerceDiskSize(diskGroup.diskSize));
    const biosOffset = geometry['bios_offset'] ?? 0;
    const biosSize = geometry['bios_size'] ?? 0;
    const bootOffset = geometry['boot_offset'] ?? 0;
    const bootSize = geometry['boot_size'] ?? 0;
    const rootOffset = geometry['root_offset'] ?? 0;
    const rootSize = this.resolveRootPartitionSize(diskGroup, geometry['root_size'] ?? 0);

    for (const disk of diskGroup.disks) {
      this.grubDisks.push(`/dev/${disk}`);

      const diskConfig = this.createDiskConfig({ disk, grubDevice: true, ptable: 'gpt' });
      this.storageConfig.push(diskConfig);

      const biosPartition = this.createPartitionConfig({
        device: `disk-${disk}`,
        number: 1,
        offset: biosOffset,
        size: biosSize,
        flag: 'bios_grub',
      });
      this.storageConfig.push(biosPartition);

      const bootPartition = this.createPartitionConfig({
        device: `disk-${disk}`,
        number: 2,
        offset: bootOffset,
        size: bootSize,
      });
      this.storageConfig.push(bootPartition);
      bootPartitions.push(bootPartition.id);

      const rootPartition = this.createPartitionConfig({
        device: `disk-${disk}`,
        number: 3,
        offset: rootOffset,
        size: rootSize,
      });
      this.storageConfig.push(rootPartition);
      rootPartitions.push(rootPartition.id);

      if (diskGroup.config === 'direct') break;
    }

    let bootFormat: FormatConfigEntry;
    const firstBootPartition = bootPartitions[0];
    if (diskGroup.disks.length >= 2 && diskGroup.config !== 'direct') {
      const bootRaid = this.createRaidConfig(bootPartitions, 'raid1');
      this.storageConfig.push(bootRaid);
      bootFormat = this.createFormatConfig(bootRaid.id, 'ext4', true);
    } else if (firstBootPartition !== undefined) {
      bootFormat = this.createFormatConfig(firstBootPartition, 'ext4', true);
    } else {
      throw new StorageLayoutError('Failed to build storage layout: no boot partition generated');
    }

    this.storageConfig.push(bootFormat);
    const bootMount = this.createMountConfig(bootFormat.id, '/boot');
    this.bootMounts.push(bootMount);

    await this.configureRootFilesystem(diskGroup, rootPartitions);
  }

  private async configureDataDisk(diskGroup: DiskGroup): Promise<void> {
    logInfo(
      `Configuring data disk group: [${diskGroup.disks.map((v) => `'${v}'`).join(', ')}] -> ${diskGroup.mountpoint}`,
      {
        jobId: this.config.jobId,
      },
    );

    if (diskGroup.encrypt && isEncryptRestrictedMountpoint(diskGroup.mountpoint)) {
      logWarning(
        `Ignoring encrypt=True on ${diskGroup.mountpoint} — encryption requires manual unlock via SSH, ` +
          'which is not possible for this mountpoint',
        { jobId: this.config.jobId },
      );
      diskGroup.encrypt = false;
    }

    const partitionIds: string[] = [];

    const perDiskDataSize =
      diskGroup.size === null
        ? null
        : Number(perDiskBytesForUsable(diskGroup.config, diskGroup.disks.length, BigInt(diskGroup.size)));
    if (
      perDiskDataSize !== null &&
      diskGroup.diskSize != null &&
      perDiskDataSize + DATA_PARTITION_OFFSET + GPT_SECONDARY_HEADER_BYTES + GPT_TAIL_SLACK_BYTES >
        coerceDiskSize(diskGroup.diskSize)
    ) {
      throw new StorageConfigError(`Requested size exceeds the disk capacity for ${diskGroup.mountpoint}`);
    }

    for (const disk of diskGroup.disks) {
      const diskConfig = this.createDiskConfig({ disk, grubDevice: false, wipe: diskGroup.wipe, ptable: 'gpt' });
      this.storageConfig.push(diskConfig);
      if (perDiskDataSize === null) {
        partitionIds.push(diskConfig.id);
      } else {
        const dataPartition = this.createPartitionConfig({
          device: diskConfig.id,
          number: 1,
          offset: DATA_PARTITION_OFFSET,
          size: perDiskDataSize,
          wipe: diskGroup.wipe,
        });
        this.storageConfig.push(dataPartition);
        partitionIds.push(dataPartition.id);
      }
    }

    if (diskGroup.config.startsWith('raid')) {
      await this.configureRaidFilesystem(diskGroup, partitionIds, true);
    } else if (diskGroup.config === 'lvm') {
      await this.configureLvmFilesystem(diskGroup, partitionIds, true);
    } else {
      let volumeId = partitionIds[0];
      if (volumeId === undefined) {
        throw new StorageLayoutError('Failed to build storage layout: data disk group produced no disks');
      }

      if (diskGroup.encrypt) {
        const cryptConfig = await this.createDmCryptConfig(volumeId, diskGroup.mountpoint);
        this.storageConfig.push(cryptConfig);
        const label = mountpointLabel(diskGroup.mountpoint);
        this.encryptedVolumes.push({
          device: `/dev/${diskGroup.disks[0] ?? ''}`,
          mapper: cryptConfig.dm_name,
          mountpoint: diskGroup.mountpoint,
          fs_type: diskGroup.format,
          label,
        });
        volumeId = cryptConfig.id;
      }

      const formatConfig = this.createFormatConfig(volumeId, diskGroup.format, diskGroup.wipe);
      this.storageConfig.push(formatConfig);

      const mountConfig = this.createMountConfig(formatConfig.id, diskGroup.mountpoint, 'nofail,defaults');
      this.storageConfig.push(mountConfig);
    }
  }

  private async configureRootFilesystem(diskGroup: DiskGroup, partitionIds: string[]): Promise<void> {
    if (diskGroup.config === 'direct') {
      const firstPartition = partitionIds[0];
      if (firstPartition === undefined) {
        throw new StorageLayoutError('Failed to build storage layout: root disk group produced no partitions');
      }
      const formatConfig = this.createFormatConfig(firstPartition, diskGroup.format, true);
      this.storageConfig.push(formatConfig);

      const mountConfig = this.createMountConfig(formatConfig.id, '/');
      this.storageConfig.push(mountConfig);
    } else if (diskGroup.config.startsWith('raid')) {
      await this.configureRaidFilesystem(diskGroup, partitionIds);
    } else if (diskGroup.config === 'lvm') {
      await this.configureLvmFilesystem(diskGroup, partitionIds);
    }
  }

  private async configureRaidFilesystem(
    diskGroup: DiskGroup,
    partitionIds: string[],
    dataMount = false,
  ): Promise<void> {
    const raidConfig = this.buildRaidStack(partitionIds, diskGroup.config, diskGroup.wipe);

    let volumeId = raidConfig.id;

    if (diskGroup.encrypt) {
      const cryptConfig = await this.createDmCryptConfig(volumeId, diskGroup.mountpoint);
      this.storageConfig.push(cryptConfig);
      const label = mountpointLabel(diskGroup.mountpoint);
      this.encryptedVolumes.push({
        device: `/dev/${raidConfig.name}`,
        mapper: cryptConfig.dm_name,
        mountpoint: diskGroup.mountpoint,
        fs_type: diskGroup.format,
        label,
      });
      volumeId = cryptConfig.id;
    }

    const formatConfig = this.createFormatConfig(volumeId, diskGroup.format, diskGroup.wipe);
    this.storageConfig.push(formatConfig);

    const options = dataMount ? 'nofail,defaults' : undefined;
    const mountConfig = this.createMountConfig(formatConfig.id, diskGroup.mountpoint, options);
    this.storageConfig.push(mountConfig);
  }

  // Returns the top-level array. A single `raidlevel: raid50` entry fails at deploy — nested levels must be decomposed into constituent arrays.
  private buildRaidStack(partitionIds: string[], config: string, wipe: boolean): RaidConfigEntry {
    const nested = NESTED_RAID_LEVELS[config];
    if (!nested) {
      const raidConfig = this.createRaidConfig(partitionIds, config, wipe);
      this.storageConfig.push(raidConfig);
      return raidConfig;
    }

    const groups = splitIntoInnerGroups(partitionIds);
    const innerIds: string[] = [];
    for (const group of groups) {
      const inner = this.createRaidConfig(group, nested.inner, wipe);
      this.storageConfig.push(inner);
      innerIds.push(inner.id);
    }
    const outer = this.createRaidConfig(innerIds, nested.outer, wipe);
    this.storageConfig.push(outer);
    return outer;
  }

  private async configureLvmFilesystem(diskGroup: DiskGroup, partitionIds: string[], dataMount = false): Promise<void> {
    const lvmConfig = this.createLvmConfig(partitionIds, diskGroup.wipe);
    this.storageConfig.push(lvmConfig);

    const lvmPartitionConfig = this.createLvmPartitionConfig(lvmConfig.id, diskGroup.wipe);
    this.storageConfig.push(lvmPartitionConfig);

    let volumeId = lvmPartitionConfig.id;

    if (diskGroup.encrypt) {
      const cryptConfig = await this.createDmCryptConfig(volumeId, diskGroup.mountpoint);
      this.storageConfig.push(cryptConfig);
      const label = mountpointLabel(diskGroup.mountpoint);
      this.encryptedVolumes.push({
        device: `/dev/${lvmConfig.name}/${lvmPartitionConfig.name}`,
        mapper: cryptConfig.dm_name,
        mountpoint: diskGroup.mountpoint,
        fs_type: diskGroup.format,
        label,
      });
      volumeId = cryptConfig.id;
    }

    const formatConfig = this.createFormatConfig(volumeId, diskGroup.format, diskGroup.wipe);
    this.storageConfig.push(formatConfig);

    const options = dataMount ? 'nofail,defaults' : undefined;
    const mountConfig = this.createMountConfig(formatConfig.id, diskGroup.mountpoint, options);
    this.storageConfig.push(mountConfig);
  }

  private createDiskConfig(params: {
    disk: string;
    grubDevice: boolean;
    ptable?: string | null;
    wipe?: boolean;
  }): DiskConfigEntry {
    const wipe = params.wipe ?? true;
    const config: DiskConfigEntry = {
      grub_device: params.grubDevice,
      id: `disk-${params.disk}`,
      path: `/dev/${params.disk}`,
      preserve: !wipe,
      type: 'disk',
    };

    if (params.ptable && wipe) {
      config.ptable = params.ptable;
    }

    return config;
  }

  private createPartitionConfig(params: {
    device: string;
    number: number;
    offset: number;
    size: number;
    flag?: string | null;
    grubDevice?: boolean;
    wipe?: boolean;
  }): PartitionConfigEntry {
    const wipe = params.wipe ?? true;
    const config: PartitionConfigEntry = {
      device: params.device,
      id: `partition-${this.counters.partition}`,
      number: params.number,
      offset: params.offset,
      size: params.size,
      type: 'partition',
      preserve: !wipe,
    };

    if (wipe) config.wipe = 'superblock';
    if (params.flag) config.flag = params.flag;
    if (params.grubDevice) config.grub_device = params.grubDevice;

    this.counters.partition += 1;
    return config;
  }

  private createFormatConfig(volumeId: string, fstype: string, wipe: boolean): FormatConfigEntry {
    const config: FormatConfigEntry = {
      fstype,
      id: `format-${this.counters.format}`,
      preserve: !wipe,
      type: 'format',
      volume: volumeId,
    };

    if (wipe && fstype === 'ext4') config.extra_options = ['-E', 'nodiscard'];
    if (wipe && fstype === 'xfs') config.extra_options = ['-K'];

    this.counters.format += 1;
    return config;
  }

  private createMountConfig(device: string, path: string, options?: string | null): MountConfigEntry {
    const config: MountConfigEntry = {
      device,
      id: `mount-${this.counters.mount}`,
      path,
      type: 'mount',
    };

    if (options) config.options = options;

    this.counters.mount += 1;
    return config;
  }

  private createRaidConfig(devices: string[], raidLevel: string, wipe = true): RaidConfigEntry {
    const min = RAID_MIN_MEMBERS[raidLevel];
    if (min !== undefined && devices.length < min) {
      throw new StorageLayoutError(
        `Failed to build storage layout: RAID level "${raidLevel}" requires at least ${min} members; got ${devices.length}`,
      );
    }

    // Skip md indices already in use — reusing an assembled mdN can clobber the in-use array.
    while (this.existingMdNames.has(`md${this.counters.raid}`)) {
      this.counters.raid += 1;
    }

    const config: RaidConfigEntry = {
      devices,
      id: `raid-${this.counters.raid}`,
      name: `md${this.counters.raid}`,
      raidlevel: raidLevel,
      type: 'raid',
      preserve: !wipe,
    };

    if (wipe) config.wipe = 'superblock';

    this.counters.raid += 1;
    return config;
  }

  private createLvmConfig(devices: string[], wipe = true): LvmVolgroupEntry {
    while (this.existingVgNames.has(`vg${this.counters.lvm}`)) {
      this.counters.lvm += 1;
    }

    const config: LvmVolgroupEntry = {
      devices,
      id: `lvm_volgroup-${this.counters.lvm}`,
      name: `vg${this.counters.lvm}`,
      type: 'lvm_volgroup',
      preserve: !wipe,
    };

    if (wipe) config.wipe = 'superblock';

    this.counters.lvm += 1;
    return config;
  }

  private createLvmPartitionConfig(volgroup: string, wipe = true): LvmPartitionEntry {
    const config: LvmPartitionEntry = {
      id: `lvm_partition-${this.counters.lvmPartition}`,
      name: `lv-${this.counters.lvmPartition}`,
      type: 'lvm_partition',
      volgroup,
      preserve: !wipe,
    };

    if (wipe) config.wipe = 'superblock';

    this.counters.lvmPartition += 1;
    return config;
  }

  private async createDmCryptConfig(volumeId: string, mountpoint = ''): Promise<DmCryptEntry> {
    const config: DmCryptEntry = {
      id: `dm_crypt-${this.counters.dmCrypt}`,
      type: 'dm_crypt',
      dm_name: `crypt-${this.counters.dmCrypt}`,
      volume: volumeId,
      key: this.luksKeyFactory(),
      preserve: false,
    };

    logInfo(
      `LUKS encryption enabled for ${mountpoint || volumeId}: dm_name=${config.dm_name}, wrapping volume=${volumeId}`,
      {
        jobId: this.config.jobId,
      },
    );

    this.counters.dmCrypt += 1;
    return config;
  }

  getLayoutInfo(): Record<string, unknown> {
    return {
      config: {
        target_dir: this.config.targetDir,
        uefi: this.config.uefi,
        disk_groups: this.config.diskGroups.length,
      },
      generated: {
        storage_objects: this.storageConfig.length,
        efi_disks: this.efiDisks,
        grub_disks: this.grubDisks,
        boot_mounts: this.bootMounts.length,
        storage_config: this.storageConfig,
        yaml_content: this.yamlContent,
      },
      counters: {
        partitions: this.counters.partition,
        formats: this.counters.format,
        mounts: this.counters.mount,
        raids: this.counters.raid,
        lvm_groups: this.counters.lvm,
        lvm_partitions: this.counters.lvmPartition,
        dm_crypt: this.counters.dmCrypt,
      },
    };
  }
}

function mountpointLabel(mountpoint: string): string {
  return mountpoint.replace(/^\/+|\/+$/g, '').replace(/\//g, '-') || 'data';
}

function coerceDiskSize(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '' || !/^[+-]?\d+(_\d+)*$/.test(trimmed)) {
      throw new TypeError(`invalid integer: '${value}'`);
    }
    return parseInt(trimmed.replace(/_/g, ''), 10);
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  throw new TypeError(`expected a string or number for disk size, got ${value === null ? 'null' : typeof value}`);
}

function coerceRequestedSize(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  throw new TypeError(
    `expected an integer number of bytes for size, got ${typeof value === 'number' ? value : typeof value}`,
  );
}

function requireKey(group: Record<string, unknown>, key: string): unknown {
  if (!(key in group)) {
    throw new StorageConfigError(`'${key}'`);
  }
  return group[key];
}

export interface CreateCurtinServiceOptions {
  vgNames?: ReadonlySet<unknown> | null;
  mdNames?: ReadonlySet<unknown> | null;
  jobId?: string;
  uefi?: boolean;
}

export async function createCurtinService(
  targetDir: string,
  diskGroups: readonly Record<string, unknown>[],
  options: CreateCurtinServiceOptions = {},
): Promise<CurtinService> {
  const diskGroupObjects: DiskGroup[] = [];
  for (const group of diskGroups) {
    const wipeRaw = 'wipe' in group ? (group['wipe'] as boolean | null) : true;
    const encryptRaw = 'encrypt' in group ? (group['encrypt'] as boolean | null) : false;
    const diskGroup = new DiskGroup({
      disks: requireKey(group, 'disks') as string[],
      config: requireKey(group, 'config') as string,
      format: requireKey(group, 'format') as string,
      mountpoint: requireKey(group, 'mountpoint') as string,
      diskSize: ('disk_size' in group ? group['disk_size'] : null) as number | string | null,
      size: coerceRequestedSize('size' in group ? group['size'] : null),
      wipe: wipeRaw,
      encrypt: encryptRaw,
    });
    diskGroupObjects.push(diskGroup);
  }

  const config = new StorageConfig({
    targetDir,
    diskGroups: diskGroupObjects,
    jobId: options.jobId ?? '',
    uefi: options.uefi ?? false,
  });

  return new CurtinService(config, { vgNames: options.vgNames, mdNames: options.mdNames });
}
