import { DeviceRole, DeviceStatus, Prisma } from '@repo/database';
import { AuthType, IdentityContext } from 'src/auth/identity-context';
import { DeviceAggregate } from 'src/common/device.types';
import {
  mockDeployment,
  mockReservationInvite,
  mockServersInReservationInvite,
  mockSupplyOrganization,
} from 'src/prisma/fixtures';
import { InventoryListingContext, InventoryPresenter } from '../inventory.presenter';
import { mockBaseLayers, mockComponentsByBase } from './fixtures';

const mockDevice: DeviceAggregate = {
  id: 'test-device-uuid',
  name: 'test-device',
  nickname: null,
  serial: null,
  status: DeviceStatus.ACTIVE,
  server: {
    lifecycleStatus: 'INVENTORY',
    isListed: true,
    deployments: [],
    serversInReservationInvite: [],
  },
  powerStatus: 'Running',
  role: DeviceRole.Baremetal,
  deviceType: null,
  cpuModel: 'Intel Xeon',
  cpuThreadCount: 64,
  cpuCoreCount: 32,
  cpuPhysicalCount: 2,
  memory: 256,
  nvmeSize: 1000,
  nvmeCount: 2,
  ssdSize: null,
  ssdCount: null,
  hddSize: null,
  hddCount: null,
  gpuModel: 'H100',
  gpuCount: 8,
  networkType: 'Public',
  vpcCapable: false,
  ecoMode: false,
  teeEnabled: false,
  ipxeBuildTarget: null,
  ipxeBuildVersion: null,
  purgeTtys: null,
  serialPorts: null,
  storageLayouts: {},
  hourlyPrice: new Prisma.Decimal(100),
  floorHourlyPrice: new Prisma.Decimal(80),
  isListed: true,
  isInterruptible: false,
  zoneId: 'zone-uuid',
  supplierId: mockSupplyOrganization.id,
  skuId: null,
  deviceModelId: null,
  zone: { name: 'us-east-1a', region: { name: 'US East' } },
  lastJobId: null,
  ipmiBootDeviceOverride: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  supplier: mockSupplyOrganization,
  deployments: [],
  devicesInReservationInvite: [],
  storageDrives: [],
} as any;

