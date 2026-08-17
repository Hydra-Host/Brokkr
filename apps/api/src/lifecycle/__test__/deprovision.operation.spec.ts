import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DeviceTokenRevocationReason } from '@repo/database';
import { BridgeDeprovisionService } from 'src/brokkr-bridge/lifecycle/deprovision.service';
import { LifecyclePreparationService } from 'src/brokkr-bridge/lifecycle/lifecycle-preparation.service';
import { DeploymentRecord } from 'src/deployments/deployment.record';
import { DeviceTokensService } from 'src/device-tokens/device-tokens.service';
import { ReservationRecord } from 'src/reservations/reservation.record';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeprovisionOperation } from '../operations/deprovision.operation';

type FindAggregate = typeof DeploymentRecord.findAggregateUnscoped;
type FindOne = typeof DeploymentRecord.findOneUnscoped;

describe('DeprovisionOperation', () => {
  const lifecyclePrep = { prepareForDeprovision: vi.fn().mockResolvedValue(undefined) };
  const bridgeDeprovision = { deprovisionDevice: vi.fn().mockResolvedValue({ success: true }) };
  const deviceTokens = {
    revokeDeploymentTokensForDevice: vi.fn().mockResolvedValue(undefined),
    revokeBrokkrLiveTokensForDevice: vi.fn().mockResolvedValue(undefined),
    runWithDeploymentTokenRevocation: vi
      .fn()
      .mockImplementation(async (_args: unknown, action: (tx: unknown) => Promise<unknown>) => action({ tx: true })),
  };

  let operation: DeprovisionOperation;

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        DeprovisionOperation,
        { provide: LifecyclePreparationService, useValue: lifecyclePrep },
        { provide: BridgeDeprovisionService, useValue: bridgeDeprovision },
        { provide: DeviceTokensService, useValue: deviceTokens },
      ],
    }).compile();
    operation = moduleRef.get(DeprovisionOperation);
  });

  describe('assembleContext', () => {
    it('returns the active deployment id', async () => {
      vi.spyOn(DeploymentRecord, 'findAggregateUnscoped').mockResolvedValue({
        id: 'dep-1',
      } as Awaited<ReturnType<FindAggregate>>);

      await expect(operation.assembleContext('device-1', 'org-1')).resolves.toEqual({ deploymentId: 'dep-1' });
    });

    it('throws when there is no active deployment', async () => {
      vi.spyOn(DeploymentRecord, 'findAggregateUnscoped').mockResolvedValue(null);
      await expect(operation.assembleContext('device-1', 'org-1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('dispatch', () => {
    it('prepares and enqueues the bridge wipe, THEN ends the deployment', async () => {
      const record = {
        data: { isLocked: false },
        endDeployment: vi.fn().mockReturnThis(),
        save: vi.fn().mockResolvedValue(undefined),
      };
      vi.spyOn(DeploymentRecord, 'findOneUnscoped').mockResolvedValue(
        record as unknown as Awaited<ReturnType<FindOne>>,
      );

      await operation.dispatch({
        deviceId: 'device-1',
        organizationId: 'org-1',
        deploymentId: 'dep-1',
        jobId: 'job-1',
      });

      expect(lifecyclePrep.prepareForDeprovision).toHaveBeenCalledWith('device-1', 'job-1');
      expect(bridgeDeprovision.deprovisionDevice).toHaveBeenCalledWith('device-1', 'job-1');
      expect(record.endDeployment).toHaveBeenCalled();
      expect(record.save).toHaveBeenCalledWith({ tx: { tx: true } });
      expect(deviceTokens.runWithDeploymentTokenRevocation).toHaveBeenCalledWith(
        {
          deviceId: 'device-1',
          reason: DeviceTokenRevocationReason.DEPLOYMENT_ENDED,
          note: 'Deployment ended by deprovision job job-1',
        },
        expect.any(Function),
      );
      expect(deviceTokens.revokeBrokkrLiveTokensForDevice).not.toHaveBeenCalled();

      const enqueueOrder = bridgeDeprovision.deprovisionDevice.mock.invocationCallOrder[0];
      const endOrder = record.endDeployment.mock.invocationCallOrder[0];
      expect(enqueueOrder).toBeLessThan(endOrder);
    });

    it('ends the linked provision reservation after ending the deployment', async () => {
      const record = {
        data: { isLocked: false, reservationId: 'res-1' },
        endDeployment: vi.fn().mockReturnThis(),
        save: vi.fn().mockResolvedValue(undefined),
      };
      vi.spyOn(DeploymentRecord, 'findOneUnscoped').mockResolvedValue(
        record as unknown as Awaited<ReturnType<FindOne>>,
      );
      const endReservation = vi.spyOn(ReservationRecord, 'endActiveByIdUnscoped').mockResolvedValue(true);

      await operation.dispatch({
        deviceId: 'device-1',
        organizationId: 'org-1',
        deploymentId: 'dep-1',
        jobId: 'job-1',
      });

      expect(endReservation).toHaveBeenCalledWith('res-1', { tx: true });
      expect(record.endDeployment.mock.invocationCallOrder[0]).toBeLessThan(endReservation.mock.invocationCallOrder[0]);
    });

    it('fails the dispatch (retryable) when the reservation end fails inside the transaction', async () => {
      const record = {
        data: { isLocked: false, reservationId: 'res-1' },
        endDeployment: vi.fn().mockReturnThis(),
        save: vi.fn().mockResolvedValue(undefined),
      };
      vi.spyOn(DeploymentRecord, 'findOneUnscoped').mockResolvedValue(
        record as unknown as Awaited<ReturnType<FindOne>>,
      );
      vi.spyOn(ReservationRecord, 'endActiveByIdUnscoped').mockRejectedValue(new Error('db down'));

      await expect(
        operation.dispatch({
          deviceId: 'device-1',
          organizationId: 'org-1',
          deploymentId: 'dep-1',
          jobId: 'job-1',
        }),
      ).rejects.toThrow('db down');
    });

    it('skips reservation end when the deployment has no linked reservation', async () => {
      const record = {
        data: { isLocked: false, reservationId: null },
        endDeployment: vi.fn().mockReturnThis(),
        save: vi.fn().mockResolvedValue(undefined),
      };
      vi.spyOn(DeploymentRecord, 'findOneUnscoped').mockResolvedValue(
        record as unknown as Awaited<ReturnType<FindOne>>,
      );
      const endReservation = vi.spyOn(ReservationRecord, 'endActiveByIdUnscoped').mockResolvedValue(false);

      await operation.dispatch({
        deviceId: 'device-1',
        organizationId: 'org-1',
        deploymentId: 'dep-1',
        jobId: 'job-1',
      });

      expect(endReservation).not.toHaveBeenCalled();
    });

    it('leaves the deployment active when the bridge enqueue fails (retryable)', async () => {
      const record = {
        data: { isLocked: false },
        endDeployment: vi.fn().mockReturnThis(),
        save: vi.fn().mockResolvedValue(undefined),
      };
      vi.spyOn(DeploymentRecord, 'findOneUnscoped').mockResolvedValue(
        record as unknown as Awaited<ReturnType<FindOne>>,
      );
      bridgeDeprovision.deprovisionDevice.mockRejectedValueOnce(new Error('bridge unreachable'));

      await expect(
        operation.dispatch({
          deviceId: 'device-1',
          organizationId: 'org-1',
          deploymentId: 'dep-1',
          jobId: 'job-1',
        }),
      ).rejects.toThrow('bridge unreachable');

      expect(record.endDeployment).not.toHaveBeenCalled();
      expect(record.save).not.toHaveBeenCalled();
    });

    it('aborts the wipe when the deployment can no longer be loaded', async () => {
      vi.spyOn(DeploymentRecord, 'findOneUnscoped').mockResolvedValue(null);

      await expect(
        operation.dispatch({
          deviceId: 'device-1',
          organizationId: 'org-1',
          deploymentId: 'dep-1',
          jobId: 'job-1',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(lifecyclePrep.prepareForDeprovision).not.toHaveBeenCalled();
      expect(bridgeDeprovision.deprovisionDevice).not.toHaveBeenCalled();
      expect(deviceTokens.revokeDeploymentTokensForDevice).toHaveBeenCalledWith(
        'device-1',
        DeviceTokenRevocationReason.DEPLOYMENT_ENDED,
        'Deployment missing during deprovision job job-1',
      );
    });

    it('rejects a locked deployment before touching the device', async () => {
      const record = {
        data: { isLocked: true },
        endDeployment: vi.fn().mockReturnThis(),
        save: vi.fn().mockResolvedValue(undefined),
      };
      vi.spyOn(DeploymentRecord, 'findOneUnscoped').mockResolvedValue(
        record as unknown as Awaited<ReturnType<FindOne>>,
      );

      await expect(
        operation.dispatch({
          deviceId: 'device-1',
          organizationId: 'org-1',
          deploymentId: 'dep-1',
          jobId: 'job-1',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(lifecyclePrep.prepareForDeprovision).not.toHaveBeenCalled();
      expect(bridgeDeprovision.deprovisionDevice).not.toHaveBeenCalled();
      expect(record.endDeployment).not.toHaveBeenCalled();
      expect(deviceTokens.runWithDeploymentTokenRevocation).not.toHaveBeenCalled();
    });
  });

  describe('dispatchWithoutDeployment', () => {
    it('prepares and enqueues the wipe when no active deployment exists', async () => {
      vi.spyOn(DeploymentRecord, 'findAggregateUnscoped').mockResolvedValue(null);

      await operation.dispatchWithoutDeployment({ deviceId: 'device-1', jobId: 'job-1' });

      expect(lifecyclePrep.prepareForDeprovision).toHaveBeenCalledWith('device-1', 'job-1');
      expect(bridgeDeprovision.deprovisionDevice).toHaveBeenCalledWith('device-1', 'job-1');
      expect(lifecyclePrep.prepareForDeprovision.mock.invocationCallOrder[0]).toBeLessThan(
        bridgeDeprovision.deprovisionDevice.mock.invocationCallOrder[0],
      );
    });

    it('rejects when an active deployment appeared before the wipe', async () => {
      vi.spyOn(DeploymentRecord, 'findAggregateUnscoped').mockResolvedValue({
        id: 'dep-1',
      } as Awaited<ReturnType<FindAggregate>>);

      await expect(operation.dispatchWithoutDeployment({ deviceId: 'device-1', jobId: 'job-1' })).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(lifecyclePrep.prepareForDeprovision).not.toHaveBeenCalled();
      expect(bridgeDeprovision.deprovisionDevice).not.toHaveBeenCalled();
    });

    it('does not enqueue the wipe when preparation fails', async () => {
      vi.spyOn(DeploymentRecord, 'findAggregateUnscoped').mockResolvedValue(null);
      lifecyclePrep.prepareForDeprovision.mockRejectedValueOnce(new Error('prep failed'));

      await expect(operation.dispatchWithoutDeployment({ deviceId: 'device-1', jobId: 'job-1' })).rejects.toThrow(
        'prep failed',
      );
      expect(bridgeDeprovision.deprovisionDevice).not.toHaveBeenCalled();
    });

    it('rethrows when the bridge enqueue fails', async () => {
      vi.spyOn(DeploymentRecord, 'findAggregateUnscoped').mockResolvedValue(null);
      bridgeDeprovision.deprovisionDevice.mockRejectedValueOnce(new Error('bridge unreachable'));

      await expect(operation.dispatchWithoutDeployment({ deviceId: 'device-1', jobId: 'job-1' })).rejects.toThrow(
        'bridge unreachable',
      );
      expect(lifecyclePrep.prepareForDeprovision).toHaveBeenCalledWith('device-1', 'job-1');
    });
  });
});
