import { ENCRYPT_RESTRICTED_MOUNTPOINTS, SUPPORTED_DISK_FORMATS } from '@repo/api-client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Checkbox } from '@repo/ui/components/checkbox';
import { FormCheckbox } from '@repo/ui/form/form-checkbox';
import { FormInput } from '@repo/ui/form/form-input';
import { FormSelect } from '@repo/ui/form/form-select';
import { DATA_SIZE_MIN_BYTES, formatSize, parseSize, ROOT_SIZE_MIN_BYTES } from '@repo/utils';
import { useEffect, useMemo } from 'react';
import {
  type Control,
  type FieldValues,
  type Path,
  type PathValue,
  type UseFormSetValue,
  useWatch,
} from 'react-hook-form';
import type { z } from 'zod';

interface Disk {
  wwn?: string | null;
  name: string;
  serial?: string | null;
}

interface StorageLayoutConfig {
  disks: Disk[];
  disk_type: string;
  capabilities: string[];
  num_disks: number;
  size_per_disk: number;
  disk_group_name: string;
  file_systems?: string[];
}

interface StorageLayoutDiskGroup {
  config: string;
  file_system: string;
  group: string;
  mountpoint: string;
}

export interface StorageLayouts {
  configs: StorageLayoutConfig[];
  default: {
    os_disks_group?: StorageLayoutDiskGroup | null;
    data_disks_groups?: StorageLayoutDiskGroup[] | null;
    cold_storage_disks_groups?: StorageLayoutDiskGroup[] | null;
  };
}

export type DiskFormat = (typeof SUPPORTED_DISK_FORMATS)[number];

export interface DiskLayoutFormValues {
  config: string;
  format: DiskFormat;
  mountpoint: string;
  diskType: string;
  disks: string[];
  size: string;
  encrypt: boolean;
  wipe: boolean;
}

function toDiskFormat(value: string | undefined): DiskFormat {
  return (SUPPORTED_DISK_FORMATS as readonly string[]).includes(value ?? '')
    ? (value as DiskFormat)
    : SUPPORTED_DISK_FORMATS[0];
}

const STANDARD_MOUNTPOINTS = ['/', '/home', '/tmp', '/usr', '/var', '/srv', '/opt', '/usr/local'];

const CONFIG_LABELS: Record<string, string> = {
  direct: 'Direct',
  lvm: 'LVM',
  raid0: 'RAID 0',
  raid1: 'RAID 1',
  raid5: 'RAID 5',
  raid6: 'RAID 6',
  raid10: 'RAID 10',
  raid50: 'RAID 50',
  raid60: 'RAID 60',
};

type DefaultConfigMap = Record<string, { config: string; file_system: string; mountpoint: string }>;

function buildDefaultConfigMap(storageLayouts: StorageLayouts): DefaultConfigMap {
  return Object.values(storageLayouts?.default ?? {})
    .flat()
    .filter((item) => item && typeof item === 'object' && 'group' in item)
    .reduce(
      (acc: DefaultConfigMap, item: any) => ({
        ...acc,
        [item.group]: {
          config: item.config,
          file_system: item.file_system,
          mountpoint: item.mountpoint,
        },
      }),
      {},
    );
}

export function getDefaultDiskLayouts(storageLayouts: StorageLayouts): DiskLayoutFormValues[] {
  if (!storageLayouts?.configs?.length) return [];

  const defaultConfigMap = buildDefaultConfigMap(storageLayouts);

  return storageLayouts.configs.map((layout: StorageLayoutConfig) => {
    const { disk_group_name, disk_type, disks } = layout;
    const defaults = defaultConfigMap[disk_group_name];
    return {
      config: defaults?.config || '',
      format: toDiskFormat(defaults?.file_system),
      mountpoint: defaults?.mountpoint || '',
      diskType: disk_type,
      disks: disks.map((d) => d.wwn || d.serial || d.name),
      size: '',
      encrypt: false,
      wipe: true,
    };
  });
}

export function diskLayoutSizeToBytes(size: string | undefined): number | undefined {
  return parseSize(size) ?? undefined;
}

export function validateDiskLayoutSizeInputs(
  diskLayouts: readonly { size?: string; encrypt?: boolean; wipe?: boolean; config?: string; mountpoint?: string }[],
  ctx: z.RefinementCtx,
): void {
  const directIndex = diskLayouts.findIndex((layout) => layout.config === 'direct');
  const effective =
    directIndex >= 0
      ? [{ layout: diskLayouts[directIndex], index: directIndex }]
      : diskLayouts.map((layout, index) => ({ layout, index }));

  effective.forEach(({ layout, index }) => {
    if (!layout.size?.trim()) return;
    const parsed = parseSize(layout.size);
    if (parsed === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'Enter a size like "500 GB" or "1.5 TB", or leave blank for the full disk',
        path: ['diskLayouts', index, 'size'],
      });
      return;
    }
    const minimum = directIndex >= 0 || layout.mountpoint === '/' ? ROOT_SIZE_MIN_BYTES : DATA_SIZE_MIN_BYTES;
    if (parsed < minimum) {
      ctx.addIssue({
        code: 'custom',
        message: `Size must be at least ${formatSize(minimum)}`,
        path: ['diskLayouts', index, 'size'],
      });
    }
    if (layout.encrypt === true) {
      ctx.addIssue({
        code: 'custom',
        message: 'Size cannot be combined with encryption',
        path: ['diskLayouts', index, 'size'],
      });
    }
    if (layout.wipe === false) {
      ctx.addIssue({
        code: 'custom',
        message: 'Size cannot be set on a preserved disk group',
        path: ['diskLayouts', index, 'size'],
      });
    }
  });
}

