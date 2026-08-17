import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { CreateDeviceDiagnosticsRequest } from '@repo/api-client';
import { DeviceStatus, DeviceTokenContext, ServerLifecycleStatus, ServerPowerStatus } from '@repo/database';
import { BridgeInventoryCollectionService } from 'src/brokkr-bridge/lifecycle/inventory-collection.service';
import { QualifyOrchestrationService } from 'src/brokkr-bridge/lifecycle/qualify-orchestration.service';
import { ContextService } from 'src/common/context/context.service';
import { LifecycleInboundService } from 'src/lifecycle/inbound/lifecycle-inbound.service';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { PhoneHomeRepository } from '../phone-home.repository';
import { PhoneHomeService } from '../phone-home.service';
import { DeviceAggregate } from '../phone-home.types';

const { counterAdd } = vi.hoisted(() => ({ counterAdd: vi.fn() }));
vi.mock('@repo/telemetry', () => ({
  getTelemetryMeter: () => ({
    createCounter: (name: string) => ({
      add: (value: number, attributes?: Record<string, unknown>) => counterAdd(name, value, attributes),
    }),
  }),
  getBullMqTelemetry: () => undefined,
  emitTelemetryLog: vi.fn(),
}));

function makeDevice(overrides: Partial<DeviceAggregate> = {}): DeviceAggregate {
  return {
    id: 'device-uuid-100',
    status: DeviceStatus.ACTIVE,
    server: { lifecycleStatus: ServerLifecycleStatus.PROVISIONED },
    zoneId: 'zone-abc',
    supplier: { id: 'supplier-uuid' },
    ...overrides,
  } as DeviceAggregate;
}

