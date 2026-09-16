import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { ActiveRecordRegistry } from '@repo/active-record';
import {
  DeviceSecretActorType,
  DeviceSecretKind,
  DeviceSecretPurpose,
  IpxeBuildTarget,
  RequestSource,
  TeeCapability,
} from '@repo/database';
import { DhcpConfigPublisherService } from 'src/brokkr-bridge/dhcp/dhcp-config-publisher.service';
import { BridgeInventoryCollectionService } from 'src/brokkr-bridge/lifecycle/inventory-collection.service';
import { BridgeCommissioningService } from 'src/brokkr-bridge/lifecycle/commissioning.service';
import { CloudInitTemplatesService } from 'src/cloud-init-templates/cloud-init-templates.service';
import { ContextService } from 'src/common/context/context.service';
import { DeviceSecretService, SecretStorageUnavailableError } from 'src/device-secret/device-secret.service';
import { InventoryService } from 'src/inventory/inventory.service';
import { LifecycleService } from 'src/lifecycle/lifecycle.service';
import { OrganizationsService } from 'src/organizations/organizations.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { CloudInitProcessor, ProvisionValidatorService } from 'src/provision/processors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaremetalPresenter } from '../baremetal.presenter';
import { BaremetalRecord } from '../baremetal.record';
import { BaremetalService } from '../baremetal.service';
import { DeviceLifecycleEvent } from '../device-lifecycle.events';

vi.mock('@repo/layers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@repo/layers')>()),
  buildCustomizationCatalog: vi.fn(async () => ({ bases: [], componentsByBase: {} })),
  emptyCustomizationCatalog: () => ({ bases: [], componentsByBase: {} }),
  resolveZoneBuildId: vi.fn(async () => null),
}));

import { buildCustomizationCatalog, resolveZoneBuildId } from '@repo/layers';

