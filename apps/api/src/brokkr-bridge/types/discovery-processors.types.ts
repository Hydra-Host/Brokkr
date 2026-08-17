export function isSsd(rota: unknown): boolean {
  return rota === 0 || rota === '0' || rota === false || rota === 'false';
}

export interface StorageLayoutData {
  configs: DiskLayoutConfig[];
  default: DefaultDiskLayout;
}

export interface DiskLayoutConfig {
  disk_group_name: string;
  disk_type: string;
  disks: Record<string, unknown>[];
  capabilities: string[];
  size_per_disk: number;
  file_systems: string[];
  num_disks: number;
}

export interface DefaultDiskLayout {
  os_disks_group: DiskGroupAssignment | null;
  data_disks_groups: DiskGroupAssignment[];
  cold_storage_disks_groups: DiskGroupAssignment[];
}

export interface DiskGroupAssignment {
  config: string;
  file_system: string;
  group: string;
  mountpoint: string;
}