describe('InventoryPresenter', () => {
  const createMockContext = (overrides: Partial<InventoryListingContext> = {}): InventoryListingContext => ({
    device: mockDevice,
    reservationInvites: [],
    deployments: [],
    ...overrides,
  });

  describe('isListable', () => {
    it('returns true when there are no active deployments', () => {
      const ctx = createMockContext({ deployments: [] });
      expect(InventoryPresenter.isListable(ctx)).toBe(true);
    });

    it('returns true when all deployments have ended', () => {
      const endedDeployment = { ...mockDeployment, endDate: new Date() };
      const ctx = createMockContext({ deployments: [endedDeployment] });
      expect(InventoryPresenter.isListable(ctx)).toBe(true);
    });

    it('returns false when a non-interruptible active deployment exists', () => {
      const activeDeployment = { ...mockDeployment, endDate: null, isInterruptible: false };
      const ctx = createMockContext({ deployments: [activeDeployment] });
      expect(InventoryPresenter.isListable(ctx)).toBe(false);
    });

    it('returns true when the active deployment is interruptible (re-rentable via eviction)', () => {
      const activeDeployment = { ...mockDeployment, endDate: null, isInterruptible: true };
      const ctx = createMockContext({ deployments: [activeDeployment] });
      expect(InventoryPresenter.isListable(ctx)).toBe(true);
    });
  });

  describe('stockStatus', () => {
    it('reports "on demand" for a listed inventory host with no active deployment', () => {
      const ctx = createMockContext({ deployments: [] });
      expect(InventoryPresenter.stockStatus(ctx)).toBe('on demand');
    });

    it('reports "reserve" when a non-interruptible active deployment occupies the host', () => {
      const activeDeployment = { ...mockDeployment, endDate: null, isInterruptible: false };
      const ctx = createMockContext({ deployments: [activeDeployment] });
      expect(InventoryPresenter.stockStatus(ctx)).toBe('reserve');
    });

    it('reports "on demand" when an interruptible deployment occupies a listed host', () => {
      const activeDeployment = { ...mockDeployment, endDate: null, isInterruptible: true };
      const ctx = createMockContext({ deployments: [activeDeployment] });
      expect(InventoryPresenter.stockStatus(ctx)).toBe('on demand');
    });
  });

  describe('availableAt', () => {
    it('always returns the current time (deployment-centric: no interruptible notice)', () => {
      const before = Date.now();
      const result = new Date(InventoryPresenter.availableAt()).getTime();
      const after = Date.now();
      expect(result).toBeGreaterThanOrEqual(before);
      expect(result).toBeLessThanOrEqual(after);
    });
  });

  describe('toResponse', () => {
    it('reports interruptible defaults when no active deployment', () => {
      const ctx = createMockContext({ deployments: [] });
      const result = InventoryPresenter.toResponse(ctx);
      expect(result.isInterruptibleDeployment).toBe(false);
      expect(result.interruptibleNoticePeriod).toBeNull();
    });

    it('reads isInterruptibleDeployment / interruptibleNoticePeriod off the active deployment', () => {
      const activeDeployment = {
        ...mockDeployment,
        endDate: null,
        isInterruptible: true,
        interruptibleNoticePeriod: 600_000,
      };
      const ctx = createMockContext({ deployments: [activeDeployment] });
      const result = InventoryPresenter.toResponse(ctx);
      expect(result.isInterruptibleDeployment).toBe(true);
      expect(result.interruptibleNoticePeriod).toBe(600_000);
    });
  });

  describe('activeReservationInvite gate', () => {
    const buyerOrgId = 'buyer-org-id';
    const inviterEmail = 'inviter@example.com';
    const inviteeEmail = 'invitee@example.com';

    const activeInvite = {
      ...mockReservationInvite,
      dateAccepted: null,
      dateDeleted: null,
      dateExpires: new Date(Date.now() + 7 * 24 * 3.6e6),
      inviteeOrganizationId: buyerOrgId,
      inviteeEmail,
      inviterEmail,
      inviteeOrganization: { id: buyerOrgId, name: 'Buyer Org' },
    };

    const deviceWithInvite: DeviceAggregate = {
      ...mockDevice,
      supplierId: mockSupplyOrganization.id,
      server: {
        ...mockDevice.server,
        serversInReservationInvite: [{ reservationInvite: activeInvite }],
      },
    } as any;

    const ctxWithInvite = createMockContext({ device: deviceWithInvite });

    const identityForOrg = (organizationId: string, email: string): IdentityContext =>
      ({
        authType: AuthType.Session,
        organizationId,
        session: { user: { email } },
      }) as any;

    it('attaches the invite in full for the buyer (invitee) party', () => {
      const buyer = identityForOrg(buyerOrgId, inviteeEmail);
      const result = InventoryPresenter.toResponse(ctxWithInvite, buyer);
      expect(result.activeReservationInvite?.id).toBe(activeInvite.id);
      expect(result.activeReservationInvite?.inviteeEmail).toBe(inviteeEmail);
      expect(result.activeReservationInvite?.inviteeOrganization?.id).toBe(buyerOrgId);
    });

    it('shows buyer email/price to the supplier party but hides the buyer org', () => {
      const supplier = identityForOrg(mockSupplyOrganization.id, inviterEmail);
      const result = InventoryPresenter.toResponse(ctxWithInvite, supplier);
      expect(result.activeReservationInvite?.inviteeEmail).toBe(inviteeEmail);
      expect(result.activeReservationInvite?.inviterEmail).toBe(inviterEmail);
      expect(result.activeReservationInvite?.inviteeOrganization).toBeNull();
    });

    it('handles email-only invites (null inviteeOrganization) on the non-redacted path', () => {
      const emailOnlyInvite = { ...activeInvite, inviteeOrganizationId: null, inviteeOrganization: null };
      const ctx = createMockContext({
        device: {
          ...deviceWithInvite,
          server: {
            ...deviceWithInvite.server,
            serversInReservationInvite: [{ reservationInvite: emailOnlyInvite }],
          },
        } as any,
      });
      const buyer = identityForOrg('some-other-org', inviteeEmail);
      const result = InventoryPresenter.toResponse(ctx, buyer);
      expect(result.activeReservationInvite?.id).toBe(activeInvite.id);
      expect(result.activeReservationInvite?.inviteeOrganization).toBeNull();
    });

    it('returns null for an unrelated identity', () => {
      const unrelated = identityForOrg('unrelated-org-id', 'someone@elsewhere.com');
      const result = InventoryPresenter.toResponse(ctxWithInvite, unrelated);
      expect(result.activeReservationInvite).toBeNull();
    });

    it('returns null for an anonymous viewer (no identity)', () => {
      const result = InventoryPresenter.toResponse(ctxWithInvite);
      expect(result.activeReservationInvite).toBeNull();
    });
  });

  describe('isListedOrInvitee', () => {
    const buyerOrgId = 'buyer-org';
    const buyerEmail = 'buyer@test.com';
    const otherOrgId = 'other-org';
    const otherEmail = 'other@test.com';

    const identityForOrg = (organizationId: string, email: string): IdentityContext =>
      ({
        authType: AuthType.Session,
        organizationId,
        session: { user: { email } },
      }) as IdentityContext;

    function contextWith(
      isListed: boolean,
      invite?: {
        orgId: string | null;
        email: string | null;
        dateAccepted?: Date | null;
        dateDeleted?: Date | null;
        dateExpires?: Date;
      },
    ) {
      const serversInReservationInvite = invite
        ? [
            {
              ...mockServersInReservationInvite,
              reservationInvite: {
                ...mockReservationInvite,
                inviteeOrganizationId: invite.orgId,
                inviteeEmail: invite.email,
                inviteeOrganization: mockSupplyOrganization,
                dateAccepted: invite.dateAccepted ?? null,
                dateDeleted: invite.dateDeleted ?? null,
                dateExpires: invite.dateExpires ?? new Date(Date.now() + 86_400_000),
              },
            },
          ]
        : [];

      return createMockContext({
        device: {
          ...mockDevice,
          server: {
            ...mockDevice.server,
            isListed,
            serversInReservationInvite,
          },
        },
      });
    }

    const caller = identityForOrg(buyerOrgId, buyerEmail);

    it('denies unlisted hosts with no invite', () => {
      expect(InventoryPresenter.isListedOrInvitee(contextWith(false), caller)).toBe(false);
    });

    it('allows unlisted hosts when the caller is the invitee', () => {
      expect(
        InventoryPresenter.isListedOrInvitee(contextWith(false, { orgId: buyerOrgId, email: buyerEmail }), caller),
      ).toBe(true);
    });

    it('allows listed hosts with no invite', () => {
      expect(InventoryPresenter.isListedOrInvitee(contextWith(true), caller)).toBe(true);
    });

    it('denies listed hosts when the pending invite belongs to someone else', () => {
      expect(
        InventoryPresenter.isListedOrInvitee(contextWith(true, { orgId: otherOrgId, email: otherEmail }), caller),
      ).toBe(false);
    });

    it('allows listed hosts when the pending invite belongs to the caller', () => {
      expect(InventoryPresenter.isListedOrInvitee(contextWith(true, { orgId: buyerOrgId, email: null }), caller)).toBe(
        true,
      );
    });

    it('allows unlisted hosts when invitee email differs only by case or whitespace', () => {
      expect(
        InventoryPresenter.isListedOrInvitee(contextWith(false, { orgId: null, email: ' Buyer@Test.com ' }), caller),
      ).toBe(true);
    });

    it('denies unlisted hosts when the invitee email does not match', () => {
      expect(InventoryPresenter.isListedOrInvitee(contextWith(false, { orgId: null, email: otherEmail }), caller)).toBe(
        false,
      );
    });

    it('allows unlisted hosts when the caller is the supplier party', () => {
      const supplier = identityForOrg(mockSupplyOrganization.id, 'inviter@example.com');
      expect(
        InventoryPresenter.isListedOrInvitee(contextWith(false, { orgId: buyerOrgId, email: buyerEmail }), supplier),
      ).toBe(true);
    });

    it('allows unlisted hosts when the caller matches the inviter email', () => {
      const inviter = identityForOrg('not-the-supplier', mockReservationInvite.inviterEmail);
      expect(
        InventoryPresenter.isListedOrInvitee(contextWith(false, { orgId: otherOrgId, email: otherEmail }), inviter),
      ).toBe(true);
    });

    it('denies unlisted hosts when the pending invite is expired', () => {
      expect(
        InventoryPresenter.isListedOrInvitee(
          contextWith(false, {
            orgId: buyerOrgId,
            email: buyerEmail,
            dateExpires: new Date(Date.now() - 1_000),
          }),
          caller,
        ),
      ).toBe(false);
    });

    it('denies unlisted hosts when the invite was deleted', () => {
      expect(
        InventoryPresenter.isListedOrInvitee(
          contextWith(false, { orgId: buyerOrgId, email: buyerEmail, dateDeleted: new Date() }),
          caller,
        ),
      ).toBe(false);
    });

    it('denies unlisted hosts when the invite was accepted', () => {
      expect(
        InventoryPresenter.isListedOrInvitee(
          contextWith(false, { orgId: buyerOrgId, email: buyerEmail, dateAccepted: new Date() }),
          caller,
        ),
      ).toBe(false);
    });

    it('allows listed hosts when a leftover invite is no longer active', () => {
      expect(
        InventoryPresenter.isListedOrInvitee(
          contextWith(true, {
            orgId: otherOrgId,
            email: otherEmail,
            dateExpires: new Date(Date.now() - 1_000),
          }),
          caller,
        ),
      ).toBe(true);
    });

    it('allows unlisted hosts for ApiKey callers matched by user email', () => {
      const apiKeyCaller = {
        authType: AuthType.ApiKey,
        organizationId: buyerOrgId,
        user: { email: buyerEmail },
      } as IdentityContext;

      expect(
        InventoryPresenter.isListedOrInvitee(contextWith(false, { orgId: null, email: buyerEmail }), apiKeyCaller),
      ).toBe(true);
    });
  });

  describe('catalog → availableBaseLayers / availableComponentLayersByBase', () => {
    it('maps catalog.bases to availableBaseLayers', () => {
      const ctx = createMockContext({ catalog: { bases: mockBaseLayers as never, componentsByBase: {} } });
      const result = InventoryPresenter.toResponse(ctx);
      expect(result.availableBaseLayers).toEqual(mockBaseLayers);
    });

    it('maps catalog.componentsByBase to availableComponentLayersByBase', () => {
      const ctx = createMockContext({
        catalog: { bases: mockBaseLayers as never, componentsByBase: mockComponentsByBase as never },
      });
      const result = InventoryPresenter.toResponse(ctx);
      expect(result.availableComponentLayersByBase).toEqual(mockComponentsByBase);
    });

    it('defaults to empty arrays when catalog is undefined', () => {
      const ctx = createMockContext({ catalog: undefined });
      const result = InventoryPresenter.toResponse(ctx);
      expect(result.availableBaseLayers).toEqual([]);
      expect(result.availableComponentLayersByBase).toEqual({});
    });

    it('defaults to empty arrays when catalog has empty bases', () => {
      const ctx = createMockContext({ catalog: { bases: [], componentsByBase: {} } });
      const result = InventoryPresenter.toResponse(ctx);
      expect(result.availableBaseLayers).toEqual([]);
      expect(result.availableComponentLayersByBase).toEqual({});
    });
  });
});
