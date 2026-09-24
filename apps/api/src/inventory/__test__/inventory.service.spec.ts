import { InventoryVisibilityFilterRegistry } from '@hydrahost/plugin-sdk';
import { resetInventoryVisibilityFiltersForTest } from '@hydrahost/plugin-sdk/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { RequestSource, WebhookEventType } from '@repo/database';
import { buildCustomizationCatalog, LayerRecord, resolveZoneBuildId } from '@repo/layers';
import { ContractType } from '@repo/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthType, IdentityContext } from '../../auth/identity-context';
import { InventoryListingContext, InventoryPresenter } from '../inventory.presenter';
import { InventoryRecord } from '../inventory.record';
import { InventoryService } from '../inventory.service';

vi.mock('@repo/layers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@repo/layers')>()),
  buildCustomizationCatalog: vi.fn(),
  resolveZoneBuildId: vi.fn(async () => null),
}));

const buildAggregate = (activeDeployment: { isInterruptible: boolean; customerId: string } | null) => ({
  id: 'device-1',
  server: {
    isListed: true,
    deployments: activeDeployment ? [{ endDate: null, ...activeDeployment }] : [],
    serversInReservationInvite: [],
  },
});

describe('InventoryService.provisionDirectProvisionDevice routing', () => {
  const identity = {
    organizationId: 'incoming-org',
    authType: 'Session' as const,
    session: { user: { email: 'a@b.c' } },
  };
  const contextService = {
    requireIdentity: identity,
    userId: 'user-1',
    organizationId: 'incoming-org',
    requestSource: RequestSource.API,
    requirePermission: vi.fn(),
  };
  const lifecycleService = {
    requestProvision: vi.fn().mockResolvedValue({ data: { id: 'job-1' } }),
    requestInterruptibleProvision: vi.fn().mockResolvedValue({ status: 'pending_approval', requestId: 'req-1' }),
  };
  const cloudInitTemplatesService = { resolveAndSave: vi.fn().mockResolvedValue('cloud-init') };
  const cloudInitProcessor = { process: vi.fn().mockReturnValue('processed') };
  const provisionValidator = { validate: vi.fn(), validateCustomizations: vi.fn().mockResolvedValue(undefined) };
  const logger = { warn: vi.fn(), error: vi.fn(), log: vi.fn() };

  let service: InventoryService;

  const baseData = {
    deviceId: 'device-1',
    deploymentName: 'box',
    operatingSystem: 'ubuntu-22',
    sshKeyIds: ['k1'],
    diskLayouts: [],
    contractType: ContractType.RESERVED_ROLLING,
    isInterruptible: false,
    projectId: undefined,
    ipxeUrl: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    service = new InventoryService(
      {} as never,
      {} as never,
      lifecycleService as never,
      contextService as never,
      {} as never,
      cloudInitProcessor as never,
      provisionValidator as never,
      cloudInitTemplatesService as never,
      logger as never,
    );
  });

  afterEach(() => vi.restoreAllMocks());

  it('routes a free host to requestProvision with isInterruptible=false', async () => {
    vi.spyOn(InventoryRecord, 'findListableById').mockResolvedValue(buildAggregate(null) as never);

    const result = await service.provisionDirectProvisionDevice({ ...baseData });

    expect(lifecycleService.requestProvision).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'device-1',
        organizationId: 'incoming-org',
        isInterruptible: false,
        tee: false,
      }),
    );
    expect(lifecycleService.requestInterruptibleProvision).not.toHaveBeenCalled();
    expect(result).toEqual({ jobId: 'job-1' });
  });

  it('forwards the device storageDrives to the provision validator', async () => {
    const storageDrives = [{ id: 'drive-1', name: 'nvme0n1' }];
    const aggregate = { ...buildAggregate(null), storageDrives };
    vi.spyOn(InventoryRecord, 'findListableById').mockResolvedValue(aggregate as never);

    await service.provisionDirectProvisionDevice({ ...baseData });

    expect(provisionValidator.validate).toHaveBeenCalledWith({ ...baseData }, storageDrives);
  });

  it('defaults omitted contractType to Reserved Rolling and provisions', async () => {
    vi.spyOn(InventoryRecord, 'findListableById').mockResolvedValue(buildAggregate(null) as never);

    await service.provisionDirectProvisionDevice({
      ...baseData,
      contractType: undefined,
      isInterruptible: undefined,
    });

    expect(lifecycleService.requestProvision).toHaveBeenCalledWith(
      expect.objectContaining({ isInterruptible: false }),
    );
  });

  it('rejects explicit On Demand with the Reserved Rolling message', async () => {
    vi.spyOn(InventoryRecord, 'findListableById').mockResolvedValue(buildAggregate(null) as never);

    await expect(
      service.provisionDirectProvisionDevice({ ...baseData, contractType: ContractType.ON_DEMAND, isInterruptible: false }),
    ).rejects.toMatchObject({
      response: {
        message: "This device isn't available for On Demand contract type, please use Reserved Rolling",
      },
    });
  });

  it('rejects Interruptible requests with the Reserved Rolling message', async () => {
    vi.spyOn(InventoryRecord, 'findListableById').mockResolvedValue(buildAggregate(null) as never);

    await expect(
      service.provisionDirectProvisionDevice({ ...baseData, contractType: ContractType.INTERRUPTIBLE, isInterruptible: true }),
    ).rejects.toMatchObject({
      response: {
        message: "This device isn't available for Interruptible contract type, please use Reserved Rolling",
      },
    });
  });

  it('accepts Reserved Rolling and provisions with isInterruptible=false', async () => {
    vi.spyOn(InventoryRecord, 'findListableById').mockResolvedValue(buildAggregate(null) as never);

    await service.provisionDirectProvisionDevice({ ...baseData, contractType: ContractType.RESERVED_ROLLING });

    expect(lifecycleService.requestProvision).toHaveBeenCalledWith(
      expect.objectContaining({ isInterruptible: false }),
    );
  });

  it('rejects interruptible takeover attempts because only Reserved Rolling is accepted', async () => {
    const aggregate = buildAggregate({ isInterruptible: true, customerId: 'outgoing-org' });
    vi.spyOn(InventoryRecord, 'findListableById').mockResolvedValue(aggregate as never);

    await expect(
      service.provisionDirectProvisionDevice({ ...baseData, isInterruptible: true, contractType: undefined }),
    ).rejects.toMatchObject({
      response: {
        message: "This device isn't available for Interruptible contract type, please use Reserved Rolling",
      },
    });
    expect(lifecycleService.requestInterruptibleProvision).not.toHaveBeenCalled();
    expect(lifecycleService.requestProvision).not.toHaveBeenCalled();
  });

  it('rejects Reserved Rolling takeover of another org interruptible host with a clear message', async () => {
    const aggregate = buildAggregate({ isInterruptible: true, customerId: 'outgoing-org' });
    vi.spyOn(InventoryRecord, 'findListableById').mockResolvedValue(aggregate as never);

    await expect(
      service.provisionDirectProvisionDevice({ ...baseData, contractType: ContractType.RESERVED_ROLLING }),
    ).rejects.toMatchObject({
      response: {
        message:
          'This host is occupied by an interruptible deployment; interruptible takeovers are unavailable until commerce billing is ready',
      },
    });
    expect(lifecycleService.requestInterruptibleProvision).not.toHaveBeenCalled();
    expect(lifecycleService.requestProvision).not.toHaveBeenCalled();
  });

  it('does not treat the same org re-provisioning its own interruptible host as a takeover', async () => {
    const aggregate = buildAggregate({ isInterruptible: true, customerId: 'incoming-org' });
    vi.spyOn(InventoryRecord, 'findListableById').mockResolvedValue(aggregate as never);

    await service.provisionDirectProvisionDevice({ ...baseData });

    expect(lifecycleService.requestProvision).toHaveBeenCalled();
    expect(lifecycleService.requestInterruptibleProvision).not.toHaveBeenCalled();
  });

  it('propagates BadRequestException from resolveZoneBuildId on provision', async () => {
    vi.spyOn(InventoryRecord, 'findListableById').mockResolvedValue(buildAggregate(null) as never);
    vi.mocked(resolveZoneBuildId).mockRejectedValueOnce(new BadRequestException('zone deleted'));

    await expect(service.provisionDirectProvisionDevice({ ...baseData })).rejects.toThrow(BadRequestException);

    expect(lifecycleService.requestProvision).not.toHaveBeenCalled();
  });
});

