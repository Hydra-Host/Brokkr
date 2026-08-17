import { DeviceRole, InterfaceType, ServerPowerStatus } from '@repo/database';
import { type CustomizationCatalog } from '@repo/layers';
import { DeviceAggregate } from 'src/common/device.types';
import { describe, expect, it } from 'vitest';
import { BaremetalPresenter } from '../baremetal.presenter';

function createMinimalAggregate(overrides: Partial<DeviceAggregate> = {}): DeviceAggregate {
  return {
    id: 'device-1',
    name: 'test-device',
    nickname: null,
    serial: 'SN-001',
    status: 'ACTIVE' as any,
    role: DeviceRole.Baremetal,
    deviceType: 'Baremetal' as any,
    networkType: 'Public' as any,
    zoneId: null,
    supplierId: 'supplier-1',
    skuId: null,
    deviceModelId: null,
    lastJobId: null,
    ipmiBootDeviceOverride: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    architecture: null,
    cpus: [],
    gpus: [],
    memoryConfig: null,
    storageDrives: [],
    zone: null,
    interfaces: [],
    supplier: {
      id: 'supplier-1',
      name: 'Test Supplier',
      tenantId: 'tenant-1',
      tenantType: 'SupplyCustomer' as any,
      logo: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      auth0OrganizationId: null,
      email: null,
      country: null,
      deletedAt: null,
    } as any,
    server: {
      id: 'server-1',
      deviceId: 'device-1',
      lifecycleStatus: 'INVENTORY' as any,
      powerStatus: ServerPowerStatus.Off,
      ipxeBuildTarget: null,
      ipxeBuildVersion: null,
      purgeTtys: null,
      storageLayouts: null,
      netplanOverride: null,
      kernelCmdline: null,
      vpcCapable: false,
      teeEnabled: false,
      ecoMode: false,
      configTemplateId: null,
      hourlyPrice: null,
      floorHourlyPrice: null,
      isInterruptible: false,
      isListed: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      deployments: [],
      serversInReservationInvite: [],
    } as any,
    ...overrides,
  } as DeviceAggregate;
}

describe('BaremetalPresenter', () => {
  describe('toResponse', () => {
    it('passes base layers through from catalog without transformation', () => {
      const aggregate = createMinimalAggregate();
      const catalog: CustomizationCatalog = {
        bases: [
          { id: 'l-1', slug: 'ubuntu-noble', name: 'Ubuntu Noble', family: 'base' },
          { id: 'l-2', slug: 'debian-bookworm', name: 'Debian Bookworm', family: 'base' },
        ],
        componentsByBase: {},
      };

      const result = BaremetalPresenter.toResponse(aggregate, catalog);

      expect(result.availableBaseLayers).toEqual([
        { id: 'l-1', slug: 'ubuntu-noble', name: 'Ubuntu Noble', family: 'base' },
        { id: 'l-2', slug: 'debian-bookworm', name: 'Debian Bookworm', family: 'base' },
      ]);
    });

    it('returns empty availableBaseLayers when no catalog is provided', () => {
      const aggregate = createMinimalAggregate();

      const result = BaremetalPresenter.toResponse(aggregate);

      expect(result.availableBaseLayers).toEqual([]);
    });

    it('returns empty availableBaseLayers when catalog has empty bases', () => {
      const aggregate = createMinimalAggregate();
      const catalog: CustomizationCatalog = { bases: [], componentsByBase: {} };

      const result = BaremetalPresenter.toResponse(aggregate, catalog);

      expect(result.availableBaseLayers).toEqual([]);
    });

    it('maps interfaces with null macAddress to empty string and includes ip_addresses', () => {
      const aggregate = createMinimalAggregate({
        interfaces: [
          {
            id: 'iface-1',
            name: 'eth0',
            type: InterfaceType.ETHERNET_10G,
            enabled: true,
            mtu: null,
            macAddress: null,
            speed: null,
            mgmtOnly: false,
            markConnected: true,
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
            driver: null,
            operstate: null,
            linkOperUp: null,
            linkPhysicalUp: null,
            deviceId: 'device-1',
            lagId: null,
            parentId: null,
            untaggedVlanId: null,
            deletedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            ipAddresses: [
              {
                id: 'ip-1',
                address: '10.0.0.5',
                status: 'ACTIVE' as any,
                dnsName: null,
                createdAt: new Date(),
                updatedAt: new Date(),
                deletedAt: null,
                organizationId: 'supplier-1',
                vrfId: null,
                assignedObjectType: null,
                assignedObjectId: null,
                interfaceId: 'iface-1',
                natInsideId: null,
              },
            ],
          },
        ],
      });

      const result = BaremetalPresenter.toResponse(aggregate);

      expect(result.interfaces).toEqual([
        {
          name: 'eth0',
          type: InterfaceType.ETHERNET_10G,
          mac_address: '',
          ip_addresses: [{ id: 'ip-1', address: '10.0.0.5' }],
          mark_connected: true,
          enabled: true,
          mgmt_only: false,
        },
      ]);
    });
  });
});
