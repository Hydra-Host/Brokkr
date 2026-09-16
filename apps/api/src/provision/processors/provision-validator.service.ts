import { BadRequestException, Injectable } from '@nestjs/common';
import {
  ENCRYPT_RESTRICTED_MOUNTPOINTS,
  isIpxeCustomOs,
  MOUNTPOINT_PATTERN,
  validateRaidDiskCount,
  type DiskLayout,
  type ProvisionRequest,
} from '@repo/api-client';
import { LayerKind, type StorageDrive } from '@repo/database';
import { hardwareEligibleLayerSlugs, LayerArtifactRecord, LayerRecord } from '@repo/layers';
import {
  DATA_PARTITION_OVERHEAD_BYTES,
  DATA_SIZE_MIN_BYTES,
  formatSize,
  raidUsableCapacityBytes,
  ROOT_PARTITION_OVERHEAD_BYTES,
  ROOT_SIZE_MIN_BYTES,
} from '@repo/utils';

type ResolvedDiskMember = { identifier: string; drive: StorageDrive };

export function flattenCustomizations(input: Record<string, string | string[]> | null | undefined): string[] | null {
  if (!input) return null;
  const values = Object.values(input).flat();
  return values.length > 0 ? values : null;
}

@Injectable()
export class ProvisionValidatorService {
  validateMountpoint(mountpoint: string): void {
    const slashCount = (mountpoint.match(/\//g) || []).length;

    if (!mountpoint.startsWith('/')) {
      throw new BadRequestException(`Mountpoint "${mountpoint}" must start with "/"`);
    }

    if (slashCount < 1 || slashCount > 2) {
      throw new BadRequestException(
        `Mountpoint "${mountpoint}" must be a valid path, starting with "/" and containing up to two "/"`,
      );
    }

    if (!MOUNTPOINT_PATTERN.test(mountpoint)) {
      throw new BadRequestException(
        `Mountpoint "${mountpoint}" contains invalid characters; only letters, digits, ".", "_", "-", and "/" are allowed`,
      );
    }

    if (
      mountpoint !== '/' &&
      mountpoint
        .split('/')
        .slice(1)
        .some((segment) => segment.length === 0)
    ) {
      throw new BadRequestException(`Mountpoint "${mountpoint}" must not contain empty path segments`);
    }
  }

  validateDiskLayouts(layouts: DiskLayout[], mode: 'provision' | 'reprovision'): void {
    for (const layout of layouts) {
      this.validateMountpoint(layout.mountpoint);

      if (layout.encrypt && (ENCRYPT_RESTRICTED_MOUNTPOINTS as readonly string[]).includes(layout.mountpoint)) {
        throw new BadRequestException(`Encryption is not supported on system mountpoint "${layout.mountpoint}"`);
      }

      if (mode === 'provision' && layout.wipe === false) {
        throw new BadRequestException('Cannot preserve disks on initial provision — all disk groups must be wiped');
      }

      if (mode === 'reprovision' && layout.encrypt && layout.wipe === false) {
        throw new BadRequestException('Cannot encrypt a preserved disk group — encryption requires a fresh format');
      }

      if (mode === 'reprovision' && layout.mountpoint === '/' && layout.wipe === false) {
        throw new BadRequestException(
          'Cannot preserve the root "/" disk group — the OS/root must be wiped to rebuild EFI/root',
        );
      }

      const raidViolation = validateRaidDiskCount(layout.config, layout.disks.length);
      if (raidViolation) {
        throw new BadRequestException(raidViolation);
      }
    }
    this.validateDirectConsistency(layouts);
    this.validateUniqueRootMountpoint(layouts);
    this.validateNoDuplicateDisks(layouts);
  }

  private resolveDrive(storageDrives: StorageDrive[], identifier: string, mountpoint: string): StorageDrive {
    const nameMatch = storageDrives.find((drive) => drive.name === identifier);
    if (nameMatch) return nameMatch;

    const metadataMatches = storageDrives.filter((drive) => drive.serial === identifier || drive.wwn === identifier);
    if (metadataMatches.length === 0) {
      throw new BadRequestException(
        `Disk identifier "${identifier}" in RAID group "${mountpoint}" does not match a known disk.`,
      );
    }
    if (metadataMatches.length > 1) {
      throw new BadRequestException(
        `Disk identifier "${identifier}" in RAID group "${mountpoint}" matches multiple disks by serial or WWN.`,
      );
    }
    return metadataMatches[0];
  }

  validateDiskGroupHomogeneity(layouts: DiskLayout[], storageDrives: StorageDrive[]): void {
    const label = (member: ResolvedDiskMember): string =>
      member.identifier === member.drive.name
        ? `"${member.drive.name}"`
        : `"${member.drive.name}" (matched via "${member.identifier}")`;

    for (const layout of layouts) {
      if (!layout.config?.startsWith('raid')) continue;

      const resolved = layout.disks.map((identifier) => ({
        identifier,
        drive: this.resolveDrive(storageDrives, identifier, layout.mountpoint),
      }));
      const resolvedNames = new Set<string>();
      for (const member of resolved) {
        if (resolvedNames.has(member.drive.name)) {
          throw new BadRequestException(
            `RAID group "${layout.mountpoint}" references disk "${member.drive.name}" more than once.`,
          );
        }
        resolvedNames.add(member.drive.name);
      }

      const [first, ...rest] = resolved;

      const typeMismatch = rest.find((member) => member.drive.type !== first.drive.type);
      if (typeMismatch) {
        throw new BadRequestException(
          `Disk group "${layout.mountpoint}" mixes disk types: ${label(first)} is ${first.drive.type} but ${label(typeMismatch)} is ${typeMismatch.drive.type}. All disks in a disk group must be the same type.`,
        );
      }

      const sizeMismatch = rest.find((member) => member.drive.sizeBytes !== first.drive.sizeBytes);
      if (sizeMismatch) {
        throw new BadRequestException(
          `Disk group "${layout.mountpoint}" mixes disk sizes: ${label(first)} is ${first.drive.sizeBytes} bytes but ${label(sizeMismatch)} is ${sizeMismatch.drive.sizeBytes} bytes. All disks in a disk group must be the same size.`,
        );
      }

      const withModel = resolved
        .map((member) => ({ member, model: member.drive.model?.trim() }))
        .filter((entry): entry is { member: ResolvedDiskMember; model: string } => !!entry.model);
      const modelReference = withModel[0];
      const modelMismatch = modelReference
        ? withModel.find((entry) => entry.model.toLowerCase() !== modelReference.model.toLowerCase())
        : undefined;
      if (modelReference && modelMismatch) {
        throw new BadRequestException(
          `Disk group "${layout.mountpoint}" mixes disk models: ${label(modelReference.member)} is "${modelReference.model}" but ${label(modelMismatch.member)} is "${modelMismatch.model}". All disks in a disk group must be the same model.`,
        );
      }
    }
  }

  validateDiskGroupSizeLimits(layouts: DiskLayout[], storageDrives: StorageDrive[]): void {
    for (const layout of layouts) {
      if (layout.size === undefined) continue;

      if (layout.encrypt) {
        throw new BadRequestException(`Disk group "${layout.mountpoint}": a size cannot be combined with encryption`);
      }
      if (layout.wipe === false) {
        throw new BadRequestException(
          `Disk group "${layout.mountpoint}": a size cannot be set on a preserved disk group`,
        );
      }

      const minimum = layout.mountpoint === '/' ? ROOT_SIZE_MIN_BYTES : DATA_SIZE_MIN_BYTES;
      if (layout.size < minimum) {
        throw new BadRequestException(
          `Requested size ${formatSize(layout.size)} for "${layout.mountpoint}" is below the minimum of ${formatSize(minimum)}`,
        );
      }

      const drives = layout.disks.map((identifier) => this.resolveDrive(storageDrives, identifier, layout.mountpoint));
      if (drives.length === 0) continue;

      const perDisk = drives.reduce(
        (min, drive) => (drive.sizeBytes < min ? drive.sizeBytes : min),
        drives[0].sizeBytes,
      );
      const overhead = layout.mountpoint === '/' ? ROOT_PARTITION_OVERHEAD_BYTES : DATA_PARTITION_OVERHEAD_BYTES;
      const usablePerDisk = perDisk - overhead;
      if (usablePerDisk <= 0n) {
        throw new BadRequestException(`Disk group "${layout.mountpoint}": disks are too small to carry a custom size`);
      }

      const capacity = raidUsableCapacityBytes(layout.config, layout.disks.length, usablePerDisk);
      if (BigInt(layout.size) > capacity) {
        throw new BadRequestException(
          `Requested size ${formatSize(layout.size)} for "${layout.mountpoint}" exceeds the disk group's usable capacity of ${formatSize(capacity)}`,
        );
      }
    }
  }

  // A disk in both a wipe=true and wipe=false group is a data-loss hazard.
  validateNoDuplicateDisks(layouts: DiskLayout[]): void {
    const seen = new Set<string>();
    for (const layout of layouts) {
      for (const disk of layout.disks) {
        if (seen.has(disk)) {
          throw new BadRequestException(
            `Disk "${disk}" appears in more than one disk group; each disk may belong to exactly one group`,
          );
        }
        seen.add(disk);
      }
    }
  }

  validateDirectConsistency(layouts: DiskLayout[]): void {
    const anyDirect = layouts.some((l) => l.config === 'direct');
    if (!anyDirect) return;

    if (layouts.length !== 1) {
      throw new BadRequestException(
        `When using "direct" layout, the request must contain exactly one disk group; got ${layouts.length}. "direct" partitions only a single disk, so all other groups must be omitted from the payload.`,
      );
    }

    if (layouts[0].mountpoint !== '/') {
      throw new BadRequestException(
        `When using "direct" layout, the mountpoint must be "/"; got "${layouts[0].mountpoint}".`,
      );
    }
  }

  validateUniqueRootMountpoint(layouts: DiskLayout[]): void {
    if (layouts.length === 0) return;
    const rootCount = layouts.filter((l) => l.mountpoint === '/').length;
    if (rootCount !== 1) {
      throw new BadRequestException(
        `Exactly one disk group must have mountpoint "/"; got ${rootCount}. Without an OS disk the bridge cannot build an EFI/root partition.`,
      );
    }
  }

  validateIpxeRequirements(operatingSystem: string, ipxeUrl?: string | null): void {
    if (isIpxeCustomOs(operatingSystem) && !ipxeUrl) {
      throw new BadRequestException('iPXE URL is required when using iPXE Custom operating system');
    }

    if (ipxeUrl && !isIpxeCustomOs(operatingSystem)) {
      throw new BadRequestException('iPXE URL can only be used with iPXE Custom operating system');
    }
  }

  async validateCustomizations(
    customizations: string[] | null | undefined,
    gpuModel: string | null | undefined,
    teeCapable: boolean,
    operatingSystem?: string | null,
    deviceArch?: string | null,
    layerBuildId?: string | null,
  ): Promise<void> {
    if (!customizations || customizations.length === 0) return;

    const layerKindBySlug = await LayerRecord.findAllKindsBySlug();

    for (const slug of customizations) {
      if (!layerKindBySlug.has(slug)) {
        throw new BadRequestException(`Unknown OS Customization: "${slug}"`);
      }
    }

    const osKind = operatingSystem ? layerKindBySlug.get(operatingSystem) : undefined;
    if (osKind === LayerKind.LEGACY) {
      throw new BadRequestException('OS customizations are not supported for legacy operating systems');
    }

    const drivers = customizations.filter((s) => s.startsWith('nvidia-driver-'));
    if (drivers.length > 1) {
      throw new BadRequestException(`Only one nvidia driver layer may be specified, got: ${drivers.join(', ')}`);
    }

    const cudas = customizations.filter((s) => s.startsWith('cuda-'));
    if (cudas.length > 1) {
      throw new BadRequestException(`Only one CUDA layer may be specified, got: ${cudas.join(', ')}`);
    }

    const pytorchs = customizations.filter((s) => s.startsWith('pytorch-'));
    if (pytorchs.length > 1) {
      throw new BadRequestException(`Only one PyTorch layer may be specified, got: ${pytorchs.join(', ')}`);
    }

    if (cudas.length === 1 && drivers.length === 0) {
      throw new BadRequestException(`A CUDA layer requires a compatible nvidia driver layer to also be specified`);
    }

    if (customizations.includes('nvidia-container-toolkit') && drivers.length === 0) {
      throw new BadRequestException(
        'nvidia-container-toolkit requires a compatible nvidia driver layer to also be specified',
      );
    }

    const eligible = new Set(hardwareEligibleLayerSlugs(gpuModel ?? null, teeCapable));
    const ineligible = customizations.filter((s) => !eligible.has(s));
    if (ineligible.length > 0) {
      throw new BadRequestException(
        `OS customization${ineligible.length > 1 ? 's' : ''} not compatible with this device: ${ineligible.join(', ')}`,
      );
    }

    if (osKind !== LayerKind.BASE || !operatingSystem || !layerBuildId) return;

    const sample = await LayerRecord.findBaseOsSampleBySlug(operatingSystem, layerBuildId);
    if (!sample) return;

    if (cudas.length === 1 && drivers.length === 1) {
      await this.assertArtifactRequires({
        layerBuildId,
        selectorSlug: cudas[0],
        selectedSlug: drivers[0],
        relatedSlugPrefix: 'nvidia-driver-',
        baseSample: sample,
        deviceArch,
        relatedKindLabel: 'Driver',
        relatedKindPlural: 'drivers',
      });
    }

    if (pytorchs.length === 1 && cudas.length === 1) {
      await this.assertArtifactRequires({
        layerBuildId,
        selectorSlug: pytorchs[0],
        selectedSlug: cudas[0],
        relatedSlugPrefix: 'cuda-',
        baseSample: sample,
        deviceArch,
        relatedKindLabel: 'CUDA',
        relatedKindPlural: 'CUDA versions',
      });
    }
  }

  private async assertArtifactRequires(args: {
    layerBuildId: string;
    selectorSlug: string;
    selectedSlug: string;
    relatedSlugPrefix: string;
    baseSample: { osDistro: string; osCodename: string };
    deviceArch?: string | null;
    relatedKindLabel: string;
    relatedKindPlural: string;
  }): Promise<void> {
    const compatible = await LayerArtifactRecord.findRequiresRelatedSlugs({
      layerBuildId: args.layerBuildId,
      selectorSlug: args.selectorSlug,
      osDistro: args.baseSample.osDistro,
      osCodename: args.baseSample.osCodename,
      arch: args.deviceArch,
      relatedSlugPrefix: args.relatedSlugPrefix,
    });
    if (compatible.length > 0 && !compatible.includes(args.selectedSlug)) {
      throw new BadRequestException(
        `${args.relatedKindLabel} "${args.selectedSlug}" is not compatible with "${args.selectorSlug}". Compatible ${args.relatedKindPlural}: ${[...compatible].sort().join(', ')}`,
      );
    }
  }

  validate(request: ProvisionRequest, storageDrives: StorageDrive[]): void {
    this.validateDiskLayouts(request.diskLayouts, 'provision');
    this.validateDiskGroupHomogeneity(request.diskLayouts, storageDrives);
    this.validateDiskGroupSizeLimits(request.diskLayouts, storageDrives);
    this.validateIpxeRequirements(request.operatingSystem, request.ipxeUrl);
  }
}