describe('BaremetalService', () => {
  let service: BaremetalService;

  const ORG_ID = 'test-org-id';
  const USER_ID = 'test-user-id';

  const mockInventoryService = {
    tryTriggerListingEvent: vi.fn(),
  };

  const mockOrganizationsService = {
    getOrganization: vi.fn(),
  };

  const mockBridgeCommissioningService = {
    commissionDevice: vi.fn(),
  };
  const mockBridgeInventoryCollectionService = {
    startInventoryCollection: vi.fn(),
  };

  const mockDeviceSecretWrite = vi.fn();
  const mockDeviceSecretInvalidateAll = vi.fn();
  const mockEventEmit = vi.fn();

  const mockTx = {
    interface: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    ipAddress: {
      updateMany: vi.fn(),
    },
  };

  const mockLifecycleService = {
    requestProvision: vi.fn(),
  };

  const mockCloudInitProcessor = {
    process: vi.fn(),
  };

  const mockProvisionValidator = {
    validateDiskLayouts: vi.fn(),
    validateDiskGroupHomogeneity: vi.fn(),
    validateDiskGroupSizeLimits: vi.fn(),
    validateIpxeRequirements: vi.fn(),
    validateCustomizations: vi.fn(),
  };

  const mockCloudInitTemplatesService = {
    resolveAndSave: vi.fn().mockImplementation((p: { cloudInit?: unknown }) => Promise.resolve(p.cloudInit ?? null)),
    resolveTemplateContent: vi.fn(),
    upsertFromProvision: vi.fn().mockResolvedValue(null),
  };

  const mockPrismaClient = {
    device: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(async (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx)),
  };

  const mockLogger = {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    verbose: vi.fn(),
    setContext: vi.fn().mockReturnThis(),
  };

  const mockDhcpRepublishForDevice = vi.fn();

  const mockContextService = {
    organizationId: ORG_ID,
    userId: USER_ID,
    requestSource: RequestSource.UI,
    requirePermission: vi.fn(),
    buildAuditPayload: vi.fn().mockReturnValue({
      triggeredBy: USER_ID,
      triggeredByEmail: 'unknown',
      organizationId: ORG_ID,
    }),
  };

  beforeEach(async () => {
    ActiveRecordRegistry.configureForTest({ device: {} }, () => ({ organizationId: ORG_ID, system: true }));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BaremetalService,
        { provide: PrismaClient, useValue: mockPrismaClient },
        { provide: BridgeCommissioningService, useValue: mockBridgeCommissioningService },
        { provide: BridgeInventoryCollectionService, useValue: mockBridgeInventoryCollectionService },
        { provide: OrganizationsService, useValue: mockOrganizationsService },
        { provide: InventoryService, useValue: mockInventoryService },
        { provide: ContextService, useValue: mockContextService },
        { provide: LifecycleService, useValue: mockLifecycleService },
        { provide: CloudInitProcessor, useValue: mockCloudInitProcessor },
        { provide: ProvisionValidatorService, useValue: mockProvisionValidator },
        { provide: CloudInitTemplatesService, useValue: mockCloudInitTemplatesService },
        { provide: EventEmitter2, useValue: { emit: mockEventEmit } },
        {
          provide: DeviceSecretService,
          useValue: { write: mockDeviceSecretWrite, invalidateAll: mockDeviceSecretInvalidateAll },
        },
        { provide: DhcpConfigPublisherService, useValue: { republishForDevice: mockDhcpRepublishForDevice } },
        { provide: 'LoggerServiceBaremetalService', useValue: mockLogger },
      ],
    }).compile();

    service = module.get<BaremetalService>(BaremetalService);
    mockContextService.requirePermission.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getBaremetalServerById', () => {
    it('should return presenter output when record found', async () => {
      const aggregate = { id: 'device-uuid-1', name: 'device-1' };
      const record = { data: aggregate } as unknown as BaremetalRecord;
      const presented = { id: 'device-uuid-1', formatted: true } as any;

      const findSpy = vi.spyOn(BaremetalRecord, 'findByDeviceId').mockResolvedValue(record);
      const presentSpy = vi.spyOn(BaremetalPresenter, 'toResponse').mockReturnValue(presented);

      const result = await service.getBaremetalServerById('device-uuid-1');

      expect(findSpy).toHaveBeenCalledWith('device-uuid-1', { includeDeleted: true });
      expect(presentSpy).toHaveBeenCalledWith(aggregate, { bases: [], componentsByBase: {} });
      expect(result).toBe(presented);
    });

    it('should throw 404 when record is not found', async () => {
      vi.spyOn(BaremetalRecord, 'findByDeviceId').mockResolvedValue(null);

      await expect(service.getBaremetalServerById('missing-uuid')).rejects.toThrow(
        new NotFoundException('Server not found'),
      );
    });

    it('fails soft to an empty catalog when hydration throws (detail read must not 500)', async () => {
      const aggregate = { id: 'device-uuid-1', name: 'device-1' };
      const record = { data: aggregate } as unknown as BaremetalRecord;
      vi.spyOn(BaremetalRecord, 'findByDeviceId').mockResolvedValue(record);
      const presentSpy = vi.spyOn(BaremetalPresenter, 'toResponse').mockReturnValue({ ok: true } as any);
      vi.mocked(buildCustomizationCatalog).mockRejectedValueOnce(new Error('layer table unavailable'));

      const result = await service.getBaremetalServerById('device-uuid-1');

      expect(result).toEqual({ ok: true });
      expect(presentSpy).toHaveBeenCalledWith(aggregate, { bases: [], componentsByBase: {} });
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('propagates ConflictException from resolveZoneBuildId (business error, not fail-soft)', async () => {
      const aggregate = { id: 'device-uuid-1', name: 'device-1' };
      const record = { data: aggregate } as unknown as BaremetalRecord;
      vi.spyOn(BaremetalRecord, 'findByDeviceId').mockResolvedValue(record);
      vi.mocked(resolveZoneBuildId).mockRejectedValueOnce(new ConflictException('no ready build'));

      await expect(service.getBaremetalServerById('device-uuid-1')).rejects.toThrow(ConflictException);
    });
  });

  describe('commissionDiscoveredServer', () => {
    const commissionDTO = {
      id: 'device-uuid-123',
      macAddress: 'AA:BB:CC:DD:EE:FF',
      ipmiLogin: 'admin',
      ipmiPassword: 'secret',
    } as const;

    beforeEach(() => {
      mockContextService.requirePermission.mockImplementation(() => undefined);
    });

    it('should look up the device, create the job, and enqueue via the bridge commissioning service', async () => {
      vi.spyOn(BaremetalRecord, 'createCommissionJob').mockResolvedValue({} as any);
      vi.spyOn(BaremetalRecord, 'findByDeviceIdOrThrow').mockResolvedValue({
        data: { id: 'device-uuid-123', zoneId: 'zone-uuid' },
      } as unknown as BaremetalRecord);
      mockBridgeCommissioningService.commissionDevice.mockResolvedValue({ success: true });

      await service.commissionDiscoveredServer(commissionDTO);

      expect(mockContextService.requirePermission).toHaveBeenCalledWith('device', 'create');
      expect(BaremetalRecord.findByDeviceIdOrThrow).toHaveBeenCalledWith('device-uuid-123');
      expect(mockDeviceSecretWrite).toHaveBeenCalledWith(
        'device-uuid-123',
        DeviceSecretPurpose.BMC,
        DeviceSecretKind.USER,
        { user: 'admin', pass: 'secret' },
        USER_ID,
        { skipIfLivePresent: true },
      );
      expect(BaremetalRecord.createCommissionJob).toHaveBeenCalledWith(commissionDTO, expect.any(String));
      expect(mockBridgeCommissioningService.commissionDevice).toHaveBeenCalledWith(
        'device-uuid-123',
        expect.any(String),
        {},
        'zone-uuid',
      );
    });

    it('blocks (fail closed) and never creates a job when the zone is not enrolled for secret storage', async () => {
      vi.spyOn(BaremetalRecord, 'findByDeviceIdOrThrow').mockResolvedValue({
        data: { id: 'device-uuid-123', zoneId: 'zone-uuid' },
      } as unknown as BaremetalRecord);
      const createJobSpy = vi.spyOn(BaremetalRecord, 'createCommissionJob').mockResolvedValue({} as any);
      mockDeviceSecretWrite.mockRejectedValue(new SecretStorageUnavailableError('zone zone-uuid is not enrolled'));

      await expect(service.commissionDiscoveredServer(commissionDTO)).rejects.toThrow(BadRequestException);
      expect(createJobSpy).not.toHaveBeenCalled();
      expect(mockBridgeCommissioningService.commissionDevice).not.toHaveBeenCalled();
    });

    it('should reject when the caller lacks an admin-level role', async () => {
      mockContextService.requirePermission.mockImplementation(() => {
        throw new ForbiddenException();
      });
      const createJobSpy = vi.spyOn(BaremetalRecord, 'createCommissionJob').mockResolvedValue({} as any);

      await expect(service.commissionDiscoveredServer(commissionDTO)).rejects.toThrow(ForbiddenException);
      expect(createJobSpy).not.toHaveBeenCalled();
      expect(mockBridgeCommissioningService.commissionDevice).not.toHaveBeenCalled();
    });

    it('should 404 and not create a job for a foreign-supplier device', async () => {
      vi.spyOn(BaremetalRecord, 'findByDeviceIdOrThrow').mockRejectedValue(new NotFoundException('Device not found'));
      const createJobSpy = vi.spyOn(BaremetalRecord, 'createCommissionJob').mockResolvedValue({} as any);

      await expect(service.commissionDiscoveredServer(commissionDTO)).rejects.toThrow(NotFoundException);
      expect(createJobSpy).not.toHaveBeenCalled();
      expect(mockBridgeCommissioningService.commissionDevice).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException and not create a job when the device has no zone', async () => {
      vi.spyOn(BaremetalRecord, 'findByDeviceIdOrThrow').mockResolvedValue({
        data: { id: 'device-uuid-123', zoneId: null },
      } as unknown as BaremetalRecord);
      const createJobSpy = vi.spyOn(BaremetalRecord, 'createCommissionJob').mockResolvedValue({} as any);

      await expect(service.commissionDiscoveredServer(commissionDTO)).rejects.toThrow(BadRequestException);
      expect(createJobSpy).not.toHaveBeenCalled();
      expect(mockBridgeCommissioningService.commissionDevice).not.toHaveBeenCalled();
    });
  });

  describe('collectInventory', () => {
    it('rejects a caller without device:update before any collection work', async () => {
      mockContextService.requirePermission.mockImplementation(() => {
        throw new ForbiddenException();
      });
      const findSpy = vi.spyOn(BaremetalRecord, 'findByDeviceIdOrThrow');

      await expect(service.collectInventory('device-uuid-1')).rejects.toThrow(ForbiddenException);

      expect(mockContextService.requirePermission).toHaveBeenCalledWith('device', 'update');
      expect(findSpy).not.toHaveBeenCalled();
      expect(mockBridgeInventoryCollectionService.startInventoryCollection).not.toHaveBeenCalled();
    });

    it('throws NotFoundException and never enqueues when the device does not exist', async () => {
      vi.spyOn(BaremetalRecord, 'findByDeviceIdOrThrow').mockRejectedValue(new NotFoundException('Device not found'));

      await expect(service.collectInventory('missing-uuid')).rejects.toThrow(NotFoundException);

      expect(mockBridgeInventoryCollectionService.startInventoryCollection).not.toHaveBeenCalled();
    });

    it('throws BadRequestException and never enqueues when the device has no zone', async () => {
      vi.spyOn(BaremetalRecord, 'findByDeviceIdOrThrow').mockResolvedValue({
        data: { id: 'device-uuid-1', zoneId: null },
      } as unknown as BaremetalRecord);

      await expect(service.collectInventory('device-uuid-1')).rejects.toThrow(BadRequestException);

      expect(mockBridgeInventoryCollectionService.startInventoryCollection).not.toHaveBeenCalled();
    });

    it('enqueues inventory_collection on the device zone and returns the job id', async () => {
      vi.spyOn(BaremetalRecord, 'findByDeviceIdOrThrow').mockResolvedValue({
        data: { id: 'device-uuid-1', zoneId: 'zone-uuid' },
      } as unknown as BaremetalRecord);
      mockBridgeInventoryCollectionService.startInventoryCollection.mockResolvedValue({
        jobId: 'inventory-cron-device-uuid-1',
      });

      const result = await service.collectInventory('device-uuid-1');

      expect(mockContextService.requirePermission).toHaveBeenCalledWith('device', 'update');
      expect(mockBridgeInventoryCollectionService.startInventoryCollection).toHaveBeenCalledWith(
        'device-uuid-1',
        'zone-uuid',
      );
      expect(result).toEqual({ jobId: 'inventory-cron-device-uuid-1' });
    });
  });

  describe('updateListing', () => {
    it('record policy rejects a caller without device:update', () => {
      ActiveRecordRegistry.configureForTest({}, () => ({
        organizationId: ORG_ID,
        permissions: new Set<string>(),
      }));
      try {
        expect(() => BaremetalRecord.requireAction('updateListing')).toThrow(ForbiddenException);
        expect(() => BaremetalRecord.requireAction('updateNickname')).toThrow(ForbiddenException);
        expect(() => BaremetalRecord.requireAction('decommission')).toThrow(ForbiddenException);
      } finally {
        ActiveRecordRegistry.configureForTest({}, null);
      }
    });

    it('service.updateListing rejects a caller without device:update before saving', async () => {
      ActiveRecordRegistry.configureForTest({}, () => ({
        organizationId: ORG_ID,
        permissions: new Set<string>(),
      }));
      try {
        const record = BaremetalRecord.build({ id: 'device-uuid-1' });
        const saveSpy = vi.spyOn(record, 'save').mockResolvedValue(undefined);
        vi.spyOn(BaremetalRecord, 'findByDeviceIdOrThrow').mockResolvedValue(record);

        await expect(service.updateListing('device-uuid-1', { hourlyPrice: 1, isListed: true } as any)).rejects.toThrow(
          ForbiddenException,
        );

        expect(saveSpy).not.toHaveBeenCalled();
        expect(mockInventoryService.tryTriggerListingEvent).not.toHaveBeenCalled();
      } finally {
        ActiveRecordRegistry.configureForTest({}, null);
      }
    });
  });

  describe('updateServerInfo', () => {
    it('rejects a caller without device:update before touching the device', async () => {
      mockContextService.requirePermission.mockImplementation((_r: string, a: string) => {
        if (a === 'update') throw new ForbiddenException();
      });
      const findSpy = vi.spyOn(BaremetalRecord, 'findByDeviceIdOrThrow');

      await expect(service.updateServerInfo('device-uuid-1', { nickname: 'x' } as never)).rejects.toThrow(
        ForbiddenException,
      );

      expect(mockContextService.requirePermission).toHaveBeenCalledWith('device', 'update');
      expect(findSpy).not.toHaveBeenCalled();
    });

    it('maps a provided ipxeBuildTarget to the Prisma enum via device.update', async () => {
      const record = { data: { id: 'device-uuid-1' } };
      vi.spyOn(BaremetalRecord, 'findByDeviceIdOrThrow').mockResolvedValue(record as unknown as BaremetalRecord);
      mockPrismaClient.device.update.mockResolvedValue({});

      await service.updateServerInfo('device-uuid-1', { ipxeBuildTarget: 'SNP' });

      expect(mockPrismaClient.device.update).toHaveBeenCalledWith({
        where: { id: 'device-uuid-1' },
        data: { ipxeBuildTarget: IpxeBuildTarget.SNP },
      });
      // ipxeBuildTarget feeds the per-device DHCP reservation atom — updateServerInfo must eagerly
      // republish so the bridge serves the new bootfile without waiting for the reconcile cron.
      expect(mockDhcpRepublishForDevice).toHaveBeenCalledWith('device-uuid-1');
    });

    it('clears ipxeBuildTarget (null) via device.update', async () => {
      const record = { data: { id: 'device-uuid-1' } };
      vi.spyOn(BaremetalRecord, 'findByDeviceIdOrThrow').mockResolvedValue(record as unknown as BaremetalRecord);
      mockPrismaClient.device.update.mockResolvedValue({});

      await service.updateServerInfo('device-uuid-1', { ipxeBuildTarget: null });

      expect(mockPrismaClient.device.update).toHaveBeenCalledWith({
        where: { id: 'device-uuid-1' },
        data: { ipxeBuildTarget: null },
      });
      expect(mockDhcpRepublishForDevice).toHaveBeenCalledWith('device-uuid-1');
    });

    it('does not touch ipxeBuildTarget or republish DHCP on a nickname-only change (field absent)', async () => {
      const record = {
        data: { id: 'device-uuid-1' },
        updateNickname: vi.fn(),
        save: vi.fn().mockResolvedValue(undefined),
      };
      vi.spyOn(BaremetalRecord, 'findByDeviceIdOrThrow').mockResolvedValue(record as unknown as BaremetalRecord);
      mockPrismaClient.device.update.mockResolvedValue({});

      await service.updateServerInfo('device-uuid-1', { nickname: 'renamed' });

      expect(record.updateNickname).toHaveBeenCalledWith('renamed');
      // ipxeBuildTarget undefined (not null) → no per-device DHCP atom change → no eager republish,
      // and device.update must not spuriously write the field.
      expect(mockDhcpRepublishForDevice).not.toHaveBeenCalled();
      for (const call of mockPrismaClient.device.update.mock.calls) {
        expect(call[0].data).not.toHaveProperty('ipxeBuildTarget');
      }
    });

    it('propagates a device.update failure and does not republish DHCP', async () => {
      const record = { data: { id: 'device-uuid-1' } };
      vi.spyOn(BaremetalRecord, 'findByDeviceIdOrThrow').mockResolvedValue(record as unknown as BaremetalRecord);
      mockPrismaClient.device.update.mockRejectedValueOnce(new Error('db write failed'));

      await expect(service.updateServerInfo('device-uuid-1', { ipxeBuildTarget: 'SNP' })).rejects.toThrow(
        'db write failed',
      );
      // The persist failed, so the eager republish (which runs only after Promise.all resolves)
      // must not fire — the bridge is never told about a bootfile change that didn't commit.
      expect(mockDhcpRepublishForDevice).not.toHaveBeenCalled();
    });
  });

  describe('updateNickname', () => {
    it('should throw NotFoundException when device not found', async () => {
      vi.spyOn(BaremetalRecord, 'findByDeviceIdOrThrow').mockRejectedValue(new NotFoundException('Device not found'));

      await expect(service.updateNickname('nonexistent-uuid', 'new-name')).rejects.toThrow(NotFoundException);
    });

    it('should update nickname, save, and return presenter output', async () => {
      const record = {
        data: { id: 'device-uuid-1' },
        updateNickname: vi.fn(),
        save: vi.fn().mockResolvedValue(undefined),
      };
      const aggregate = { id: 'device-uuid-1' } as any;
      const presented = { id: 'device-uuid-1', formatted: true } as any;

      const recordWithData = { ...record, data: aggregate };
      vi.spyOn(BaremetalRecord, 'findByDeviceIdOrThrow').mockResolvedValue(
        recordWithData as unknown as BaremetalRecord,
      );
      vi.spyOn(BaremetalPresenter, 'toResponse').mockReturnValue(presented);

      const result = await service.updateNickname('device-uuid-1', 'new-name');

      expect(BaremetalRecord.findByDeviceIdOrThrow).toHaveBeenCalledWith('device-uuid-1');
      expect(record.updateNickname).toHaveBeenCalledWith('new-name');
      expect(record.save).toHaveBeenCalled();
      expect(result).toBe(presented);
    });
  });

  describe('updateServerToDecommissioned', () => {
    it('should call requireAction("decommission") as a fail-fast permission gate', async () => {
      const requireActionSpy = vi.spyOn(BaremetalRecord, 'requireAction').mockImplementation(() => {
        throw new ForbiddenException();
      });

      await expect(service.updateServerToDecommissioned('device-uuid-1')).rejects.toThrow(ForbiddenException);
      expect(requireActionSpy).toHaveBeenCalledWith('decommission');
    });

    it('should throw NotFoundException when device not found', async () => {
      mockContextService.requirePermission.mockImplementation(() => undefined);
      vi.spyOn(BaremetalRecord, 'findByDeviceIdOrThrow').mockRejectedValue(new NotFoundException('Server not found'));

      await expect(service.updateServerToDecommissioned('device-uuid-1')).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException when device has an active deployment', async () => {
      mockContextService.requirePermission.mockImplementation(() => undefined);
      vi.spyOn(BaremetalRecord, 'findByDeviceIdOrThrow').mockResolvedValue({
        data: {
          id: 'device-uuid-1',
          server: { deployments: [{ id: 'deploy-1', endDate: null }] },
        },
      } as unknown as BaremetalRecord);

      await expect(service.updateServerToDecommissioned('device-uuid-1')).rejects.toThrow(BadRequestException);
    });

    it('soft-deletes interfaces + their IPs, invalidates secrets, and emits SoftDeleted (no active deployment)', async () => {
      mockContextService.requirePermission.mockImplementation(() => undefined);
      const record = {
        data: { id: 'device-uuid-1', server: { deployments: [] } },
        decommission: vi.fn(),
        save: vi.fn().mockResolvedValue(undefined),
      };
      vi.spyOn(BaremetalRecord, 'findByDeviceIdOrThrow').mockResolvedValue(record as unknown as BaremetalRecord);
      vi.spyOn(BaremetalRecord, 'createJob').mockResolvedValue({} as any);
      mockTx.interface.findMany.mockResolvedValue([{ id: 'iface-1' }, { id: 'iface-2' }]);
      mockTx.ipAddress.updateMany.mockResolvedValue({ count: 2 });
      mockTx.interface.updateMany.mockResolvedValue({ count: 2 });

      const result = await service.updateServerToDecommissioned('device-uuid-1');

      expect(record.decommission).toHaveBeenCalled();
      expect(record.save).toHaveBeenCalledWith({ tx: mockTx });

      expect(mockTx.ipAddress.updateMany).toHaveBeenCalledWith({
        where: { interfaceId: { in: ['iface-1', 'iface-2'] }, deletedAt: null },
        data: { deletedAt: expect.any(Date) },
      });
      expect(mockTx.interface.updateMany).toHaveBeenCalledWith({
        where: { deviceId: 'device-uuid-1', deletedAt: null },
        data: { deletedAt: expect.any(Date) },
      });
      expect(mockDeviceSecretInvalidateAll).toHaveBeenCalledWith(
        'device-uuid-1',
        { type: DeviceSecretActorType.USER, id: USER_ID },
        'DEVICE_DECOMMISSIONED',
        mockTx,
      );
      expect(mockEventEmit).toHaveBeenCalledWith(DeviceLifecycleEvent.SoftDeleted, { deviceId: 'device-uuid-1' });
      expect(result).toEqual({ success: true });
    });

    it('skips the IP soft-delete when the device has no live interfaces', async () => {
      mockContextService.requirePermission.mockImplementation(() => undefined);
      const record = {
        data: { id: 'device-uuid-1', server: { deployments: [] } },
        decommission: vi.fn(),
        save: vi.fn().mockResolvedValue(undefined),
      };
      vi.spyOn(BaremetalRecord, 'findByDeviceIdOrThrow').mockResolvedValue(record as unknown as BaremetalRecord);
      vi.spyOn(BaremetalRecord, 'createJob').mockResolvedValue({} as any);
      mockTx.interface.findMany.mockResolvedValue([]);
      mockTx.interface.updateMany.mockResolvedValue({ count: 0 });

      await service.updateServerToDecommissioned('device-uuid-1');

      expect(mockTx.ipAddress.updateMany).not.toHaveBeenCalled();
      expect(mockTx.interface.updateMany).toHaveBeenCalledWith({
        where: { deviceId: 'device-uuid-1', deletedAt: null },
        data: { deletedAt: expect.any(Date) },
      });
    });
  });

  describe('getEcoModeStatus', () => {
    it('returns eco_mode from the Server extension when enabled', async () => {
      const record = { data: { id: 'device-uuid-1', server: { ecoMode: true } } };
      vi.spyOn(BaremetalRecord, 'findByDeviceIdOrThrow').mockResolvedValue(record as unknown as BaremetalRecord);

      const result = await service.getEcoModeStatus('device-uuid-1');

      expect(result).toBe(true);
    });

    it('returns eco_mode from the Server extension when disabled', async () => {
      const record = { data: { id: 'device-uuid-1', server: { ecoMode: false } } };
      vi.spyOn(BaremetalRecord, 'findByDeviceIdOrThrow').mockResolvedValue(record as unknown as BaremetalRecord);

      const result = await service.getEcoModeStatus('device-uuid-1');

      expect(result).toBe(false);
    });
  });

  describe('provisionServer', () => {
    it('rejects a caller lacking inventory:create before any provisioning work', async () => {
      mockContextService.requirePermission.mockImplementation(() => {
        throw new ForbiddenException();
      });
      const findSpy = vi.spyOn(BaremetalRecord, 'findByDeviceIdOrThrow');

      await expect(
        service.provisionServer('device-uuid-1', { deploymentName: 'test', operatingSystem: 'ubuntu-24-04' } as any),
      ).rejects.toThrow(ForbiddenException);

      expect(mockContextService.requirePermission).toHaveBeenCalledWith('inventory', 'create');
      expect(findSpy).not.toHaveBeenCalled();
      expect(mockLifecycleService.requestProvision).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException when the device is not found', async () => {
      vi.spyOn(BaremetalRecord, 'findByDeviceIdOrThrow').mockRejectedValue(new NotFoundException('Device not found'));

      await expect(
        service.provisionServer('missing-uuid', {
          deploymentName: 'test',
          operatingSystem: 'ubuntu-24-04' as any,
        } as any),
      ).rejects.toThrow(NotFoundException);

      expect(mockLifecycleService.requestProvision).not.toHaveBeenCalled();
    });

    it('should delegate to lifecycleService.requestProvision for the resolved device', async () => {
      const record = { data: { id: 'device-uuid-1' } };
      vi.spyOn(BaremetalRecord, 'findByDeviceIdOrThrow').mockResolvedValue(record as unknown as BaremetalRecord);
      mockCloudInitProcessor.process.mockReturnValue('cloud-init-content');
      mockLifecycleService.requestProvision.mockResolvedValue({ data: { id: 'job-1' } });

      const result = await service.provisionServer('device-uuid-1', {
        deploymentName: 'test',
        operatingSystem: 'ubuntu-24-04' as any,
        sshKeyIds: ['k1'],
        diskLayouts: undefined,
      } as any);

      expect(mockLifecycleService.requestProvision).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceId: 'device-uuid-1',
          userId: USER_ID,
          organizationId: ORG_ID,
          operatingSystemSlug: 'ubuntu-24-04',
          cloudInit: 'cloud-init-content',
          customizations: null,
          tee: false,
          passwordHash: null,
          source: RequestSource.UI,
        }),
      );
      expect(result).toEqual({ data: { id: 'job-1' } });
    });

    it('forwards the device storageDrives to the homogeneity check', async () => {
      const storageDrives = [{ id: 'drive-1', name: 'nvme0n1' }];
      const diskLayouts = [{ config: 'lvm', format: 'ext4', mountpoint: '/', diskType: 'nvme', disks: ['nvme0n1'] }];
      const record = { data: { id: 'device-uuid-1', storageDrives } };
      vi.spyOn(BaremetalRecord, 'findByDeviceIdOrThrow').mockResolvedValue(record as unknown as BaremetalRecord);
      mockCloudInitProcessor.process.mockReturnValue('cloud-init-content');
      mockLifecycleService.requestProvision.mockResolvedValue({ id: 'job-1' });

      await service.provisionServer('device-uuid-1', {
        deploymentName: 'test',
        operatingSystem: 'ubuntu-24-04' as any,
        sshKeyIds: ['k1'],
        diskLayouts,
      } as any);

      expect(mockProvisionValidator.validateDiskLayouts).toHaveBeenCalledWith(diskLayouts, 'provision');
      expect(mockProvisionValidator.validateDiskGroupHomogeneity).toHaveBeenCalledWith(diskLayouts, storageDrives);
      expect(mockProvisionValidator.validateDiskGroupSizeLimits).toHaveBeenCalledWith(diskLayouts, storageDrives);
    });

    it('validates flattened customizations against the device hardware and forwards them', async () => {
      const record = {
        data: {
          id: 'device-uuid-1',
          cpus: [{ model: 'EPYC', architecture: 'x86_64', coreCount: 64, threadCount: 128 }],
          gpus: [{ model: 'NVIDIA H100 80GB' }],
          server: { teeEnabled: true, teeCapable: TeeCapability.TRUE },
        },
      };
      vi.spyOn(BaremetalRecord, 'findByDeviceIdOrThrow').mockResolvedValue(record as unknown as BaremetalRecord);
      mockCloudInitProcessor.process.mockReturnValue('cloud-init-content');
      mockLifecycleService.requestProvision.mockResolvedValue({ id: 'job-1' });

      await service.provisionServer('device-uuid-1', {
        deploymentName: 'test',
        operatingSystem: 'ubuntu-noble-vanilla' as any,
        sshKeyIds: ['k1'],
        customizations: { gpuDriver: 'nvidia-driver-580', miscSoftware: ['docker'] },
      } as any);

      expect(mockProvisionValidator.validateCustomizations).toHaveBeenCalledWith(
        ['nvidia-driver-580', 'docker'],
        'NVIDIA H100 80GB',
        true,
        'ubuntu-noble-vanilla',
        'amd64',
        null,
      );
      expect(mockLifecycleService.requestProvision).toHaveBeenCalledWith(
        expect.objectContaining({ customizations: ['nvidia-driver-580', 'docker'], tee: false }),
      );
    });

    it('forwards tee: true when explicitly set on a TEE-capable device', async () => {
      const record = {
        data: {
          id: 'device-uuid-1',
          cpus: [{ model: 'EPYC', architecture: 'x86_64', coreCount: 64, threadCount: 128 }],
          gpus: [{ model: 'NVIDIA H100 80GB' }],
          server: { teeEnabled: true, teeCapable: TeeCapability.TRUE },
        },
      };
      vi.spyOn(BaremetalRecord, 'findByDeviceIdOrThrow').mockResolvedValue(record as unknown as BaremetalRecord);
      mockCloudInitProcessor.process.mockReturnValue('cloud-init-content');
      mockLifecycleService.requestProvision.mockResolvedValue({ id: 'job-1' });

      await service.provisionServer('device-uuid-1', {
        deploymentName: 'test',
        operatingSystem: 'ipxe-custom' as any,
        sshKeyIds: ['k1'],
        tee: true,
      } as any);

      expect(mockLifecycleService.requestProvision).toHaveBeenCalledWith(expect.objectContaining({ tee: true }));
    });

    it('forwards tee: true on a standard OS when device is TEE-capable', async () => {
      const record = {
        data: {
          id: 'device-uuid-1',
          cpus: [{ model: 'EPYC', architecture: 'x86_64', coreCount: 64, threadCount: 128 }],
          gpus: [{ model: 'NVIDIA H100 80GB' }],
          server: { teeEnabled: true, teeCapable: TeeCapability.TRUE },
        },
      };
      vi.spyOn(BaremetalRecord, 'findByDeviceIdOrThrow').mockResolvedValue(record as unknown as BaremetalRecord);
      mockCloudInitProcessor.process.mockReturnValue('cloud-init-content');
      mockLifecycleService.requestProvision.mockResolvedValue({ id: 'job-1' });

      await service.provisionServer('device-uuid-1', {
        deploymentName: 'test',
        operatingSystem: 'ubuntu-24-04' as any,
        sshKeyIds: ['k1'],
        tee: true,
      } as any);

      expect(mockLifecycleService.requestProvision).toHaveBeenCalledWith(expect.objectContaining({ tee: true }));
    });

    it('rejects tee: true when device is not TEE-capable', async () => {
      const record = {
        data: {
          id: 'device-uuid-1',
          server: { teeEnabled: false, teeCapable: TeeCapability.UNVERIFIED },
        },
      };
      vi.spyOn(BaremetalRecord, 'findByDeviceIdOrThrow').mockResolvedValue(record as unknown as BaremetalRecord);

      await expect(
        service.provisionServer('device-uuid-1', {
          deploymentName: 'test',
          operatingSystem: 'ipxe-custom' as any,
          sshKeyIds: ['k1'],
          tee: true,
        } as any),
      ).rejects.toThrow('TEE is not supported on this device');

      expect(mockLifecycleService.requestProvision).not.toHaveBeenCalled();
    });

    it('propagates BadRequestException from resolveZoneBuildId on provision', async () => {
      const record = { data: { id: 'device-uuid-1', zoneId: 'zone-1' } };
      vi.spyOn(BaremetalRecord, 'findByDeviceIdOrThrow').mockResolvedValue(record as unknown as BaremetalRecord);
      vi.mocked(resolveZoneBuildId).mockRejectedValueOnce(new BadRequestException('zone deleted'));

      await expect(
        service.provisionServer('device-uuid-1', {
          deploymentName: 'test',
          operatingSystem: 'ubuntu-24-04' as any,
          sshKeyIds: ['k1'],
        } as any),
      ).rejects.toThrow(BadRequestException);

      expect(mockLifecycleService.requestProvision).not.toHaveBeenCalled();
    });
  });
});