describe('InventoryService.triggerListingEvent webhook payload', () => {
  const invite = {
    id: 'invite-1',
    inviteeEmail: 'invitee@tenant.example',
    inviterEmail: 'inviter@tenant.example',
    inviteeOrganizationId: 'org-1',
    dateAccepted: null,
    dateDeleted: null,
    dateExpires: new Date(Date.now() + 7 * 24 * 3.6e6),
    dateCreated: new Date(),
    price: 100,
    billingFrequency: 'MONTHLY',
    interruptibleNoticePeriod: null,
    inviteeOrganization: {
      id: 'org-1',
      name: 'Counterparty Org',
      auth0OrganizationId: 'auth0-secret',
      metadata: { secret: true },
      deletedAt: null,
      email: 'org@tenant.example',
      country: 'US',
    },
  };

  const aggregateWithInvite = {
    id: 'device-1',
    name: 'host-1',
    role: 'Baremetal',
    server: {
      lifecycleStatus: 'INVENTORY',
      isListed: true,
      deployments: [],
      serversInReservationInvite: [{ reservationInvite: invite }],
    },
  };

  const counterpartyIdentity = {
    authType: AuthType.Session,
    organizationId: invite.inviteeOrganizationId,
    session: { user: { email: invite.inviteeEmail } },
  } as unknown as IdentityContext;

  const ctxFromAggregate = (): InventoryListingContext => ({
    device: aggregateWithInvite as never,
    reservationInvites: aggregateWithInvite.server.serversInReservationInvite.map(
      (dir) => dir.reservationInvite,
    ) as never,
    deployments: aggregateWithInvite.server.deployments as never,
  });

  const scheduleDelivery = vi.fn().mockResolvedValue(undefined);
  const webhookDeliveryService = { scheduleDelivery };
  const webhookRepo = { findMany: vi.fn().mockResolvedValue([{ id: 'wh-1' }]) };
  const logger = { warn: vi.fn(), error: vi.fn(), log: vi.fn() };

  let service: InventoryService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new InventoryService(
      webhookDeliveryService as never,
      webhookRepo as never,
      {} as never,
      { identity: counterpartyIdentity } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      logger as never,
    );
    vi.spyOn(InventoryRecord, 'findById').mockResolvedValue(aggregateWithInvite as never);
    vi.spyOn(LayerRecord, 'findBaseLayerSummaries').mockResolvedValue([]);
  });

  afterEach(() => vi.restoreAllMocks());

  it('surfaces activeReservationInvite to the counterparty identity (fixture invite is active)', () => {
    const listing = InventoryPresenter.toResponse(ctxFromAggregate(), counterpartyIdentity);
    expect(listing.activeReservationInvite).not.toBeNull();
    expect(listing.activeReservationInvite?.id).toBe(invite.id);
  });

  it('emits activeReservationInvite: null even when an active invite exists (system context)', async () => {
    await service.triggerListingEvent(WebhookEventType.DEVICE_LISTING_CREATED, 'device-1');

    expect(scheduleDelivery).toHaveBeenCalledTimes(1);
    const [, eventDto] = scheduleDelivery.mock.calls[0];
    expect(eventDto.data.activeReservationInvite).toBeNull();
  });

  it('never serializes internal invitee-org fields or counterparty emails into the payload', async () => {
    await service.triggerListingEvent(WebhookEventType.DEVICE_LISTING_CREATED, 'device-1');

    const [, eventDto] = scheduleDelivery.mock.calls[0];
    const serialized = JSON.stringify(eventDto.data);
    for (const leak of [
      'auth0-secret',
      'org@tenant.example',
      'invitee@tenant.example',
      'inviter@tenant.example',
      'auth0OrganizationId',
      'deletedAt',
    ]) {
      expect(serialized).not.toContain(leak);
    }
  });
});

