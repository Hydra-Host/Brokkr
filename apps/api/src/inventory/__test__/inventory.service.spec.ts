import { BadRequestException, ConflictException } from '@nestjs/common';
import { RequestSource, WebhookEventType } from '@repo/database';
import { buildCustomizationCatalog, LayerRecord, resolveZoneBuildId } from '@repo/layers';
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
    isInterruptible: false,
    projectId: undefined,
    ipxeUrl: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    service = new InventoryService(
      {} as never,
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

    await service.provisionDirectProvisionDevice({ ...baseData });

    expect(lifecycleService.requestProvision).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'device-1',
        organizationId: 'incoming-org',
        isInterruptible: false,
        tee: false,
      }),
    );
    expect(lifecycleService.requestInterruptibleProvision).not.toHaveBeenCalled();
  });

  it('forwards the device storageDrives to the provision validator', async () => {
    const storageDrives = [{ id: 'drive-1', name: 'nvme0n1' }];
    const aggregate = { ...buildAggregate(null), storageDrives };
    vi.spyOn(InventoryRecord, 'findListableById').mockResolvedValue(aggregate as never);

    await service.provisionDirectProvisionDevice({ ...baseData });

    expect(provisionValidator.validate).toHaveBeenCalledWith({ ...baseData }, storageDrives);
  });

  it('passes isInterruptible=true through to requestProvision for an interruptible request on a free host', async () => {
    vi.spyOn(InventoryRecord, 'findListableById').mockResolvedValue(buildAggregate(null) as never);

    await service.provisionDirectProvisionDevice({ ...baseData, isInterruptible: true });

    expect(lifecycleService.requestProvision).toHaveBeenCalledWith(expect.objectContaining({ isInterruptible: true }));
  });

  it('routes an interruptible takeover (occupied by a different org) to requestInterruptibleProvision', async () => {
    const aggregate = buildAggregate({ isInterruptible: true, customerId: 'outgoing-org' });
    vi.spyOn(InventoryRecord, 'findListableById').mockResolvedValue(aggregate as never);

    await service.provisionDirectProvisionDevice({ ...baseData, isInterruptible: true });

    expect(lifecycleService.requestInterruptibleProvision).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'device-1', request: expect.objectContaining({ isInterruptible: true }) }),
    );
    expect(contextService.requirePermission).toHaveBeenCalledWith('lifecycle-request', 'create');
    expect(lifecycleService.requestProvision).not.toHaveBeenCalled();
  });

  it('rejects a non-interruptible takeover attempt with a 400', async () => {
    const aggregate = buildAggregate({ isInterruptible: true, customerId: 'outgoing-org' });
    vi.spyOn(InventoryRecord, 'findListableById').mockResolvedValue(aggregate as never);

    await expect(
      service.provisionDirectProvisionDevice({ ...baseData, isInterruptible: false }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(lifecycleService.requestInterruptibleProvision).not.toHaveBeenCalled();
    expect(lifecycleService.requestProvision).not.toHaveBeenCalled();
  });

  it('does not treat the same org re-provisioning its own interruptible host as a takeover', async () => {
    const aggregate = buildAggregate({ isInterruptible: true, customerId: 'incoming-org' });
    vi.spyOn(InventoryRecord, 'findListableById').mockResolvedValue(aggregate as never);

    await service.provisionDirectProvisionDevice({ ...baseData, isInterruptible: true });

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
