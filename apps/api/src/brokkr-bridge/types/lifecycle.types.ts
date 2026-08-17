export interface ProvisionLifecycleData {
  hostname: string;
  diskLayouts: Array<Record<string, unknown>>;
  pubkeys: string[];
  userData: unknown;
  ipxeUrl: string | null;
  passwordHash: string | null;
  customizations: string[] | null;
  tee?: boolean;
}

export interface ProvisionDeviceData {
  netplan: string | null;
  gpu_model: string | null;
  purge_ttys: boolean;
  serial_port: string | null;
  serial_baud: number | null;
  device_type: string | null;
  network_type: string | null;
}

export interface OsLayerEntry {
  layer: string;
  sha256: string;
  compression: 'zstd' | 'gzip';
  stack_position: number;
}
