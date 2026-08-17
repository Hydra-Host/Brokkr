import { Prisma, ServerPowerStatus } from '@repo/database';
import { DeploymentAggregate } from '../types/deployments.types';

export function createMockDeploymentAggregate(overrides: Partial<DeploymentAggregate> = {}): DeploymentAggregate {
  const defaults: DeploymentAggregate = {
    id: 'deployment-123',
    nickname: 'Test Deployment',
    customIpxeScript: false,
    startDate: new Date('2023-01-01T00:00:00.000Z'),
    endDate: null,
    createdAt: new Date('2023-01-01T00:00:00.000Z'),
    updatedAt: new Date('2023-01-01T00:00:00.000Z'),
    type: 'SELF_SERVICE' as any,
    serverId: 'brokkr-server-123',
    reservationId: 'reservation-123',
    scheduledInterruptionTime: null,
    isInterruptible: false,
    interruptibleNoticePeriod: null,
    deployerId: 'user-123',
    customerId: 'customer-123',
    baseLayerId: 'layer-123',
    rescueLayerId: null,
    deploymentProjectId: 'project-123',
    isLocked: false,
    publicIpAddressId: null,
    privateIpAddressId: null,
    cloudInitStorageBlock: null,
    cloudInitNetworkBlock: null,
    cloudInitLateCommands: null,
    diskEncryptionEnabled: false,
    gpuDriversEnabled: false,
    server: {
      id: 'brokkr-server-123',
      deviceId: 'brokkr-device-123',
      lifecycleStatus: 'PROVISIONED' as any,
      powerStatus: ServerPowerStatus.On,
      ipxeBuildTarget: null,
      ipxeBuildVersion: null,
      purgeTtys: null,
      storageLayouts: {
        configs: [
          {
            disks: [
              { wwn: '0x3001438038d17d50', name: 'sda', serial: 'BTHC5456011D800NGN' },
              { wwn: '0x3001438038d17d51', name: 'sdb', serial: 'BTHC710406MF800NGN' },
            ],
            disk_type: 'ssd',
            num_disks: 2,
            capabilities: ['lvm', 'raid0', 'raid1'],
            file_systems: ['ext4', 'xfs'],
            size_per_disk: 800166076416,
            disk_group_name: 'SSD_800GB',
          },
        ],
        default: {
          os_disks_group: {
            group: 'SSD_800GB',
            config: 'lvm',
            mountpoint: '/',
            file_system: 'ext4',
          },
          data_disks_groups: [],
          cold_storage_disks_groups: [],
        },
      },
      netplanOverride: null,
      kernelCmdline: null,
      vpcCapable: false,
      teeEnabled: false,
      ecoMode: false,
      configTemplateId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      serversInReservationInvite: [],
      device: {
        id: 'brokkr-device-123',
        name: 'Test Device',
        nickname: null,
        serial: 'SERIAL123',
        status: 'PROVISIONED' as any,
        role: 'Baremetal' as any,
        deviceType: 'Baremetal' as any,
        networkType: 'Public' as any,
        zoneId: null,
        supplierId: 'supplier-123',
        skuId: null,
        deviceModelId: null,
        zone: { name: 'Arizona - Hydra Host', region: { name: 'North America' } },
        lastJobId: null,
        ipmiBootDeviceOverride: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        cpus: [
          { model: 'Intel Xeon', architecture: null, coreCount: 8, threadCount: 16 },
          { model: 'Intel Xeon', architecture: null, coreCount: 8, threadCount: 16 },
        ],
        gpus: [{ model: 'NVIDIA A100' }, { model: 'NVIDIA A100' }, { model: 'NVIDIA A100' }, { model: 'NVIDIA A100' }],
        memoryConfig: { totalSizeMb: 128 * 1024 },
        storageDrives: [
          { type: 'NVME', sizeBytes: BigInt(1_000_000_000_000) },
          { type: 'SSD', sizeBytes: BigInt(500_000_000_000) },
          { type: 'HDD', sizeBytes: BigInt(1_000_000_000_000) },
          { type: 'HDD', sizeBytes: BigInt(1_000_000_000_000) },
        ],
        supplier: {
          id: 'supplier-123',
          name: 'Test Supplier',
          tenantType: 'SupplyCustomer' as any,
          logo: null,
          metadata: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          auth0OrganizationId: null,
          email: null,
          country: null,
          deletedAt: null,
          members: [],
        },
        interfaces: [
          {
            id: 'iface-1',
            name: 'eth0',
            type: null,
            enabled: true,
            mtu: null,
            macAddress: '00:11:22:33:44:55',
            speed: null,
            mgmtOnly: false,
            mode: null,
            description: null,
            linkType: null,
            guid: null,
            portState: null,
            maxSpeedGbps: null,
            pciDeviceId: null,
            lldpNeighborName: null,
            lldpNeighborPort: null,
            lldpNeighborDescr: null,
            lldpNeighborMgmtIp: null,
            deviceId: 'brokkr-device-123',
            lagId: null,
            parentId: null,
            untaggedVlanId: null,
            deletedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            ipAddresses: [
              {
                id: 'ip-1',
                address: '1.2.3.4/24',
                status: 'ACTIVE' as any,
                dnsName: null,
                createdAt: new Date(),
                updatedAt: new Date(),
                deletedAt: null,
                organizationId: 'supplier-123',
                vrfId: null,
                assignedObjectType: null,
                assignedObjectId: null,
                interfaceId: 'iface-1',
              },
              {
                id: 'ip-2',
                address: '2001:db8::1/64',
                status: 'ACTIVE' as any,
                dnsName: null,
                createdAt: new Date(),
                updatedAt: new Date(),
                deletedAt: null,
                organizationId: 'supplier-123',
                vrfId: null,
                assignedObjectType: null,
                assignedObjectId: null,
                interfaceId: 'iface-1',
              },
            ],
          },
        ] as any,
      },
    } as any,
    deployer: {
      id: 'user-123',
      auth0Id: 'auth0-123',
      firstName: 'John',
      lastName: 'Doe',
      email: 'john@test.com',
      emailVerified: true,
      phoneNumber: null,
      phoneNumberVerified: false,
    } as any,
    deploymentKeys: [
      {
        id: 'key-123',
        sshKeyId: 'key-123',
        deploymentId: 'deployment-123',
        sshKey: {
          id: 'key-123',
          key: 'ssh-rsa AAAA...',
          name: 'Test Key',
          fingerprint: 'fingerprint-123',
          userId: 'user-123',
          dateCreated: new Date(),
          dateDeleted: null,
          user: {
            id: 'user-123',
            auth0Id: 'auth0-123',
            firstName: 'John',
            lastName: 'Doe',
            email: 'john@test.com',
            emailVerified: true,
            phoneNumber: null,
            phoneNumberVerified: false,
            members: [],
          },
        },
      },
    ] as any,
    baseLayer: {
      id: 'layer-123',
      slug: 'ubuntu-20.04',
      name: 'Ubuntu 20.04',
      family: 'base',
      kind: 'BASE',
      layerGroupId: 'group-123',
      createdAt: new Date('2023-01-01T00:00:00.000Z'),
      updatedAt: new Date('2023-01-01T00:00:00.000Z'),
    },
    rescueLayer: null,
    lifecycleActions: [],
    lifecycleRequests: [],
    lifecycleJobs: [],
    deviceDiagnostics: [],
    deploymentProject: {
      id: 'project-123',
      name: 'Test Project',
      isDefault: false,
      organizationId: 'customer-123',
      createdAt: new Date('2023-01-01T00:00:00.000Z'),
      updatedAt: new Date('2023-01-01T00:00:00.000Z'),
      deletedAt: null,
    },
  };

  return deepMerge(defaults, overrides) as DeploymentAggregate;
}

function deepMerge<T extends object>(target: T, source: Partial<T>): T {
  const result = { ...target };
  for (const key of Object.keys(source) as (keyof T)[]) {
    const sourceValue = source[key];
    const targetValue = result[key];
    if (sourceValue !== undefined) {
      if (
        typeof sourceValue === 'object' &&
        sourceValue !== null &&
        !Array.isArray(sourceValue) &&
        !(sourceValue instanceof Date) &&
        !(sourceValue instanceof Prisma.Decimal)
      ) {
        result[key] = deepMerge(targetValue as object, sourceValue as object) as T[keyof T];
      } else {
        result[key] = sourceValue as T[keyof T];
      }
    }
  }
  return result;
}