describe('PhoneHomeService', () => {
  let service: PhoneHomeService;
  let repo: {
    getDeviceByUuid: Mock;
    updateDevice: Mock;
    hasActiveDeployment: Mock;
    createDeviceDiagnostics: Mock;
  };
  let qualifyOrchestration: { handleDeviceProvisioned: Mock };
  let bridgeInventoryCollection: { startInventoryCollection: Mock };
  let contextService: { deviceIdentity?: { context: DeviceTokenContext } };
  let constructionAdds: unknown[][];

  beforeEach(async () => {
    counterAdd.mockClear();
    repo = {
      getDeviceByUuid: vi.fn(),
      updateDevice: vi.fn().mockResolvedValue({ transitioned: false }),
      hasActiveDeployment: vi.fn().mockResolvedValue(false),
      createDeviceDiagnostics: vi.fn(),
    };

    qualifyOrchestration = {
      handleDeviceProvisioned: vi.fn().mockResolvedValue(undefined),
    };

    bridgeInventoryCollection = {
      startInventoryCollection: vi.fn().mockResolvedValue({ jobId: 'inventory-cron-device-uuid-100' }),
    };
    contextService = {};

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PhoneHomeService,
        { provide: PhoneHomeRepository, useValue: repo },
        { provide: QualifyOrchestrationService, useValue: qualifyOrchestration },
        { provide: BridgeInventoryCollectionService, useValue: bridgeInventoryCollection },
        { provide: LifecycleInboundService, useValue: { applyPhoneHome: vi.fn() } },
        { provide: ContextService, useValue: contextService },
        {
          provide: 'LoggerServicePhoneHomeService',
          useValue: {
            log: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
            verbose: vi.fn(),
            setContext: vi.fn().mockReturnThis(),
          },
        },
      ],
    }).compile();

    service = module.get(PhoneHomeService);
    constructionAdds = counterAdd.mock.calls.map((call) => [...call]);
    counterAdd.mockClear();
  });

  const deviceId = 'device-uuid-100';

  describe('createDeviceDiagnostics', () => {
    it('throws NotFoundException when the device does not exist', async () => {
      repo.getDeviceByUuid.mockResolvedValue(null);

      await expect(
        service.createDeviceDiagnostics('missing-device', { type: 'Health', data: {} }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.createDeviceDiagnostics).not.toHaveBeenCalled();
    });

    it('delegates to the repository when the device exists', async () => {
      repo.getDeviceByUuid.mockResolvedValue(makeDevice());
      repo.createDeviceDiagnostics.mockResolvedValue({ id: 'diag-1' });

      const dto: CreateDeviceDiagnosticsRequest = { type: 'Health', data: { errors: 2 } };
      const result = await service.createDeviceDiagnostics('device-uuid-100', dto);

      expect(repo.createDeviceDiagnostics).toHaveBeenCalledWith('device-uuid-100', dto);
      expect(result).toEqual({ id: 'diag-1' });
    });
  });

  describe('phone-home always sets powerStatus to On', () => {
    it('always reports On (device is physically running) on the power push', async () => {
      const device = makeDevice();
      repo.getDeviceByUuid.mockResolvedValue(device);

      await service.execute(deviceId);

      expect(repo.updateDevice).toHaveBeenCalledWith(device.id, expect.any(String), ServerPowerStatus.On);
    });
  });

  describe('parseDeviceStatusUpdate', () => {
    it.each([
      [ServerLifecycleStatus.PROVISIONING, 'provisioned'],
      [ServerLifecycleStatus.DEPROVISIONING, 'failed'],
      [ServerLifecycleStatus.PROVISIONED, 'provisioned'],
      [ServerLifecycleStatus.INVENTORY, 'inventory'],
    ])('maps lifecycle %s → %s', async (lifecycleStatus, expectedStatus) => {
      const device = makeDevice({ server: { lifecycleStatus } });
      repo.getDeviceByUuid.mockResolvedValue(device);

      await service.execute(deviceId);

      expect(repo.updateDevice).toHaveBeenCalledWith(device.id, expectedStatus, ServerPowerStatus.On);
    });

    it('maps DEPROVISIONING + deployment OS token → failed', async () => {
      const device = makeDevice({ server: { lifecycleStatus: ServerLifecycleStatus.DEPROVISIONING } });
      repo.getDeviceByUuid.mockResolvedValue(device);
      contextService.deviceIdentity = { context: DeviceTokenContext.DEPLOYMENT_OS };

      await service.execute(deviceId);

      expect(repo.updateDevice).toHaveBeenCalledWith(device.id, 'failed', ServerPowerStatus.On);
    });

    it('maps DEPROVISIONING + legacy Transit auth → failed', async () => {
      const device = makeDevice({ server: { lifecycleStatus: ServerLifecycleStatus.DEPROVISIONING } });
      repo.getDeviceByUuid.mockResolvedValue(device);

      await service.execute(deviceId);

      expect(repo.updateDevice).toHaveBeenCalledWith(device.id, 'failed', ServerPowerStatus.On);
    });

    describe('OFFLINE → deployment lookup', () => {
      it('maps OFFLINE → provisioned when an active deployment exists', async () => {
        const device = makeDevice({ server: { lifecycleStatus: ServerLifecycleStatus.OFFLINE } });
        repo.getDeviceByUuid.mockResolvedValue(device);
        repo.hasActiveDeployment.mockResolvedValue(true);

        await service.execute(deviceId);

        expect(repo.hasActiveDeployment).toHaveBeenCalledWith(device.id);
        expect(repo.updateDevice).toHaveBeenCalledWith(device.id, 'provisioned', ServerPowerStatus.On);
      });

      it('maps OFFLINE → inventory when no active deployment exists', async () => {
        const device = makeDevice({ server: { lifecycleStatus: ServerLifecycleStatus.OFFLINE } });
        repo.getDeviceByUuid.mockResolvedValue(device);
        repo.hasActiveDeployment.mockResolvedValue(false);

        await service.execute(deviceId);

        expect(repo.hasActiveDeployment).toHaveBeenCalledWith(device.id);
        expect(repo.updateDevice).toHaveBeenCalledWith(device.id, 'inventory', ServerPowerStatus.On);
      });

      it('keeps OFFLINE as offline for Brokkr Live with an active deployment', async () => {
        const device = makeDevice({ server: { lifecycleStatus: ServerLifecycleStatus.OFFLINE } });
        repo.getDeviceByUuid.mockResolvedValue(device);
        repo.hasActiveDeployment.mockResolvedValue(true);
        contextService.deviceIdentity = { context: DeviceTokenContext.BROKKR_LIVE };

        await service.execute(deviceId);

        expect(repo.hasActiveDeployment).toHaveBeenCalledWith(device.id);
        expect(repo.updateDevice).toHaveBeenCalledWith(device.id, 'offline', ServerPowerStatus.On);
        expect(qualifyOrchestration.handleDeviceProvisioned).not.toHaveBeenCalled();
      });

      it('keeps PROVISIONING as provisioning for Brokkr Live', async () => {
        const device = makeDevice({ server: { lifecycleStatus: ServerLifecycleStatus.PROVISIONING } });
        repo.getDeviceByUuid.mockResolvedValue(device);
        contextService.deviceIdentity = { context: DeviceTokenContext.BROKKR_LIVE };

        await service.execute(deviceId);

        expect(repo.updateDevice).toHaveBeenCalledWith(device.id, 'provisioning', ServerPowerStatus.On);
        expect(qualifyOrchestration.handleDeviceProvisioned).not.toHaveBeenCalled();
      });
    });

    describe('no Server row → never offline (a phone-home means the host is up)', () => {
      it('maps a missing Server row → provisioned when an active deployment exists', async () => {
        const device = makeDevice({ server: null });
        repo.getDeviceByUuid.mockResolvedValue(device);
        repo.hasActiveDeployment.mockResolvedValue(true);

        await service.execute(deviceId);

        expect(repo.updateDevice).toHaveBeenCalledWith(device.id, 'provisioned', ServerPowerStatus.On);
      });

      it('maps a missing Server row → inventory when no active deployment exists', async () => {
        const device = makeDevice({ server: null });
        repo.getDeviceByUuid.mockResolvedValue(device);
        repo.hasActiveDeployment.mockResolvedValue(false);

        await service.execute(deviceId);

        expect(repo.updateDevice).toHaveBeenCalledWith(device.id, 'inventory', ServerPowerStatus.On);
      });
    });
  });

  describe('triggers qualify orchestration on provisioned', () => {
    it('calls handleDeviceProvisioned when status transitions to provisioned', async () => {
      const device = makeDevice({ server: { lifecycleStatus: ServerLifecycleStatus.PROVISIONING } });
      repo.getDeviceByUuid.mockResolvedValue(device);

      await service.execute(deviceId);

      expect(qualifyOrchestration.handleDeviceProvisioned).toHaveBeenCalledWith(device.id);
    });

    it('does not call handleDeviceProvisioned when status stays as-is (non-provisioned)', async () => {
      const device = makeDevice({ server: { lifecycleStatus: ServerLifecycleStatus.INVENTORY } });
      repo.getDeviceByUuid.mockResolvedValue(device);

      await service.execute(deviceId);

      expect(qualifyOrchestration.handleDeviceProvisioned).not.toHaveBeenCalled();
    });
  });

  describe('validation', () => {
    it('throws NotFoundException when device does not exist', async () => {
      repo.getDeviceByUuid.mockResolvedValue(null);

      await expect(service.execute(deviceId)).rejects.toThrow(NotFoundException);
    });
  });

  describe('domain metrics', () => {
    it('records the processed counter and the lifecycle transition after the status write', async () => {
      const device = makeDevice({ server: { lifecycleStatus: ServerLifecycleStatus.PROVISIONING } });
      repo.getDeviceByUuid.mockResolvedValue(device);
      repo.updateDevice.mockResolvedValue({ transitioned: true });
      contextService.deviceIdentity = { context: DeviceTokenContext.DEPLOYMENT_OS };

      await service.execute(deviceId);

      expect(counterAdd).toHaveBeenCalledWith('brokkr.phone_home.processed', 1, {
        token_context: DeviceTokenContext.DEPLOYMENT_OS,
        resulting_status: 'provisioned',
      });
      expect(counterAdd).toHaveBeenCalledWith('brokkr.device_lifecycle.transitions', 1, {
        to_status: ServerLifecycleStatus.PROVISIONED,
        source: 'phone_home',
      });
    });

    it('labels token_context unknown when no device identity is on the context', async () => {
      const device = makeDevice({ server: { lifecycleStatus: ServerLifecycleStatus.INVENTORY } });
      repo.getDeviceByUuid.mockResolvedValue(device);

      await service.execute(deviceId);

      expect(counterAdd).toHaveBeenCalledWith('brokkr.phone_home.processed', 1, {
        token_context: 'unknown',
        resulting_status: 'inventory',
      });
    });

    it('does not count a same-status re-write as a transition', async () => {
      const device = makeDevice({ server: { lifecycleStatus: ServerLifecycleStatus.FAILED } });
      repo.getDeviceByUuid.mockResolvedValue(device);
      repo.updateDevice.mockResolvedValue({ transitioned: false });

      await service.execute(deviceId);

      expect(counterAdd).not.toHaveBeenCalledWith('brokkr.device_lifecycle.transitions', 1, expect.anything());
      expect(counterAdd).toHaveBeenCalledWith('brokkr.phone_home.processed', 1, {
        token_context: 'unknown',
        resulting_status: 'failed',
      });
    });

    it('counts a first-write transition when the device has no Server row yet (null server → provisioned)', async () => {
      const device = makeDevice({ server: null });
      repo.getDeviceByUuid.mockResolvedValue(device);
      repo.hasActiveDeployment.mockResolvedValue(true);
      repo.updateDevice.mockResolvedValue({ transitioned: true });

      await service.execute(deviceId);

      expect(repo.updateDevice).toHaveBeenCalledWith(device.id, 'provisioned', ServerPowerStatus.On);
      expect(counterAdd).toHaveBeenCalledWith('brokkr.device_lifecycle.transitions', 1, {
        to_status: ServerLifecycleStatus.PROVISIONED,
        source: 'phone_home',
      });
    });

    it('counts a DEPROVISIONING → FAILED transition (deployed OS booted again during wipe)', async () => {
      const device = makeDevice({ server: { lifecycleStatus: ServerLifecycleStatus.DEPROVISIONING } });
      repo.getDeviceByUuid.mockResolvedValue(device);
      repo.updateDevice.mockResolvedValue({ transitioned: true });
      contextService.deviceIdentity = { context: DeviceTokenContext.DEPLOYMENT_OS };

      await service.execute(deviceId);

      expect(repo.updateDevice).toHaveBeenCalledWith(device.id, 'failed', ServerPowerStatus.On);
      expect(counterAdd).toHaveBeenCalledWith('brokkr.device_lifecycle.transitions', 1, {
        to_status: ServerLifecycleStatus.FAILED,
        source: 'phone_home',
      });
    });

    it('pre-registers the FAILED series at zero so alert rate()/increase() sees the first failure', () => {
      expect(constructionAdds).toContainEqual([
        'brokkr.device_lifecycle.transitions',
        0,
        { to_status: ServerLifecycleStatus.FAILED, source: 'phone_home' },
      ]);
    });

    it('records nothing when the status write fails', async () => {
      const device = makeDevice();
      repo.getDeviceByUuid.mockResolvedValue(device);
      repo.updateDevice.mockRejectedValue(new Error('db down'));

      await expect(service.execute(deviceId)).rejects.toThrow('db down');

      expect(counterAdd).not.toHaveBeenCalled();
    });
  });

  describe('maybeEnqueueDiscovery', () => {
    it.each([
      [ServerLifecycleStatus.PROVISIONED],
      [ServerLifecycleStatus.DEPROVISIONING],
      [ServerLifecycleStatus.PROVISIONING],
    ])('does not enqueue when lifecycle is %s', async (lifecycleStatus) => {
      const device = makeDevice({ server: { lifecycleStatus } });
      repo.getDeviceByUuid.mockResolvedValue(device);

      await service.execute(deviceId);

      expect(bridgeInventoryCollection.startInventoryCollection).not.toHaveBeenCalled();
    });

    it('enqueues inventory_collection when OFFLINE → inventory (no active deployment)', async () => {
      const device = makeDevice({ server: { lifecycleStatus: ServerLifecycleStatus.OFFLINE } });
      repo.getDeviceByUuid.mockResolvedValue(device);
      repo.hasActiveDeployment.mockResolvedValue(false);

      await service.execute(deviceId);

      expect(bridgeInventoryCollection.startInventoryCollection).toHaveBeenCalledTimes(1);
    });

    it('does not enqueue when OFFLINE → provisioned (active deployment exists)', async () => {
      const device = makeDevice({ server: { lifecycleStatus: ServerLifecycleStatus.OFFLINE } });
      repo.getDeviceByUuid.mockResolvedValue(device);
      repo.hasActiveDeployment.mockResolvedValue(true);

      await service.execute(deviceId);

      expect(bridgeInventoryCollection.startInventoryCollection).not.toHaveBeenCalled();
    });

    it('enqueues inventory_collection when status is inventory', async () => {
      const device = makeDevice({ server: { lifecycleStatus: ServerLifecycleStatus.INVENTORY } });
      repo.getDeviceByUuid.mockResolvedValue(device);

      await service.execute(deviceId);

      expect(bridgeInventoryCollection.startInventoryCollection).toHaveBeenCalledExactlyOnceWith(
        device.id,
        'zone-abc',
        'phone-home',
      );
    });

    it('does not enqueue when device is in inventory but has no zoneId', async () => {
      const device = makeDevice({ server: { lifecycleStatus: ServerLifecycleStatus.INVENTORY }, zoneId: null });
      repo.getDeviceByUuid.mockResolvedValue(device);

      await service.execute(deviceId);

      expect(bridgeInventoryCollection.startInventoryCollection).not.toHaveBeenCalled();
    });

    it('swallows enqueue errors without failing phone-home', async () => {
      const device = makeDevice({ server: { lifecycleStatus: ServerLifecycleStatus.INVENTORY } });
      repo.getDeviceByUuid.mockResolvedValue(device);
      bridgeInventoryCollection.startInventoryCollection.mockRejectedValue(new Error('redis down'));

      const result = await service.execute(deviceId);

      expect(result).toEqual({ deviceId });
    });
  });
});
