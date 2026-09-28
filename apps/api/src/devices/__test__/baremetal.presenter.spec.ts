import { BillingFrequency, DeviceRole, InterfaceType, ServerPowerStatus } from '@repo/database';
import { type CustomizationCatalog } from '@repo/layers';
import { DeviceAggregate } from 'src/common/device.types';
import { describe, expect, it } from 'vitest';
import { BaremetalPresenter } from '../baremetal.presenter';

function createMinimalAggregate(
  overrides: Partial<DeviceAggregate> = {},
  deployments: unknown[] = [],
): DeviceAggregate {
  return {
    id: 'device-1',
    name: 'test-device',
    nickname: null,
    serial: 'SN-001',
    status: 'ACTIVE' as any,
    role: DeviceRole.Baremetal,
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
      deployments,
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

    it('exposes the active deployment id for the deployment page', () => {
      const aggregate = createMinimalAggregate({}, [
        {
          id: 'dep-1',
          nickname: null,
          startDate: new Date('2026-09-16T10:00:00.000Z'),
          endDate: null,
          deployer: null,
          reservation: null,
        },
      ]);

      const result = BaremetalPresenter.toResponse(aggregate);

      expect(result.deployment?.id).toBe('dep-1');
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

    it('includes deployerEmail when the reservation invite belongs to the supplier', () => {
      const result = BaremetalPresenter.toResponse(createDeployedAggregate('supplier-1'));
      expect(result.deployment?.deployerEmail).toBe('buyer@example.com');
    });

    it('redacts deployerEmail when the reservation has no invite', () => {
      const result = BaremetalPresenter.toResponse(createDeployedAggregate(null));
      expect(result.deployment?.deployerEmail).toBeNull();
    });

    it('redacts deployerEmail when the invite belongs to another org', () => {
      const result = BaremetalPresenter.toResponse(createDeployedAggregate('hydra-org'));
      expect(result.deployment?.deployerEmail).toBeNull();
    });
  });
});

function createDeployedAggregate(inviteOrganizationId: string | null): DeviceAggregate {
  const reservationInvite =
    inviteOrganizationId === null
      ? null
      : {
          id: 'invite-1',
          inviteeEmail: 'buyer@example.com',
          inviterEmail: 'sales@supplier.com',
          inviteeOrganizationId: null,
          price: 100,
          billingFrequency: BillingFrequency.WEEKLY,
          manualBilling: false,
          interruptibleNoticePeriod: null,
          notes: null,
          dateAccepted: new Date('2026-01-02'),
          dateCreated: new Date('2026-01-01'),
          dateDeleted: null,
          dateExpires: new Date('2027-01-01'),
          dateUpdated: null,
          organizationId: inviteOrganizationId,
          reservationId: 'res-1',
        };

  return createMinimalAggregate({}, [
    {
      id: 'dep-1',
      nickname: '',
      startDate: new Date('2026-01-01'),
      endDate: null,
      deployer: { email: 'buyer@example.com' },
      reservation: {
        id: 'res-1',
        price: 100,
        billingFrequency: BillingFrequency.WEEKLY,
        reservationInvite,
      },
    },
  ]);
}