export function applyDirectModeToSubmission<T extends { config: string; mountpoint: string }>(layouts: T[]): T[] {
  const directRow = layouts.find((l) => l.config === 'direct');
  if (!directRow) return layouts;
  return [{ ...directRow, mountpoint: '/' }];
}

interface DiskLayoutSelectorProps<T extends FieldValues = FieldValues> {
  storageLayouts: StorageLayouts;
  control: Control<T>;
  setValue: UseFormSetValue<T>;
  mode?: 'provision' | 'reprovision';
  disabled?: boolean;
}

export function DiskLayoutSelector<T extends FieldValues = FieldValues>({
  storageLayouts,
  control,
  setValue,
  mode = 'provision',
  disabled,
}: DiskLayoutSelectorProps<T>) {
  const defaultConfigMap = useMemo(() => buildDefaultConfigMap(storageLayouts), [storageLayouts]);

  const defaultMountpoints = useMemo(
    () =>
      Object.values(defaultConfigMap)
        .map(({ mountpoint }) => mountpoint)
        .filter(Boolean),
    [defaultConfigMap],
  );

  const singleLayout = storageLayouts?.configs?.length === 1;

  const mountpointOptions = useMemo(() => {
    if (singleLayout) return ['/'];
    return Array.from(new Set([...STANDARD_MOUNTPOINTS, ...defaultMountpoints, 'other']));
  }, [singleLayout, defaultMountpoints]);

  const diskLayouts = useWatch({ control: control as Control<FieldValues>, name: 'diskLayouts' }) as
    | DiskLayoutFormValues[]
    | undefined;

  const directIndex = useMemo(() => diskLayouts?.findIndex((l) => l?.config === 'direct') ?? -1, [diskLayouts]);
  const directModeActive = directIndex >= 0;
  const directMountpoint = directIndex >= 0 ? diskLayouts?.[directIndex]?.mountpoint : undefined;

  useEffect(() => {
    if (directIndex < 0) return;
    if (directMountpoint === '/') return;
    setValue(`diskLayouts.${directIndex}.mountpoint` as Path<T>, '/' as PathValue<T, Path<T>>, {
      shouldDirty: true,
      shouldValidate: false,
    });
  }, [setValue, directIndex, directMountpoint]);

  if (!storageLayouts?.configs?.length) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Disk Layouts</CardTitle>
        <CardDescription>Choose one layout for each disk type</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {storageLayouts.configs.map((layout: StorageLayoutConfig, index: number) => {
          const { disk_group_name, disk_type, size_per_disk, disks } = layout;
          const current = diskLayouts?.[index];
          const currentMountpoint = current?.mountpoint || '';
          const isOsDisk = currentMountpoint === '/';
          const isPreserved = current?.wipe === false;
          const encryptDisabled =
            (ENCRYPT_RESTRICTED_MOUNTPOINTS as readonly string[]).includes(currentMountpoint) || isPreserved;
          const isDirectRow = index === directIndex;
          const isDimmedByDirect = directModeActive && !isDirectRow;
          const rowDisabled = disabled || isDimmedByDirect;
          const parsedSize = parseSize(current?.size);

          return (
            <div
              key={disk_group_name}
              className={isDimmedByDirect ? 'pointer-events-none opacity-50' : undefined}
              aria-disabled={isDimmedByDirect || undefined}
            >
              <h3 className="mb-2 text-lg font-semibold">{disk_type.toUpperCase()}</h3>

              <div className="mb-4 space-y-1">
                <p className="text-muted-foreground text-sm">Disk Count: {disks.length}</p>
                <p className="text-muted-foreground text-sm">Size per disk: {formatSize(size_per_disk)}</p>
                {isDirectRow && (
                  <p className="text-sm text-amber-500">
                    Direct partitions only a single disk; all other storage devices will remain unpartitioned.
                  </p>
                )}
                {isDimmedByDirect && (
                  <p className="text-muted-foreground text-sm italic">
                    Disabled while another disk group is set to Direct. Disks in this group will remain unpartitioned.
                  </p>
                )}

                <div className="pt-1">
                  <p className="text-muted-foreground mb-1 text-xs font-semibold tracking-wider uppercase">Disks</p>
                  <div className="space-y-0.5">
                    {disks.map((disk) => (
                      <div key={disk.wwn || disk.serial || disk.name} className="flex gap-2 text-xs">
                        <span className="text-muted-foreground font-mono font-medium">{disk.name}</span>
                        {(disk.wwn || disk.serial) && (
                          <span className="text-muted-foreground/70 font-mono">
                            {disk.wwn ? `wwn: ${disk.wwn}` : `serial: ${disk.serial}`}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {!isPreserved ? (
                <div className="grid grid-cols-4 gap-4">
                  <FormSelect
                    control={control}
                    name={`diskLayouts.${index}.config` as Path<T>}
                    label="Layout"
                    options={layout.capabilities.map((cap) => ({
                      label: CONFIG_LABELS[cap] ?? cap,
                      value: cap,
                    }))}
                    placeholder="Select layout"
                    disabled={rowDisabled}
                  />

                  <FormSelect
                    control={control}
                    name={`diskLayouts.${index}.format` as Path<T>}
                    label="Format"
                    options={(layout.file_systems ?? []).map((fs) => ({
                      label: fs,
                      value: fs,
                    }))}
                    placeholder="Select format"
                    disabled={rowDisabled}
                  />

                  <div className="space-y-2">
                    <FormSelect
                      control={control}
                      name={`diskLayouts.${index}.mountpoint` as Path<T>}
                      label="Mountpoint"
                      options={mountpointOptions.map((mp) => ({
                        label: mp,
                        value: mp,
                      }))}
                      placeholder="Select mountpoint"
                      disabled={rowDisabled || isDirectRow}
                    />
                    {!isDirectRow && current?.mountpoint === 'other' && (
                      <FormInput
                        control={control}
                        name={`diskLayouts.${index}.mountpoint` as Path<T>}
                        label="Custom Mountpoint"
                        placeholder="/custom/path"
                        disabled={rowDisabled}
                      />
                    )}
                  </div>

                  <FormInput
                    control={control}
                    name={`diskLayouts.${index}.size` as Path<T>}
                    label="Size"
                    placeholder="Full disk"
                    disabled={rowDisabled || current?.encrypt === true}
                    description={
                      parsedSize != null ? `Provisions ${formatSize(parsedSize)}` : 'Leave blank to use the full disk'
                    }
                  />
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-4">
                  <div className="col-span-1">
                    <FormSelect
                      control={control}
                      name={`diskLayouts.${index}.mountpoint` as Path<T>}
                      label="Mountpoint"
                      options={mountpointOptions.map((mp) => ({
                        label: mp,
                        value: mp,
                      }))}
                      placeholder="Select mountpoint"
                      disabled={rowDisabled}
                    />
                    {current?.mountpoint === 'other' && (
                      <FormInput
                        control={control}
                        name={`diskLayouts.${index}.mountpoint` as Path<T>}
                        label="Custom Mountpoint"
                        placeholder="/custom/path"
                        disabled={rowDisabled}
                      />
                    )}
                  </div>
                  <div className="col-span-2 flex flex-col justify-center gap-2 rounded-md border border-dashed p-3">
                    <p className="text-muted-foreground text-sm">
                      This disk group will be preserved. Existing data will not be modified.
                    </p>
                    <p className="text-xs text-amber-500">
                      Disk names can change between boots. Verify the identifier shown in the disk list above matches
                      your system before preserving.
                    </p>
                  </div>
                </div>
              )}

              {!isDimmedByDirect && (
                <div className="mt-3 flex items-center gap-6">
                  {mode === 'reprovision' && !isOsDisk && (
                    <Checkbox
                      id={`preserve-${disk_group_name}`}
                      checked={isPreserved}
                      onCheckedChange={(checked) => {
                        const setVal = setValue as UseFormSetValue<FieldValues>;
                        setVal(`diskLayouts.${index}.wipe`, !checked);
                        if (checked) {
                          setVal(`diskLayouts.${index}.encrypt`, false);
                          setVal(`diskLayouts.${index}.size`, '');
                        }
                      }}
                      label="Preserve"
                      tooltip="Keep existing data on this disk group during reprovision"
                      disabled={disabled}
                    />
                  )}
                  {!isPreserved && !isOsDisk && (
                    <FormCheckbox
                      control={control}
                      name={`diskLayouts.${index}.encrypt` as Path<T>}
                      label="Encrypt"
                      onCheckedChange={(checked) => {
                        if (!checked) return;
                        const setVal = setValue as UseFormSetValue<FieldValues>;
                        setVal(`diskLayouts.${index}.size`, '');
                      }}
                      tooltip={
                        encryptDisabled
                          ? `Encryption is not available for ${currentMountpoint}`
                          : 'Enable LUKS disk encryption for this group'
                      }
                      disabled={disabled || encryptDisabled}
                    />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
