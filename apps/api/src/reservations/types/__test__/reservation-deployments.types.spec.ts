import { DeviceRole, DeviceType } from '@repo/database';
import { describe, expect, it } from 'vitest';
import {
  DeviceMetadataSchema,
  ReservationDeploymentSchema,
  StorageLayoutSchema,
  StorageLayoutsSchema,
} from '../reservation-deployments.types';

const validStorageLayout = {
  configs: [
    {
      disks: [{ wwn: '0x3001438038d17d50', name: 'sda', serial: 'BTHC5456011D800NGN' }],
      disk_type: 'ssd',
      num_disks: 1,
      capabilities: ['lvm'],
      file_systems: ['ext4', 'xfs'],
      size_per_disk: 800166076416,
      disk_group_name: 'SSD_800GB',
    },
  ],
  default: {
    os_disks_group: { group: 'SSD_800GB', config: 'lvm', mountpoint: '/', file_system: 'ext4' },
    data_disks_groups: [{ group: 'HDD_2000GB', config: 'lvm', mountpoint: '/data0', file_system: 'ext4' }],
    cold_storage_disks_groups: [],
  },
};

const validMetadata = {
  id: 1,
  name: 'Test Device',
  status: 'PROVISIONED',
  serial: 'SERIAL123',
  role: DeviceRole.Baremetal,
  regionName: 'North America',
  clusterId: 1,
  clusterName: 'Test Cluster',
  primaryIp4: '1.2.3.4',
  primaryIp6: '2001:db8::1',
  cpuModel: 'Intel Xeon',
  cpuThreadCount: 32,
  cpuCoreCount: 16,
  cpuPhysicalCount: 2,
  ipamConfig: null,
  macAddress: '00:11:22:33:44:55',
  memory: 128,
  ssdSize: 500,
  ssdCount: 1,
  deviceId: '00000000-0000-0000-0000-000000000001',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const validDeployment = {
  id: '00000000-0000-0000-0000-000000000010',
  nickname: 'Test Deployment',
  startDate: new Date(),
  createdAt: new Date(),
  type: 'SELF_SERVICE',
  deviceId: '00000000-0000-0000-0000-000000000001',
  baseLayerId: '00000000-0000-0000-0000-000000000002',
  reservationId: '00000000-0000-0000-0000-000000000003',
  device: {
    id: '00000000-0000-0000-0000-000000000001',
    name: 'Test Device',
    nickname: 'nick',
    supplierId: '00000000-0000-0000-0000-000000000004',
    supplier: { id: 'supplier-123', name: 'Test Supplier', tenantType: 'SupplyCustomer', logo: null },
    deviceType: DeviceType.Baremetal,
    price: 1000,
    isListed: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    storageLayouts: validStorageLayout,
    skuId: '00000000-0000-0000-0000-000000000005',
    metadata: validMetadata,
  },
};

describe('reservation-deployments schemas', () => {
  it('accepts a valid storage layout', () => {
    expect(StorageLayoutSchema.safeParse(validStorageLayout).success).toBe(true);
  });

  it('accepts a null os_disks_group', () => {
    const layout = { ...validStorageLayout, default: { ...validStorageLayout.default, os_disks_group: null } };
    expect(StorageLayoutSchema.safeParse(layout).success).toBe(true);
  });

  it('accepts omitted and null default disk groups', () => {
    expect(StorageLayoutSchema.safeParse({ configs: validStorageLayout.configs, default: {} }).success).toBe(true);
    const nulled = {
      configs: validStorageLayout.configs,
      default: { os_disks_group: null, data_disks_groups: null, cold_storage_disks_groups: null },
    };
    expect(StorageLayoutSchema.safeParse(nulled).success).toBe(true);
  });

  it('accepts a disk with null wwn and missing serial (real lsblk output)', () => {
    const layout = {
      ...validStorageLayout,
      configs: [{ ...validStorageLayout.configs[0], disks: [{ wwn: null, name: 'vda' }] }],
    };
    expect(StorageLayoutSchema.safeParse(layout).success).toBe(true);
  });

  it('accepts a config with file_systems omitted', () => {
    const { file_systems: _omitted, ...config } = validStorageLayout.configs[0];
    expect(StorageLayoutSchema.safeParse({ ...validStorageLayout, configs: [config] }).success).toBe(true);
  });

  it('rejects a partial structured layout', () => {
    expect(StorageLayoutSchema.safeParse(undefined).success).toBe(false);
    expect(StorageLayoutSchema.safeParse('nope').success).toBe(false);
    expect(StorageLayoutSchema.safeParse({ configs: [] }).success).toBe(false);
  });

  it('accepts the canonical empty-object default for storageLayouts', () => {
    expect(StorageLayoutsSchema.safeParse({}).success).toBe(true);
    expect(StorageLayoutsSchema.safeParse(validStorageLayout).success).toBe(true);
  });

  it('rejects non-object storageLayouts values', () => {
    expect(StorageLayoutsSchema.safeParse(null).success).toBe(false);
    expect(StorageLayoutsSchema.safeParse(undefined).success).toBe(false);
    expect(StorageLayoutsSchema.safeParse('nope').success).toBe(false);
  });

  it('accepts a reservation device whose storageLayouts is the empty default', () => {
    const deployment = {
      ...validDeployment,
      device: { ...validDeployment.device, storageLayouts: {} },
    };
    expect(ReservationDeploymentSchema.safeParse(deployment).success).toBe(true);
  });

  it('rejects malformed disk-group elements', () => {
    const layout = {
      ...validStorageLayout,
      default: { ...validStorageLayout.default, data_disks_groups: [{ group: 'x' }] },
    };
    expect(StorageLayoutSchema.safeParse(layout).success).toBe(false);
  });

  it('accepts a null ipamConfig', () => {
    expect(DeviceMetadataSchema.safeParse({ ...validMetadata, ipamConfig: null }).success).toBe(true);
  });

  it('rejects a non-object ipamConfig', () => {
    expect(DeviceMetadataSchema.safeParse({ ...validMetadata, ipamConfig: 'oops' }).success).toBe(false);
  });

  it('accepts a fully valid reservation deployment', () => {
    expect(ReservationDeploymentSchema.safeParse(validDeployment).success).toBe(true);
  });

  it('accepts a reservation deployment with null baseLayerId', () => {
    const deployment = { ...validDeployment, baseLayerId: null };
    expect(ReservationDeploymentSchema.safeParse(deployment).success).toBe(true);
  });

  it('rejects a reservation deployment with baseLayerId omitted', () => {
    const { baseLayerId: _omitted, ...deployment } = validDeployment;
    expect(ReservationDeploymentSchema.safeParse(deployment).success).toBe(false);
  });

  it('rejects a reservation deployment with a malformed nested storage layout', () => {
    const bad = {
      ...validDeployment,
      device: { ...validDeployment.device, storageLayouts: { configs: 'not-an-array', default: {} } },
    };
    expect(ReservationDeploymentSchema.safeParse(bad).success).toBe(false);
  });
});