describe('InventoryService.provisionDirectProvisionDevice customization validation', () => {
  const identity = {
    organizationId: 'incoming-org',
    authType: 'Session' as const,
    session: { user: { email: 'a@b.c' } },
  };
  const contextService = {
    requireIdentity: identity,
    userId: 'user-1',
    organizationId: 'incoming-org',
    requestSource: RequestSource.API,
    requirePermission: vi.fn(),
  };
  const lifecycleService = {
    requestProvision: vi.fn().mockResolvedValue({ data: { id: 'job-1' } }),
    requestInterruptibleProvision: vi.fn().mockResolvedValue({ status: 'pending_approval', requestId: 'req-1' }),
  };
  const cloudInitTemplatesService = { resolveAndSave: vi.fn().mockResolvedValue('cloud-init') };
  const cloudInitProcessor = { process: vi.fn().mockReturnValue('processed') };
  const provisionValidator = {
    validate: vi.fn(),
    validateCustomizations: vi.fn().mockResolvedValue(undefined),
  };
  const logger = { warn: vi.fn(), error: vi.fn(), log: vi.fn() };

  let service: InventoryService;

  const baseData = {
    deviceId: 'device-1',
    deploymentName: 'box',
    operatingSystem: 'ubuntu-22',
    sshKeyIds: ['k1'],
    diskLayouts: [],
    contractType: ContractType.RESERVED_ROLLING,
    isInterruptible: false,
    projectId: undefined,
    ipxeUrl: null,
  };

  const aggregate = {
    id: 'device-1',
    netboxId: 123,
    gpus: [{ model: 'H100' }],
    server: {
      isListed: true,
      teeEnabled: false,
      deployments: [],
      serversInReservationInvite: [],
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    service = new InventoryService(
      {} as never,
      {} as never,
      lifecycleService as never,
      contextService as never,
      {} as never,
      cloudInitProcessor as never,
      provisionValidator as never,
      cloudInitTemplatesService as never,
      logger as never,
    );
    vi.spyOn(InventoryRecord, 'findListableById').mockResolvedValue(aggregate as never);
  });

  afterEach(() => vi.restoreAllMocks());

  it('calls validateCustomizations with the device hardware and selected OS', async () => {
    const customizations = { gpuDriver: 'nvidia-driver-580' };
    await service.provisionDirectProvisionDevice({ ...baseData, customizations });

    expect(provisionValidator.validateCustomizations).toHaveBeenCalledTimes(1);
    expect(provisionValidator.validateCustomizations).toHaveBeenCalledWith(
      ['nvidia-driver-580'],
      'H100',
      false,
      'ubuntu-22',
      'amd64',
      null,
    );
    expect(lifecycleService.requestProvision).toHaveBeenCalledWith(
      expect.objectContaining({ customizations: ['nvidia-driver-580'] }),
    );
  });

  it('rejects when validateCustomizations throws', async () => {
    provisionValidator.validateCustomizations.mockRejectedValueOnce(
      new BadRequestException('Unknown OS Customization: "bogus-layer"'),
    );

    await expect(
      service.provisionDirectProvisionDevice({
        ...baseData,
        customizations: { gpuDriver: 'bogus-layer' },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(lifecycleService.requestProvision).not.toHaveBeenCalled();
  });

  it('passes null customizations through without rejection', async () => {
    await service.provisionDirectProvisionDevice({ ...baseData, customizations: undefined });

    expect(provisionValidator.validateCustomizations).toHaveBeenCalledWith(
      null,
      expect.anything(),
      expect.anything(),
      'ubuntu-22',
      expect.anything(),
      null,
    );
    expect(lifecycleService.requestProvision).toHaveBeenCalledWith(expect.objectContaining({ tee: false }));
  });

  it('forwards tee: true when device is TEE-capable and OS is iPXE Custom', async () => {
    const teeAggregate = {
      ...aggregate,
      server: {
        ...aggregate.server,
        teeEnabled: true,
        teeCapable: 'TRUE',
      },
    };
    vi.spyOn(InventoryRecord, 'findListableById').mockResolvedValue(teeAggregate as never);

    await service.provisionDirectProvisionDevice({
      ...baseData,
      operatingSystem: 'ipxe-custom',
      tee: true,
    });

    expect(lifecycleService.requestProvision).toHaveBeenCalledWith(expect.objectContaining({ tee: true }));
  });

  it('forwards tee: true on a standard OS when device is TEE-capable', async () => {
    const teeAggregate = {
      ...aggregate,
      server: { ...aggregate.server, teeEnabled: true, teeCapable: 'TRUE' },
    };
    vi.spyOn(InventoryRecord, 'findListableById').mockResolvedValue(teeAggregate as never);

    await service.provisionDirectProvisionDevice({
      ...baseData,
      operatingSystem: 'ubuntu-22',
      tee: true,
    });

    expect(lifecycleService.requestProvision).toHaveBeenCalledWith(expect.objectContaining({ tee: true }));
  });

  it('rejects tee: true when device is not TEE-capable', async () => {
    vi.spyOn(InventoryRecord, 'findListableById').mockResolvedValue(aggregate as never);

    await expect(
      service.provisionDirectProvisionDevice({
        ...baseData,
        operatingSystem: 'ipxe-custom',
        tee: true,
      }),
    ).rejects.toThrow('TEE is not supported on this device');

    expect(lifecycleService.requestProvision).not.toHaveBeenCalled();
  });
});

describe('InventoryService catalog wiring', () => {
  const identity = {
    organizationId: 'org-1',
    authType: 'Session' as const,
    session: { user: { email: 'a@b.c' } },
  };
  const contextService = {
    requireIdentity: identity,
    identity,
    userId: 'user-1',
    organizationId: 'org-1',
    requestSource: RequestSource.API,
  };
  const logger = { warn: vi.fn(), error: vi.fn(), log: vi.fn() };

  const mockBaseLayers = [
    { slug: 'ubuntu-22', name: 'Ubuntu 22.04', kind: 'BASE' },
    { slug: 'debian-12', name: 'Debian 12', kind: 'BASE' },
  ];

  const mockCatalog = {
    bases: mockBaseLayers,
    componentsByBase: { 'ubuntu-22': [{ slug: 'nvidia-driver-580', name: 'NVIDIA Driver 580' }] },
  };

  const aggregate = {
    id: 'device-1',
    netboxId: 123,
    server: {
      lifecycleStatus: 'INVENTORY',
      isListed: true,
      teeEnabled: false,
      deployments: [],
      serversInReservationInvite: [],
    },
  };

  let service: InventoryService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new InventoryService(
      {} as never,
      {} as never,
      {} as never,
      contextService as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      logger as never,
    );
  });

  afterEach(() => vi.restoreAllMocks());

  it('list path uses base-only catalog (no componentsByBase)', async () => {
    vi.spyOn(InventoryRecord, 'findListings').mockResolvedValue([aggregate] as never);
    vi.spyOn(LayerRecord, 'findBaseLayerSummaries').mockResolvedValue(mockBaseLayers as never);

    const result = await service.getListings();

    expect(LayerRecord.findBaseLayerSummaries).toHaveBeenCalledTimes(1);
    expect(result.data[0].availableBaseLayers).toEqual(mockBaseLayers);
    expect(result.data[0].availableComponentLayersByBase).toEqual({});
  });

  it('detail path surfaces the full hydrated catalog', async () => {
    vi.spyOn(InventoryRecord, 'findListableById').mockResolvedValue(aggregate as never);
    vi.mocked(buildCustomizationCatalog).mockResolvedValueOnce(mockCatalog as never);

    const result = await service.getListingById('device-1');

    expect(buildCustomizationCatalog).toHaveBeenCalledTimes(1);
    expect(result.availableBaseLayers).toEqual(mockBaseLayers);
    expect(result.availableComponentLayersByBase).toEqual(mockCatalog.componentsByBase);
  });

  it('layer query failure falls back to empty catalog on list path', async () => {
    vi.spyOn(InventoryRecord, 'findListings').mockResolvedValue([aggregate] as never);
    vi.spyOn(LayerRecord, 'findBaseLayerSummaries').mockRejectedValue(new Error('DB down'));

    const result = await service.getListings();

    expect(result.data[0].availableBaseLayers).toEqual([]);
    expect(result.data[0].availableComponentLayersByBase).toEqual({});
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to load base layers'));
  });

  it('buildCatalog falls soft (empty catalog + error log) when hydration throws', async () => {
    vi.spyOn(InventoryRecord, 'findListableById').mockResolvedValue(aggregate as never);
    vi.spyOn(LayerRecord, 'findBaseLayerSummaries').mockResolvedValue(mockBaseLayers as never);
    vi.mocked(buildCustomizationCatalog).mockRejectedValueOnce(new Error('hydration down'));

    const result = await service.getListingById('device-1');

    expect(buildCustomizationCatalog).toHaveBeenCalledTimes(1);
    expect(result.availableBaseLayers).toEqual([]);
    expect(result.availableComponentLayersByBase).toEqual({});
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to hydrate customization catalog'));
  });

  it('propagates ConflictException from resolveZoneBuildId in buildCatalog (business error, not fail-soft)', async () => {
    vi.spyOn(InventoryRecord, 'findListableById').mockResolvedValue(aggregate as never);
    vi.spyOn(LayerRecord, 'findBaseLayerSummaries').mockResolvedValue(mockBaseLayers as never);
    vi.mocked(resolveZoneBuildId).mockRejectedValueOnce(new ConflictException('no ready build'));

    await expect(service.getListingById('device-1')).rejects.toThrow(ConflictException);
  });

  it('triggerListingEvent includes base layers in webhook payload', async () => {
    vi.spyOn(InventoryRecord, 'findById').mockResolvedValue(aggregate as never);
    vi.spyOn(LayerRecord, 'findBaseLayerSummaries').mockResolvedValue(mockBaseLayers as never);

    const scheduleDelivery = vi.fn().mockResolvedValue(undefined);
    const webhookService = new InventoryService(
      { scheduleDelivery } as never,
      { findMany: vi.fn().mockResolvedValue([{ id: 'wh-1' }]) } as never,
      {} as never,
      contextService as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      logger as never,
    );

    await webhookService.triggerListingEvent(WebhookEventType.DEVICE_LISTING_CREATED, 'device-1');

    expect(LayerRecord.findBaseLayerSummaries).toHaveBeenCalledTimes(1);
    const [, eventDto] = scheduleDelivery.mock.calls[0];
    expect(eventDto.data.availableBaseLayers).toEqual(mockBaseLayers);
    expect(eventDto.data.availableComponentLayersByBase).toEqual({});
  });
});

describe('InventoryService.getListingById invite access', () => {
  const identity = {
    organizationId: 'incoming-org',
    authType: 'Session' as const,
    session: { user: { email: 'a@b.c' } },
  };
  const contextService = {
    requireIdentity: identity,
    identity,
    userId: 'user-1',
    organizationId: 'incoming-org',
    requestSource: RequestSource.API,
  };
  const logger = { warn: vi.fn(), error: vi.fn(), log: vi.fn() };

  const mockCatalog = {
    bases: [{ slug: 'ubuntu-22', name: 'Ubuntu 22.04', kind: 'BASE' }],
    componentsByBase: {},
  };

  const listingAggregate = (inviteeOrganizationId: string | null) => ({
    id: 'device-1',
    supplierId: 'supplier-org',
    zoneId: 'zone-1',
    server: {
      lifecycleStatus: 'INVENTORY',
      isListed: false,
      teeEnabled: false,
      deployments: [],
      serversInReservationInvite: [
        {
          serverId: 'server-1',
          reservationInviteId: 'invite-1',
          reservationInvite: {
            inviteeOrganizationId,
            inviteeEmail: null,
            inviterEmail: 'admin@supplier.com',
            dateAccepted: null,
            dateDeleted: null,
            dateCreated: new Date(),
            dateExpires: new Date(Date.now() + 86_400_000),
            price: 100,
            billingFrequency: 'WEEKLY',
            interruptibleNoticePeriod: null,
            inviteeOrganization: null,
          },
        },
      ],
    },
  });

  let service: InventoryService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new InventoryService(
      {} as never,
      {} as never,
      {} as never,
      contextService as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      logger as never,
    );
  });

  afterEach(() => vi.restoreAllMocks());

  it('allows an invitee to view an unlisted device that has a pending invite', async () => {
    vi.spyOn(InventoryRecord, 'findListableById').mockResolvedValue(listingAggregate('incoming-org') as never);
    vi.mocked(buildCustomizationCatalog).mockResolvedValueOnce(mockCatalog as never);

    await expect(service.getListingById('device-1')).resolves.toMatchObject({ id: 'device-1' });
  });

  it('denies an unrelated caller access to an unlisted device with a pending invite', async () => {
    vi.spyOn(InventoryRecord, 'findListableById').mockResolvedValue(listingAggregate('other-org') as never);

    await expect(service.getListingById('device-1')).rejects.toThrow(NotFoundException);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('InventoryService plugin catalog visibility', () => {
  const identity = {
    organizationId: 'incoming-org',
    authType: 'Session' as const,
    session: { user: { email: 'a@b.c' } },
  };
  const contextService = {
    requireIdentity: identity,
    identity,
    userId: 'user-1',
    organizationId: 'incoming-org',
    requestSource: RequestSource.API,
  };
  const logger = { warn: vi.fn(), error: vi.fn(), log: vi.fn() };

  const listedDevice = {
    id: 'device-1',
    supplierId: 'supplier-org',
    zoneId: 'zone-1',
    server: {
      lifecycleStatus: 'INVENTORY',
      isListed: true,
      teeEnabled: false,
      deployments: [],
      serversInReservationInvite: [],
    },
  };

  const invitedUnlistedDevice = {
    ...listedDevice,
    server: {
      ...listedDevice.server,
      isListed: false,
      serversInReservationInvite: [
        {
          serverId: 'server-1',
          reservationInviteId: 'invite-1',
          reservationInvite: {
            inviteeOrganizationId: 'incoming-org',
            inviteeEmail: null,
            inviterEmail: 'admin@supplier.com',
            dateAccepted: null,
            dateDeleted: null,
            dateCreated: new Date(),
            dateExpires: new Date(Date.now() + 86_400_000),
            price: 100,
            billingFrequency: 'WEEKLY',
            interruptibleNoticePeriod: null,
            inviteeOrganization: null,
          },
        },
      ],
    },
  };

  let service: InventoryService;

  beforeEach(() => {
    vi.clearAllMocks();
    resetInventoryVisibilityFiltersForTest();
    service = new InventoryService(
      {} as never,
      {} as never,
      {} as never,
      contextService as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      logger as never,
    );
  });

  afterEach(() => {
    resetInventoryVisibilityFiltersForTest();
    vi.restoreAllMocks();
  });

  it('shows a listed device when the supplier is onboarded', async () => {
    InventoryVisibilityFilterRegistry.register({
      excludeSuppliers: async () => [],
    });
    vi.spyOn(InventoryRecord, 'listedSupplierIds').mockResolvedValue(['supplier-org']);
    const findListings = vi.spyOn(InventoryRecord, 'findListings').mockResolvedValue([listedDevice] as never);
    vi.spyOn(LayerRecord, 'findBaseLayerSummaries').mockResolvedValue([]);

    const result = await service.getListings();

    expect(findListings).toHaveBeenCalledWith(undefined, undefined, []);
    expect(result.data.map((listing) => listing.id)).toEqual(['device-1']);
  });

  it('hides a listed device when the supplier is not onboarded', async () => {
    InventoryVisibilityFilterRegistry.register({
      excludeSuppliers: async () => ['supplier-org'],
    });
    vi.spyOn(InventoryRecord, 'listedSupplierIds').mockResolvedValue(['supplier-org']);
    const findListings = vi.spyOn(InventoryRecord, 'findListings').mockResolvedValue([]);
    vi.spyOn(LayerRecord, 'findBaseLayerSummaries').mockResolvedValue([]);

    const result = await service.getListings();

    expect(findListings).toHaveBeenCalledWith(undefined, undefined, ['supplier-org']);
    expect(result.data).toEqual([]);
  });

  it('hides listed detail when the supplier is not onboarded and there is no invite', async () => {
    InventoryVisibilityFilterRegistry.register({
      excludeSuppliers: async () => ['supplier-org'],
    });
    vi.spyOn(InventoryRecord, 'findListableById').mockResolvedValue(listedDevice as never);

    await expect(service.getListingById('device-1')).rejects.toThrow(NotFoundException);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('still shows detail to an invitee when plugins hide the supplier', async () => {
    InventoryVisibilityFilterRegistry.register({
      excludeSuppliers: async () => ['supplier-org'],
    });
    vi.spyOn(InventoryRecord, 'findListableById').mockResolvedValue(invitedUnlistedDevice as never);
    vi.mocked(buildCustomizationCatalog).mockResolvedValueOnce({ bases: [], componentsByBase: {} });

    await expect(service.getListingById('device-1')).resolves.toMatchObject({ id: 'device-1' });
  });

  it('shows listed devices when commerce is off (no visibility filter)', async () => {
    vi.spyOn(InventoryRecord, 'findListings').mockResolvedValue([listedDevice] as never);
    vi.spyOn(LayerRecord, 'findBaseLayerSummaries').mockResolvedValue([]);

    const result = await service.getListings();

    expect(result.data.map((listing) => listing.id)).toEqual(['device-1']);
  });

  it('hides listed devices when the onboarding lookup fails', async () => {
    InventoryVisibilityFilterRegistry.register({
      excludeSuppliers: async () => {
        throw new Error('lookup failed');
      },
    });
    vi.spyOn(InventoryRecord, 'listedSupplierIds').mockResolvedValue(['supplier-org']);
    const findListings = vi.spyOn(InventoryRecord, 'findListings').mockResolvedValue([]);
    vi.spyOn(LayerRecord, 'findBaseLayerSummaries').mockResolvedValue([]);

    const result = await service.getListings();

    expect(findListings).toHaveBeenCalledWith(undefined, undefined, ['supplier-org']);
    expect(result.data).toEqual([]);
  });

  it('passes excluded suppliers into category price and availability queries', async () => {
    InventoryVisibilityFilterRegistry.register({
      excludeSuppliers: async () => ['supplier-org'],
    });
    vi.spyOn(InventoryRecord, 'listedSupplierIds').mockResolvedValue(['supplier-org']);
    const prices = vi.spyOn(InventoryRecord, 'getAllCategoryPrices').mockResolvedValue([]);
    const availability = vi.spyOn(InventoryRecord, 'getCategoryAvailability').mockResolvedValue([]);

    await service.getCategoryPrices({ page: 1, pageSize: 100 });
    await service.getCategoryAvailability({ page: 1, pageSize: 100 });

    expect(prices).toHaveBeenCalledWith(['supplier-org']);
    expect(availability).toHaveBeenCalledWith(['supplier-org']);
  });
});
