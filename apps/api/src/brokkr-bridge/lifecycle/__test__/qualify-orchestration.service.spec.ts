import { Test, TestingModule } from '@nestjs/testing';
import { ServerLifecycleStatus } from '@repo/database';
import { REDIS_CLIENT } from 'src/common/redis';
import { PrismaClient } from 'src/prisma/prisma.client';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { BridgeDeprovisionService } from '../deprovision.service';
import { LifecyclePreparationService } from '../lifecycle-preparation.service';
import { BridgeCommissioningService } from '../commissioning.service';
import { QualifyOrchestrationService } from '../qualify-orchestration.service';

const DEVICE_ID = '550e8400-e29b-41d4-a716-446655440099';
const ZONE_PREFIX = 'zone-1';
const JOB_ID = 'job-qualify-1';

describe('QualifyOrchestrationService', () => {
  let service: QualifyOrchestrationService;
  let qualifyLookup: Mock;
  let findUnique: Mock;
  let update: Mock;
  let updateMany: Mock;
  let serverCreateMany: Mock;
  let serverUpdateMany: Mock;
  let deploymentUpdateMany: Mock;
  let redisEval: Mock;
  let redisGet: Mock;
  let enqueueQualifyProvision: Mock;
  let prepareForDeprovision: Mock;
  let deprovisionDevice: Mock;

  beforeEach(async () => {
    qualifyLookup = vi.fn();
    findUnique = vi.fn();
    update = vi.fn().mockResolvedValue({});
    updateMany = vi.fn().mockResolvedValue({ count: 1 });
    serverCreateMany = vi.fn().mockResolvedValue({ count: 1 });
    serverUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
    deploymentUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
    redisEval = vi.fn().mockResolvedValue(1);
    redisGet = vi.fn().mockResolvedValue(null);
    enqueueQualifyProvision = vi.fn().mockResolvedValue(undefined);
    prepareForDeprovision = vi.fn().mockResolvedValue(undefined);
    deprovisionDevice = vi.fn().mockResolvedValue({ success: true });

    const prisma = {
      device: {
        findUnique: vi.fn((args: { where: Record<string, unknown> }) =>
          'role' in args.where ? qualifyLookup(args) : findUnique(args),
        ),
        update,
        updateMany,
      },
      server: { createMany: serverCreateMany, updateMany: serverUpdateMany },
      deployment: { updateMany: deploymentUpdateMany },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QualifyOrchestrationService,
        { provide: PrismaClient, useValue: prisma as unknown as PrismaClient },
        { provide: BridgeDeprovisionService, useValue: { deprovisionDevice } },
        { provide: BridgeCommissioningService, useValue: { enqueueQualifyProvision } },
        { provide: LifecyclePreparationService, useValue: { prepareForDeprovision } },
        { provide: REDIS_CLIENT, useValue: { eval: redisEval, get: redisGet } },
        {
          provide: `LoggerService${QualifyOrchestrationService.name}`,
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

    service = module.get(QualifyOrchestrationService);
  });

  afterEach(() => vi.clearAllMocks());

  describe('isQualifyDevice', () => {
    it('returns true when a role=null, live device row exists', async () => {
      qualifyLookup.mockResolvedValueOnce({ id: DEVICE_ID });
      await expect(service.isQualifyDevice(DEVICE_ID)).resolves.toBe(true);
      expect(qualifyLookup).toHaveBeenCalledWith({
        where: { id: DEVICE_ID, role: null, deletedAt: null },
        select: { id: true },
      });
    });

    it('returns false when no matching device row exists', async () => {
      qualifyLookup.mockResolvedValueOnce(null);
      await expect(service.isQualifyDevice(DEVICE_ID)).resolves.toBe(false);
    });
  });

  describe('handleDiscoveryCompleteForCommission', () => {
    it('claims via create (first commission: no Server row) and enqueues qualify', async () => {
      qualifyLookup.mockResolvedValueOnce({ id: DEVICE_ID });
      serverUpdateMany.mockResolvedValueOnce({ count: 0 });
      serverCreateMany.mockResolvedValueOnce({ count: 1 });

      await service.handleDiscoveryCompleteForCommission(DEVICE_ID, ZONE_PREFIX, JOB_ID, null);

      expect(serverUpdateMany).toHaveBeenCalledWith({
        where: { deviceId: DEVICE_ID, lifecycleStatus: ServerLifecycleStatus.FAILED },
        data: { lifecycleStatus: ServerLifecycleStatus.PROVISIONING },
      });
      expect(serverCreateMany).toHaveBeenCalledWith({
        data: { deviceId: DEVICE_ID, lifecycleStatus: ServerLifecycleStatus.PROVISIONING },
        skipDuplicates: true,
      });
      expect(updateMany).toHaveBeenCalledWith({
        where: { id: DEVICE_ID, zoneId: null },
        data: { zoneId: ZONE_PREFIX },
      });
      expect(enqueueQualifyProvision).toHaveBeenCalledOnce();
      expect(enqueueQualifyProvision).toHaveBeenCalledWith(DEVICE_ID, expect.any(String), null);
    });

    it('re-claims a FAILED Server row on retry and enqueues qualify (no createMany)', async () => {
      qualifyLookup.mockResolvedValueOnce({ id: DEVICE_ID });
      serverUpdateMany.mockResolvedValueOnce({ count: 1 });

      await service.handleDiscoveryCompleteForCommission(DEVICE_ID, ZONE_PREFIX, JOB_ID, null);

      expect(serverUpdateMany).toHaveBeenCalledWith({
        where: { deviceId: DEVICE_ID, lifecycleStatus: ServerLifecycleStatus.FAILED },
        data: { lifecycleStatus: ServerLifecycleStatus.PROVISIONING },
      });
      expect(serverCreateMany).not.toHaveBeenCalled();
      expect(enqueueQualifyProvision).toHaveBeenCalledOnce();
    });

    it('does nothing when the device is not a qualify device (role != null)', async () => {
      qualifyLookup.mockResolvedValueOnce(null);

      await service.handleDiscoveryCompleteForCommission(DEVICE_ID, ZONE_PREFIX, JOB_ID, null);

      expect(serverUpdateMany).not.toHaveBeenCalled();
      expect(serverCreateMany).not.toHaveBeenCalled();
      expect(enqueueQualifyProvision).not.toHaveBeenCalled();
    });

    it('does NOT enqueue qualify when the claim is lost (device already mid-qualify)', async () => {
      qualifyLookup.mockResolvedValueOnce({ id: DEVICE_ID });
      serverUpdateMany.mockResolvedValueOnce({ count: 0 });
      serverCreateMany.mockResolvedValueOnce({ count: 0 });

      await service.handleDiscoveryCompleteForCommission(DEVICE_ID, ZONE_PREFIX, JOB_ID, null);

      expect(enqueueQualifyProvision).not.toHaveBeenCalled();
    });
  });

  describe('handleDiscoveryRunFailure', () => {
    it('marks FAILED when the device is not yet saga-driven (lifecycle null — commission-discovery phase)', async () => {
      qualifyLookup.mockResolvedValue({ id: DEVICE_ID });
      findUnique.mockResolvedValue({ server: { lifecycleStatus: null } });

      await service.handleDiscoveryRunFailure(DEVICE_ID, 'discovery run failed');

      expect(update).toHaveBeenCalled();
      const failWrite = update.mock.calls.find((c) => JSON.stringify(c[0]).includes('FAILED'));
      expect(failWrite, 'expected a FAILED upsert').toBeTruthy();
    });

    it.each([
      ServerLifecycleStatus.PROVISIONING,
      ServerLifecycleStatus.PROVISIONED,
      ServerLifecycleStatus.DEPROVISIONING,
    ])('does NOT clobber an in-flight qualify device (lifecycle %s) — the saga owns failures', async (lc) => {
      qualifyLookup.mockResolvedValue({ id: DEVICE_ID });
      findUnique.mockResolvedValueOnce({ server: { lifecycleStatus: lc } });

      await service.handleDiscoveryRunFailure(DEVICE_ID, 'stray discovery run failed');

      const failWrite = update.mock.calls.find((c) => JSON.stringify(c[0]).includes('FAILED'));
      expect(failWrite).toBeFalsy();
    });
  });

  describe('handleDeviceProvisioned', () => {
    it('deprovisions when device is role=null and lifecycle is PROVISIONED', async () => {
      qualifyLookup.mockResolvedValue({ id: DEVICE_ID });
      findUnique
        .mockResolvedValueOnce({ server: { lifecycleStatus: ServerLifecycleStatus.PROVISIONED } })
        .mockResolvedValue({ lastJobId: JOB_ID, zoneId: ZONE_PREFIX });

      await service.handleDeviceProvisioned(DEVICE_ID);

      expect(prepareForDeprovision).toHaveBeenCalledWith(DEVICE_ID, expect.any(String));
      expect(deprovisionDevice).toHaveBeenCalledWith(DEVICE_ID, expect.any(String));
    });

    it('does NOT deprovision when lifecycle is INVENTORY (done device re-PXE)', async () => {
      qualifyLookup.mockResolvedValue({ id: DEVICE_ID });
      findUnique.mockResolvedValueOnce({ server: { lifecycleStatus: ServerLifecycleStatus.INVENTORY } });

      await service.handleDeviceProvisioned(DEVICE_ID);

      expect(prepareForDeprovision).not.toHaveBeenCalled();
      expect(deprovisionDevice).not.toHaveBeenCalled();
    });

    it('does nothing when the device is not a qualify device (role != null)', async () => {
      qualifyLookup.mockResolvedValue(null);

      await service.handleDeviceProvisioned(DEVICE_ID);

      expect(findUnique).not.toHaveBeenCalled();
      expect(deprovisionDevice).not.toHaveBeenCalled();
    });
  });

  describe('handleQualifyFailure', () => {
    it('does NOT mark FAILED when lifecycle is already INVENTORY (qualified)', async () => {
      qualifyLookup.mockResolvedValueOnce({ id: DEVICE_ID });
      findUnique.mockResolvedValueOnce({ server: { lifecycleStatus: ServerLifecycleStatus.INVENTORY } });

      await service.handleQualifyFailure(DEVICE_ID, 'late saga failure');

      expect(update).not.toHaveBeenCalled();
      expect(deploymentUpdateMany).not.toHaveBeenCalled();
    });

    it('upserts the Server to FAILED when not yet qualified (lifecycle PROVISIONING)', async () => {
      qualifyLookup.mockResolvedValueOnce({ id: DEVICE_ID });
      findUnique.mockResolvedValueOnce({ server: { lifecycleStatus: ServerLifecycleStatus.PROVISIONING } });

      await service.handleQualifyFailure(DEVICE_ID, 'qualify failed');

      expect(update).toHaveBeenCalledWith({
        where: { id: DEVICE_ID, deletedAt: null },
        data: {
          server: {
            upsert: {
              create: { lifecycleStatus: ServerLifecycleStatus.FAILED },
              update: { lifecycleStatus: ServerLifecycleStatus.FAILED },
            },
          },
        },
      });
    });

    it('upserts (create path) to FAILED when the device has no Server row', async () => {
      qualifyLookup.mockResolvedValueOnce({ id: DEVICE_ID });
      findUnique.mockResolvedValueOnce({ server: null });

      await service.handleQualifyFailure(DEVICE_ID, 'enqueue failed');

      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            server: {
              upsert: {
                create: { lifecycleStatus: ServerLifecycleStatus.FAILED },
                update: { lifecycleStatus: ServerLifecycleStatus.FAILED },
              },
            },
          },
        }),
      );
    });

    it('does nothing when the device is not a qualify device (role != null)', async () => {
      qualifyLookup.mockResolvedValueOnce(null);

      await service.handleQualifyFailure(DEVICE_ID, 'whatever');

      expect(findUnique).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });
  });

  describe('promoteQualifyDevice', () => {
    it('promotes (Server -> INVENTORY) when lifecycle is DEPROVISIONING', async () => {
      qualifyLookup.mockResolvedValue({ id: DEVICE_ID });
      findUnique
        .mockResolvedValueOnce({
          id: DEVICE_ID,
          lastJobId: JOB_ID,
          server: { lifecycleStatus: ServerLifecycleStatus.DEPROVISIONING },
        })
        .mockResolvedValue({ zoneId: ZONE_PREFIX });

      await service.promoteQualifyDevice(DEVICE_ID);

      expect(update).toHaveBeenCalledWith({
        where: { id: DEVICE_ID },
        data: {
          lastJobId: JOB_ID,
          server: { update: { lifecycleStatus: ServerLifecycleStatus.INVENTORY } },
        },
      });
    });

    it('is a no-op when lifecycle is not DEPROVISIONING (e.g. PROVISIONING)', async () => {
      qualifyLookup.mockResolvedValue({ id: DEVICE_ID });
      findUnique.mockResolvedValueOnce({
        id: DEVICE_ID,
        lastJobId: JOB_ID,
        server: { lifecycleStatus: ServerLifecycleStatus.PROVISIONING },
      });

      await service.promoteQualifyDevice(DEVICE_ID);

      expect(update).not.toHaveBeenCalled();
    });

    it('does nothing when the device is not a qualify device (role != null)', async () => {
      qualifyLookup.mockResolvedValue(null);

      await service.promoteQualifyDevice(DEVICE_ID);

      expect(findUnique).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });
  });
});
