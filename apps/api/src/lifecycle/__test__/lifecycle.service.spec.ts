import { LifecycleGateDeferral, LifecycleGateRejection, PLUGIN_EVENT_BUS } from '@hydrahost/plugin-sdk';
import { getQueueToken } from '@nestjs/bullmq';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ActiveRecordRegistry } from '@repo/active-record';
import { JobType, LifecycleJobPhase, Prisma, RequestSource } from '@repo/database';
import { TRANSITIONAL_SERVER_POWER_STATUSES } from '@repo/device-domain';
import {
  LIFECYCLE_SCHEDULED_QUEUE,
  LIFECYCLE_WATCHDOG_QUEUE,
  LifecycleJobRecord,
  POWER_WATCHDOG_JOB,
  START_LINKED_PROVISION_JOB,
} from '@repo/lifecycle';
import { DeploymentRecord } from 'src/deployments/deployment.record';
import { GateUnavailableError, HostPluginGateBus } from 'src/plugin-host/host-plugin-gate-bus';
import { ReservationsService } from 'src/reservations/reservations.service';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClusterNetworkService } from '../cluster-network.service';
import { LifecycleService } from '../lifecycle.service';
import { DeprovisionOperation } from '../operations/deprovision.operation';
import { PowerControlOperation } from '../operations/power-control.operation';
import { ProvisionOperation } from '../operations/provision.operation';
import { RebootOperation } from '../operations/reboot.operation';
import { ReprovisionOperation } from '../operations/reprovision.operation';

function makeMockClient() {
  let row: Record<string, unknown> = {};
  let nextJobId = 0;
  return {
    lifecycleJob: {
      create: vi.fn((args: { data: Record<string, unknown> }) => {
        row = {
          id: `job-${++nextJobId}`,
          deploymentId: null,
          scheduledAt: null,
          phoneHomeDeadline: null,
          linkedJobId: null,
          error: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...args.data,
        };
        return row;
      }),
      update: vi.fn((args: { data: Record<string, unknown> }) => {
        row = { ...row, ...args.data, updatedAt: new Date() };
        return row;
      }),
      updateMany: vi.fn((args: { data: Record<string, unknown> }) => {
        row = { ...row, ...args.data, updatedAt: new Date() };
        return { count: 1 };
      }),
    },
    interruptibleClaim: {
      create: vi.fn().mockResolvedValue({ id: 'claim-1' }),
      update: vi.fn().mockResolvedValue({ id: 'claim-1' }),
      delete: vi.fn().mockResolvedValue({ id: 'claim-1' }),
    },
    adminLifecycleRequest: {
      create: vi.fn().mockResolvedValue({ id: 'request-1' }),
    },
    server: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

describe('LifecycleService', () => {
  const eventBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
  const gateBus = { runGate: vi.fn().mockResolvedValue(undefined), register: vi.fn(), markFailClosed: vi.fn() };
  const rebootOperation = { dispatch: vi.fn().mockResolvedValue(undefined) };
  const powerControlOperation = { dispatch: vi.fn().mockResolvedValue(undefined) };
  const deprovisionOperation = {
    assembleContext: vi.fn().mockResolvedValue({ deploymentId: 'dep-1' }),
    dispatch: vi.fn().mockResolvedValue(undefined),
    dispatchWithoutDeployment: vi.fn().mockResolvedValue(undefined),
  };
  const reprovisionOperation = {
    assembleContext: vi
      .fn()
      .mockResolvedValue({ baseLayerId: 'layer-1', organizationId: 'org-1', deploymentId: 'dep-1', pubkeys: ['k'] }),
    dispatch: vi.fn().mockResolvedValue(undefined),
  };
  const provisionOperation = {
    assembleContext: vi.fn().mockResolvedValue({ baseLayerId: 'layer-1', pubkeys: ['k'] }),
    assembleContextForReplay: vi.fn().mockResolvedValue({ baseLayerId: 'layer-1', pubkeys: ['k'] }),
    assembleContextForResume: vi.fn().mockResolvedValue({ pubkeys: ['k'] }),
    createReservation: vi.fn().mockResolvedValue('res-1'),
    createDeployment: vi.fn().mockResolvedValue('dep-1'),
    acceptInvite: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(undefined),
  };
  const reservationsService = { endReservation: vi.fn().mockResolvedValue(undefined) };
  const clusterNetwork = {
    attach: vi.fn().mockResolvedValue(undefined),
    detach: vi.fn().mockResolvedValue(undefined),
  };
  const scheduledQueue = { add: vi.fn().mockResolvedValue({ id: 'bull-1' }) };
  const watchdogQueue = { add: vi.fn().mockResolvedValue({ id: 'bull-2' }) };

  let service: LifecycleService;
  let client: ReturnType<typeof makeMockClient>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    gateBus.runGate.mockResolvedValue(undefined);
    deprovisionOperation.assembleContext.mockResolvedValue({ deploymentId: 'dep-1' });
    reprovisionOperation.assembleContext.mockResolvedValue({
      baseLayerId: 'layer-1',
      organizationId: 'org-1',
      deploymentId: 'dep-1',
      pubkeys: ['k'],
    });
    provisionOperation.assembleContext.mockResolvedValue({ baseLayerId: 'layer-1', pubkeys: ['k'] });
    provisionOperation.assembleContextForReplay.mockResolvedValue({ baseLayerId: 'layer-1', pubkeys: ['k'] });
    provisionOperation.assembleContextForResume.mockResolvedValue({ pubkeys: ['k'] });
    provisionOperation.createReservation.mockResolvedValue('res-1');
    provisionOperation.createDeployment.mockResolvedValue('dep-1');
    reservationsService.endReservation.mockResolvedValue(undefined);
    client = makeMockClient();
    ActiveRecordRegistry.configureForTest(client, null);
    const moduleRef = await Test.createTestingModule({
      providers: [
        LifecycleService,
        { provide: PLUGIN_EVENT_BUS, useValue: eventBus },
        { provide: HostPluginGateBus, useValue: gateBus },
        { provide: RebootOperation, useValue: rebootOperation },
        { provide: PowerControlOperation, useValue: powerControlOperation },
        { provide: DeprovisionOperation, useValue: deprovisionOperation },
        { provide: ReprovisionOperation, useValue: reprovisionOperation },
        { provide: ProvisionOperation, useValue: provisionOperation },
        { provide: ReservationsService, useValue: reservationsService },
        { provide: ClusterNetworkService, useValue: clusterNetwork },
        { provide: getQueueToken(LIFECYCLE_SCHEDULED_QUEUE), useValue: scheduledQueue },
        { provide: getQueueToken(LIFECYCLE_WATCHDOG_QUEUE), useValue: watchdogQueue },
        {
          provide: 'LoggerServiceLifecycleService',
          useValue: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        },
      ],
    }).compile();
    service = moduleRef.get(LifecycleService);
  });

  afterEach(() => {
    ActiveRecordRegistry.configureForTest(null, null);
  });

  it('reboot walks REQUESTED → AUTHORIZING → DISPATCHED, dispatches, then emits', async () => {
    const job = await service.requestReboot({
      deviceId: 'device-1',
      userId: 'user-1',
      organizationId: 'org-1',
      source: RequestSource.API,
    });

    expect(rebootOperation.dispatch).toHaveBeenCalledWith('device-1', 'job-1');
    expect(job.data.phase).toBe(LifecycleJobPhase.DISPATCHED);
    expect(eventBus.emit).toHaveBeenCalledWith(
      'lifecycle.dispatched',
      expect.objectContaining({ jobId: 'job-1', jobType: JobType.Reboot, deviceId: 'device-1', deploymentId: null }),
    );
  });

  it('power control picks PowerOn / PowerOff by operation and passes it to dispatch', async () => {
    await service.requestPowerControl({
      deviceId: 'd',
      userId: 'u',
      organizationId: 'o',
      source: RequestSource.UI,
      operation: 'on',
    });
    expect(powerControlOperation.dispatch).toHaveBeenCalledWith('d', 'job-1', 'on');
    expect(eventBus.emit).toHaveBeenCalledWith(
      'lifecycle.dispatched',
      expect.objectContaining({ jobType: JobType.PowerOn }),
    );
  });

  it('persists the deployment id on reboot and power jobs when supplied', async () => {
    await service.requestReboot({
      deviceId: 'device-1',
      deploymentId: 'dep-1',
      userId: 'user-1',
      organizationId: 'org-1',
      source: RequestSource.API,
    });
    expect(client.lifecycleJob.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ jobType: JobType.Reboot, deploymentId: 'dep-1' }) }),
    );
    expect(eventBus.emit).toHaveBeenCalledWith(
      'lifecycle.dispatched',
      expect.objectContaining({ jobType: JobType.Reboot, deploymentId: 'dep-1' }),
    );

    await service.requestPowerControl({
      deviceId: 'device-1',
      deploymentId: 'dep-1',
      userId: 'user-1',
      organizationId: 'org-1',
      source: RequestSource.API,
      operation: 'off',
    });
    expect(client.lifecycleJob.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ jobType: JobType.PowerOff, deploymentId: 'dep-1' }) }),
    );
    expect(eventBus.emit).toHaveBeenCalledWith(
      'lifecycle.dispatched',
      expect.objectContaining({ jobType: JobType.PowerOff, deploymentId: 'dep-1' }),
    );
  });

  it('arms the power watchdog when a power-family job dispatches', async () => {
    await service.requestReboot({
      deviceId: 'device-1',
      userId: 'user-1',
      organizationId: 'org-1',
      source: RequestSource.API,
    });
    expect(watchdogQueue.add).toHaveBeenCalledWith(
      POWER_WATCHDOG_JOB,
      { jobId: 'job-1' },
      expect.objectContaining({ jobId: 'job-1' }),
    );
  });

  it('does not arm the power watchdog when dispatch fails', async () => {
    rebootOperation.dispatch.mockRejectedValueOnce(new Error('bridge pickup timeout'));
    await expect(
      service.requestReboot({
        deviceId: 'device-1',
        userId: 'user-1',
        organizationId: 'org-1',
        source: RequestSource.API,
      }),
    ).rejects.toThrow('bridge pickup timeout');
    expect(watchdogQueue.add).not.toHaveBeenCalled();
  });

  it('resets the transitional powerStatus when a power-op enqueue fails', async () => {
    const error = new Error('bridge enqueue failed');
    rebootOperation.dispatch.mockRejectedValueOnce(error);
    await expect(
      service.requestReboot({
        deviceId: 'device-1',
        userId: 'user-1',
        organizationId: 'org-1',
        source: RequestSource.API,
      }),
    ).rejects.toBe(error);
    expect(client.server.updateMany).toHaveBeenCalledWith({
      where: {
        deviceId: 'device-1',
        powerStatus: { in: [...TRANSITIONAL_SERVER_POWER_STATUSES] },
        device: { lastJobId: 'job-1' },
      },
      data: { powerStatus: null },
    });
  });

  it('resets the transitional powerStatus when a power-on enqueue fails', async () => {
    const error = new Error('power-on enqueue failed');
    powerControlOperation.dispatch.mockRejectedValueOnce(error);
    await expect(
      service.requestPowerControl({
        deviceId: 'device-1',
        userId: 'user-1',
        organizationId: 'org-1',
        source: RequestSource.API,
        operation: 'on',
      }),
    ).rejects.toBe(error);
    expect(client.server.updateMany).toHaveBeenCalledWith({
      where: {
        deviceId: 'device-1',
        powerStatus: { in: [...TRANSITIONAL_SERVER_POWER_STATUSES] },
        device: { lastJobId: 'job-1' },
      },
      data: { powerStatus: null },
    });
  });

  it('resets the transitional powerStatus when a power-off enqueue fails', async () => {
    const error = new Error('power-off enqueue failed');
    powerControlOperation.dispatch.mockRejectedValueOnce(error);
    await expect(
      service.requestPowerControl({
        deviceId: 'device-1',
        userId: 'user-1',
        organizationId: 'org-1',
        source: RequestSource.API,
        operation: 'off',
      }),
    ).rejects.toBe(error);
    expect(client.server.updateMany).toHaveBeenCalledWith({
      where: {
        deviceId: 'device-1',
        powerStatus: { in: [...TRANSITIONAL_SERVER_POWER_STATUSES] },
        device: { lastJobId: 'job-1' },
      },
      data: { powerStatus: null },
    });
  });

  it('does not reset powerStatus when a power-op fails before dispatch', async () => {
    client.lifecycleJob.update.mockImplementationOnce(() => {
      throw new Error('db save failed');
    });
    await expect(
      service.requestReboot({
        deviceId: 'device-1',
        userId: 'user-1',
        organizationId: 'org-1',
        source: RequestSource.API,
      }),
    ).rejects.toThrow('db save failed');
    expect(rebootOperation.dispatch).not.toHaveBeenCalled();
    expect(client.server.updateMany).not.toHaveBeenCalled();
  });

  it('fails the job and rethrows when dispatch throws, without emitting', async () => {
    rebootOperation.dispatch.mockRejectedValueOnce(new Error('bridge pickup timeout'));
    await expect(
      service.requestReboot({
        deviceId: 'device-1',
        userId: 'user-1',
        organizationId: 'org-1',
        source: RequestSource.API,
      }),
    ).rejects.toThrow('bridge pickup timeout');
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('reprovision assembles context and dispatches (no gate; reuses the reservation)', async () => {
    const reprovisionInput = {
      deviceId: 'device-1',
      userId: 'user-1',
      organizationId: 'org-1',
      deploymentName: 'my-box',
      operatingSystemSlug: 'ubuntu-22',
      sshKeyIds: ['key-1'],
      diskLayouts: [],
      cloudInit: null,
      ipxeUrl: null,
      customizations: null,
      source: RequestSource.API,
    };
    await service.requestReprovision(reprovisionInput);

    expect(reprovisionOperation.assembleContext).toHaveBeenCalled();
    expect(reprovisionOperation.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1', baseLayerId: 'layer-1', pubkeys: ['k'], jobId: 'job-1' }),
    );
    expect(gateBus.runGate).not.toHaveBeenCalled();
    expect(eventBus.emit).toHaveBeenCalledWith(
      'lifecycle.dispatched',
      expect.objectContaining({ jobType: JobType.Reprovision, deploymentId: 'dep-1' }),
    );
    expect(client.lifecycleJob.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          deploymentId: 'dep-1',
          payload: expect.objectContaining({
            triggeredBy: 'user-1',
            source: RequestSource.API,
            request: expect.objectContaining({
              deviceId: 'device-1',
              operatingSystemSlug: 'ubuntu-22',
              deploymentName: 'my-box',
            }),
          }),
        }),
      }),
    );
  });

  it('reprovision records retriedBy as performedBy and keeps the retry audit fields in the payload', async () => {
    const reprovisionInput = {
      deviceId: 'device-1',
      userId: 'user-1',
      organizationId: 'org-1',
      deploymentName: 'my-box',
      operatingSystemSlug: 'ubuntu-22',
      sshKeyIds: ['key-1'],
      diskLayouts: [],
      cloudInit: null,
      ipxeUrl: null,
      customizations: null,
      source: RequestSource.UI,
    };
    await service.requestReprovision(reprovisionInput, {
      retriedFromJobId: 'old-job',
      retriedBy: 'operator-1',
      triggeredByEmail: 'op@hydrahost.test',
    });

    expect(client.lifecycleJob.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          performedBy: 'operator-1',
          payload: expect.objectContaining({
            triggeredBy: 'operator-1',
            triggeredByEmail: 'op@hydrahost.test',
            source: RequestSource.UI,
            retriedFromJobId: 'old-job',
            retriedBy: 'operator-1',
            request: expect.objectContaining({ userId: 'user-1' }),
          }),
        }),
      }),
    );
  });

  it('emits provision.failed when reprovision fails after the deployment row is updated', async () => {
    reprovisionOperation.dispatch.mockRejectedValueOnce(new Error('bridge enqueue failed'));

    await expect(
      service.requestReprovision({
        deviceId: 'device-1',
        userId: 'user-1',
        organizationId: 'org-1',
        deploymentName: 'my-box',
        operatingSystemSlug: 'ubuntu-22',
        sshKeyIds: ['key-1'],
        diskLayouts: [],
        cloudInit: null,
        ipxeUrl: null,
        customizations: null,
        source: RequestSource.API,
      }),
    ).rejects.toThrow('bridge enqueue failed');

    expect(eventBus.emit).toHaveBeenCalledWith(
      'provision.failed',
      expect.objectContaining({ jobId: 'job-1', deviceId: 'device-1', error: 'bridge enqueue failed' }),
    );
    expect(eventBus.emit).not.toHaveBeenCalledWith('lifecycle.dispatched', expect.anything());
  });

  describe('requestProvisionAsOperator', () => {
    const input = {
      deviceId: 'device-1',
      userId: 'user-1',
      organizationId: 'org-1',
      deploymentName: 'my-box',
      operatingSystemSlug: 'ubuntu-22' as const,
      sshKeyIds: ['key-1'],
      diskLayouts: [],
      cloudInit: null,
      ipxeUrl: null,
      customizations: null,
      source: RequestSource.UI,
    };

    it('uses assembleContextForReplay (not assembleContext) and reaches DISPATCHED', async () => {
      const job = await service.requestProvisionAsOperator(input);

      expect(provisionOperation.assembleContextForReplay).toHaveBeenCalledWith(input);
      expect(provisionOperation.assembleContext).not.toHaveBeenCalled();
      expect(job.data.phase).toBe(LifecycleJobPhase.DISPATCHED);
      expect(eventBus.emit).toHaveBeenCalledWith(
        'lifecycle.dispatched',
        expect.objectContaining({ jobType: JobType.Provision }),
      );
    });

    it('records triggeredBy as the retrying operator and keeps request.userId as the original owner', async () => {
      await service.requestProvisionAsOperator(input, {
        retriedFromJobId: 'old-job',
        retriedBy: 'operator-1',
        triggeredByEmail: 'op@hydrahost.test',
      });

      expect(client.lifecycleJob.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            performedBy: 'operator-1',
            payload: expect.objectContaining({
              triggeredBy: 'operator-1',
              triggeredByEmail: 'op@hydrahost.test',
              source: RequestSource.UI,
              retriedFromJobId: 'old-job',
              retriedBy: 'operator-1',
              request: expect.objectContaining({ userId: 'user-1' }),
            }),
          }),
        }),
      );
    });

    it('aborts when assembleContextForReplay rejects (device/OS/SSH validation still runs)', async () => {
      provisionOperation.assembleContextForReplay.mockRejectedValueOnce(new NotFoundException('device gone'));
      await expect(service.requestProvisionAsOperator(input)).rejects.toThrow('device gone');
      expect(gateBus.runGate).not.toHaveBeenCalled();
      expect(provisionOperation.publish).not.toHaveBeenCalled();
    });

    it('aborts when the provision gate rejects', async () => {
      gateBus.runGate.mockRejectedValueOnce(new LifecycleGateRejection('payment declined'));
      await expect(service.requestProvisionAsOperator(input)).rejects.toBeInstanceOf(LifecycleGateRejection);
      expect(provisionOperation.publish).not.toHaveBeenCalled();
    });
  });

  describe('requestProvision', () => {
    const input = {
      deviceId: 'device-1',
      userId: 'user-1',
      organizationId: 'org-1',
      deploymentName: 'my-box',
      operatingSystemSlug: 'ubuntu-22' as const,
      sshKeyIds: ['key-1'],
      diskLayouts: [],
      cloudInit: null,
      ipxeUrl: null,
      customizations: null,
      source: RequestSource.API,
    };

    it('prepares (creates the reservation + deployment), runs the authorize gate, then publishes and emits', async () => {
      const job = await service.requestProvision(input);

      expect(provisionOperation.assembleContext).toHaveBeenCalled();
      expect(provisionOperation.createReservation).toHaveBeenCalledWith(input);
      expect(provisionOperation.createDeployment).toHaveBeenCalledWith(input, 'layer-1', 'res-1');
      expect(gateBus.runGate).toHaveBeenCalledWith(
        'provision.authorize',
        {
          jobId: 'job-1',
          deviceId: 'device-1',
          deploymentId: 'dep-1',
          organizationId: 'org-1',
          customerUserId: 'user-1',
          internalProvision: false,
        },
        { override: false },
      );
      expect(provisionOperation.publish).toHaveBeenCalledWith(input, 'dep-1', ['k'], 'job-1');
      expect(job.data.deploymentId).toBe('dep-1');
      expect(eventBus.emit).toHaveBeenCalledWith(
        'lifecycle.dispatched',
        expect.objectContaining({ jobType: JobType.Provision, deploymentId: 'dep-1' }),
      );
    });

    it('threads internalProvision into the authorize gate payload (so plugins can skip customer gating for DCIM provisions)', async () => {
      await service.requestProvision({ ...input, internalProvision: true });

      expect(gateBus.runGate).toHaveBeenCalledWith(
        'provision.authorize',
        expect.objectContaining({ internalProvision: true }),
        { override: false },
      );
    });

    it('aborts before the gate when prepare (deployment creation) fails', async () => {
      provisionOperation.createDeployment.mockRejectedValueOnce(new Error('device taken'));
      await expect(service.requestProvision(input)).rejects.toThrow('device taken');
      expect(gateBus.runGate).not.toHaveBeenCalled();
      expect(provisionOperation.publish).not.toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    it('aborts and signals the orphaned deployment when the attach save fails after creation', async () => {
      const client = makeMockClient();
      client.lifecycleJob.update.mockImplementationOnce(() => {
        throw new Error('db blip');
      });
      ActiveRecordRegistry.configureForTest(client, null);

      await expect(service.requestProvision(input)).rejects.toThrow('db blip');

      expect(gateBus.runGate).not.toHaveBeenCalled();
      expect(provisionOperation.publish).not.toHaveBeenCalled();
      expect(eventBus.emit).toHaveBeenCalledWith(
        'provision.failed',
        expect.objectContaining({ jobId: 'job-1', deploymentId: 'dep-1', error: 'db blip' }),
      );
      expect(eventBus.emit).not.toHaveBeenCalledWith('lifecycle.dispatched', expect.anything());
    });

    it('emits provision.failed when the bridge publish fails after the deployment is created', async () => {
      provisionOperation.publish.mockRejectedValueOnce(new Error('bridge enqueue failed'));

      await expect(service.requestProvision(input)).rejects.toThrow('bridge enqueue failed');

      expect(clusterNetwork.detach).toHaveBeenCalledWith('dep-1', 'device-1');
      expect(eventBus.emit).toHaveBeenCalledWith(
        'provision.failed',
        expect.objectContaining({ jobId: 'job-1', deploymentId: 'dep-1', error: 'bridge enqueue failed' }),
      );
      expect(eventBus.emit).not.toHaveBeenCalledWith('lifecycle.dispatched', expect.anything());
    });

    it('fails before dispatch when prepare does not return a deployment id', async () => {
      provisionOperation.createDeployment.mockResolvedValueOnce(undefined);

      await expect(service.requestProvision(input)).rejects.toThrow('Missing deployment id for provision dispatch');

      expect(clusterNetwork.attach).not.toHaveBeenCalled();
      expect(provisionOperation.publish).not.toHaveBeenCalled();
    });

    it('emits provision.failed when the authorize gate vetoes after the deployment is created', async () => {
      gateBus.runGate.mockRejectedValueOnce(new LifecycleGateRejection('payment declined'));

      await expect(service.requestProvision(input)).rejects.toBeInstanceOf(LifecycleGateRejection);

      expect(provisionOperation.publish).not.toHaveBeenCalled();
      expect(eventBus.emit).toHaveBeenCalledWith(
        'provision.failed',
        expect.objectContaining({ jobId: 'job-1', deploymentId: 'dep-1', error: 'payment declined' }),
      );
    });
  });

  describe('gate deferral (defer / resume / abort)', () => {
    const provisionInput = {
      deviceId: 'device-1',
      userId: 'user-1',
      organizationId: 'org-1',
      deploymentName: 'my-box',
      operatingSystemSlug: 'ubuntu-22' as const,
      sshKeyIds: ['key-1'],
      diskLayouts: [],
      cloudInit: null,
      ipxeUrl: null,
      customizations: null,
      source: RequestSource.API,
    };

    const deferredProvisionJob = (phase: LifecycleJobPhase = LifecycleJobPhase.DEFERRED) =>
      LifecycleJobRecord.build({
        id: 'job-1',
        jobType: JobType.Provision,
        phase,
        deviceId: 'device-1',
        deploymentId: 'dep-1',
        organizationId: 'org-1',
        performedBy: 'user-1',
        source: RequestSource.API,
        payload: { operatingSystemSlug: 'ubuntu-22', request: provisionInput },
      });

    it('parks a provision in DEFERRED when the gate throws LifecycleGateDeferral — no dispatch', async () => {
      gateBus.runGate.mockRejectedValueOnce(new LifecycleGateDeferral('pending operator approval'));

      const job = await service.requestProvision(provisionInput);

      expect(job.data.phase).toBe(LifecycleJobPhase.DEFERRED);
      expect(provisionOperation.publish).not.toHaveBeenCalled();
      expect(eventBus.emit).toHaveBeenCalledWith(
        'lifecycle.deferred',
        expect.objectContaining({
          jobId: 'job-1',
          jobType: JobType.Provision,
          deploymentId: 'dep-1',
          reason: 'pending operator approval',
        }),
      );
      expect(eventBus.emit).not.toHaveBeenCalledWith('lifecycle.dispatched', expect.anything());
      expect(eventBus.emit).not.toHaveBeenCalledWith('provision.failed', expect.anything());
    });

    it('resumeDeferred replays dispatch (gate NOT re-run) and emits lifecycle.dispatched', async () => {
      const job = deferredProvisionJob();
      vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);

      await service.resumeDeferred('job-1');

      expect(gateBus.runGate).not.toHaveBeenCalled();
      expect(provisionOperation.assembleContextForResume).toHaveBeenCalled();
      expect(provisionOperation.assembleContextForReplay).not.toHaveBeenCalled();
      expect(provisionOperation.publish).toHaveBeenCalledWith(
        expect.objectContaining({ deviceId: 'device-1', operatingSystemSlug: 'ubuntu-22' }),
        'dep-1',
        ['k'],
        'job-1',
      );
      expect(job.data.phase).toBe(LifecycleJobPhase.DISPATCHED);
      expect(eventBus.emit).toHaveBeenCalledWith(
        'lifecycle.dispatched',
        expect.objectContaining({ jobType: JobType.Provision, deploymentId: 'dep-1' }),
      );
    });

    it('resumeDeferred is a no-op for a job no longer in DEFERRED', async () => {
      vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(
        deferredProvisionJob(LifecycleJobPhase.DISPATCHED),
      );
      await service.resumeDeferred('job-1');
      expect(provisionOperation.publish).not.toHaveBeenCalled();
    });

    it('abortDeferred terminalizes, signals the orphaned deployment, and ends the reservation', async () => {
      const job = deferredProvisionJob();
      vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);
      vi.spyOn(DeploymentRecord, 'findOneUnscoped').mockResolvedValue({
        data: { reservationId: 'res-1' },
      } as unknown as Awaited<ReturnType<typeof DeploymentRecord.findOneUnscoped>>);

      await service.abortDeferred('job-1', 'no payment received');

      expect(job.data.phase).toBe(LifecycleJobPhase.ABORTED);
      expect(provisionOperation.publish).not.toHaveBeenCalled();
      expect(eventBus.emit).toHaveBeenCalledWith(
        'provision.failed',
        expect.objectContaining({ jobId: 'job-1', deploymentId: 'dep-1', error: 'no payment received' }),
      );
      expect(reservationsService.endReservation).toHaveBeenCalledWith('res-1');
    });

    it('resumeDeferred returns true when it advances the job and false on a no-op', async () => {
      const spy = vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(deferredProvisionJob());
      await expect(service.resumeDeferred('job-1')).resolves.toBe(true);

      spy.mockResolvedValue(deferredProvisionJob(LifecycleJobPhase.DISPATCHED));
      await expect(service.resumeDeferred('job-1')).resolves.toBe(false);
    });

    it('abortDeferred returns true when it aborts and false on a no-op', async () => {
      vi.spyOn(DeploymentRecord, 'findOneUnscoped').mockResolvedValue({
        data: { reservationId: 'res-1' },
      } as unknown as Awaited<ReturnType<typeof DeploymentRecord.findOneUnscoped>>);
      const spy = vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(deferredProvisionJob());
      await expect(service.abortDeferred('job-1', 'declined')).resolves.toBe(true);

      spy.mockResolvedValue(deferredProvisionJob(LifecycleJobPhase.ABORTED));
      await expect(service.abortDeferred('job-1', 'declined')).resolves.toBe(false);
    });

    it('resumeDeferred completes the interruptible claim and emits provision.started for a linked provision', async () => {
      const job = LifecycleJobRecord.build({
        id: 'job-1',
        jobType: JobType.Provision,
        phase: LifecycleJobPhase.DEFERRED,
        deviceId: 'device-1',
        deploymentId: 'dep-1',
        organizationId: 'org-1',
        performedBy: 'user-1',
        source: RequestSource.API,
        payload: { interruptible: true, interruptibleClaimId: 'claim-1', request: provisionInput },
      });
      vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);

      await expect(service.resumeDeferred('job-1')).resolves.toBe(true);

      expect(provisionOperation.publish).toHaveBeenCalled();
      expect(client.interruptibleClaim.update).toHaveBeenCalledWith({
        where: { id: 'claim-1' },
        data: { status: 'Complete' },
      });
      expect(eventBus.emit).toHaveBeenCalledWith('provision.started', expect.objectContaining({ jobId: 'job-1' }));
    });
  });

  describe('requestDeprovision', () => {
    const input = { deviceId: 'device-1', userId: 'user-1', organizationId: 'org-1', source: RequestSource.API };

    it('assembles context, runs the authorize gate, dispatches, and emits with the deployment id', async () => {
      const job = await service.requestDeprovision(input);

      expect(deprovisionOperation.assembleContext).toHaveBeenCalledWith('device-1', 'org-1');
      expect(gateBus.runGate).toHaveBeenCalledWith(
        'deprovision.authorize',
        {
          jobId: 'job-1',
          deviceId: 'device-1',
          deploymentId: 'dep-1',
          organizationId: 'org-1',
        },
        { override: false },
      );
      expect(deprovisionOperation.dispatch).toHaveBeenCalledWith({
        deviceId: 'device-1',
        organizationId: 'org-1',
        deploymentId: 'dep-1',
        jobId: 'job-1',
      });
      expect(job.data.phase).toBe(LifecycleJobPhase.DISPATCHED);
      expect(eventBus.emit).toHaveBeenCalledWith(
        'lifecycle.dispatched',
        expect.objectContaining({ jobType: JobType.Deprovision, deploymentId: 'dep-1' }),
      );
    });

    it('aborts before dispatch when the authorize gate vetoes', async () => {
      gateBus.runGate.mockRejectedValueOnce(new LifecycleGateRejection('payment failed'));
      await expect(service.requestDeprovision(input)).rejects.toBeInstanceOf(LifecycleGateRejection);
      expect(deprovisionOperation.dispatch).not.toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    it('converts a gate deferral into a rejection — a deprovision cannot be parked/resumed', async () => {
      gateBus.runGate.mockRejectedValueOnce(new LifecycleGateDeferral('pending operator approval'));
      await expect(service.requestDeprovision(input)).rejects.toBeInstanceOf(LifecycleGateRejection);
      expect(deprovisionOperation.dispatch).not.toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalledWith('lifecycle.deferred', expect.anything());
    });

    it('threads gateOverride:true through to runGate so an operator can force past plugin vetoes', async () => {
      const job = await service.requestDeprovision({ ...input, gateOverride: true });

      expect(gateBus.runGate).toHaveBeenCalledWith(
        'deprovision.authorize',
        {
          jobId: 'job-1',
          deviceId: 'device-1',
          deploymentId: 'dep-1',
          organizationId: 'org-1',
        },
        { override: true, overrideBy: 'user-1' },
      );
      expect(deprovisionOperation.dispatch).toHaveBeenCalled();
      expect(job.data.phase).toBe(LifecycleJobPhase.DISPATCHED);
    });
  });

  describe('requestDeprovisionWithoutDeployment', () => {
    const input = { deviceId: 'device-1', userId: 'user-1', source: RequestSource.API };

    it('rejects when the device has an active deployment, without dispatching', async () => {
      vi.spyOn(DeploymentRecord, 'findAggregateUnscoped').mockResolvedValue({
        id: 'dep-1',
      } as unknown as Awaited<ReturnType<typeof DeploymentRecord.findAggregateUnscoped>>);

      await expect(service.requestDeprovisionWithoutDeployment(input)).rejects.toBeInstanceOf(BadRequestException);
      expect(deprovisionOperation.dispatchWithoutDeployment).not.toHaveBeenCalled();
      expect(gateBus.runGate).not.toHaveBeenCalled();
    });

    it('dispatches without a gate or deployment when the device is free', async () => {
      vi.spyOn(DeploymentRecord, 'findAggregateUnscoped').mockResolvedValue(null);

      const job = await service.requestDeprovisionWithoutDeployment(input);

      expect(gateBus.runGate).not.toHaveBeenCalled();
      expect(deprovisionOperation.dispatchWithoutDeployment).toHaveBeenCalledWith({
        deviceId: 'device-1',
        jobId: 'job-1',
      });
      expect(job.data.phase).toBe(LifecycleJobPhase.DISPATCHED);
      expect(job.data.deploymentId).toBeNull();
      expect(job.data.organizationId).toBeNull();
      expect(eventBus.emit).toHaveBeenCalledWith(
        'lifecycle.dispatched',
        expect.objectContaining({
          jobType: JobType.Deprovision,
          deploymentId: null,
          organizationId: null,
        }),
      );
    });
  });

  describe('requestInterruptibleDeprovision', () => {
    const input = {
      deviceId: 'device-1',
      userId: 'user-1',
      organizationId: 'org-1',
      source: RequestSource.API,
      interruptionWarningTime: 300_000,
    };

    it('marks the interruption, parks in SCHEDULED, emits scheduled, and arms the grace timer', async () => {
      const deployment = {
        setScheduledInterruptionTime: vi.fn().mockReturnThis(),
        save: vi.fn().mockResolvedValue(undefined),
      };
      vi.spyOn(DeploymentRecord, 'findOneUnscoped').mockResolvedValue(
        deployment as unknown as Awaited<ReturnType<typeof DeploymentRecord.findOneUnscoped>>,
      );

      const job = await service.requestInterruptibleDeprovision(input);

      expect(deployment.setScheduledInterruptionTime).toHaveBeenCalledWith(300_000);
      expect(job.data.phase).toBe(LifecycleJobPhase.SCHEDULED);
      expect(eventBus.emit).toHaveBeenCalledWith(
        'deployment.interruption.scheduled',
        expect.objectContaining({ deploymentId: 'dep-1', organizationId: 'org-1' }),
      );
      expect(scheduledQueue.add).toHaveBeenCalledWith(
        'resume',
        { jobId: 'job-1' },
        expect.objectContaining({ delay: 300_000, jobId: 'job-1' }),
      );
      expect(deprovisionOperation.dispatch).not.toHaveBeenCalled();
    });
  });

  describe('resumeScheduled', () => {
    const scheduledJob = (phase: LifecycleJobPhase) =>
      LifecycleJobRecord.build({
        id: 'job-1',
        jobType: JobType.Deprovision,
        phase,
        deviceId: 'device-1',
        deploymentId: 'dep-1',
        organizationId: 'org-1',
        performedBy: 'user-1',
        source: RequestSource.API,
        payload: {},
      });

    it('authorizes and dispatches a SCHEDULED job, emitting lifecycle.dispatched', async () => {
      const job = scheduledJob(LifecycleJobPhase.SCHEDULED);
      vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);

      await service.resumeScheduled('job-1');

      expect(gateBus.runGate).toHaveBeenCalledWith(
        'deprovision.authorize',
        {
          jobId: 'job-1',
          deviceId: 'device-1',
          deploymentId: 'dep-1',
          organizationId: 'org-1',
        },
        { override: false },
      );
      expect(deprovisionOperation.dispatch).toHaveBeenCalledWith({
        deviceId: 'device-1',
        organizationId: 'org-1',
        deploymentId: 'dep-1',
        jobId: 'job-1',
      });
      expect(job.data.phase).toBe(LifecycleJobPhase.DISPATCHED);
      expect(eventBus.emit).toHaveBeenCalledWith(
        'lifecycle.dispatched',
        expect.objectContaining({ jobType: JobType.Deprovision, deploymentId: 'dep-1' }),
      );
    });

    it('skips a job that is not SCHEDULED', async () => {
      vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(scheduledJob(LifecycleJobPhase.COMPLETED));
      await service.resumeScheduled('job-1');
      expect(deprovisionOperation.dispatch).not.toHaveBeenCalled();
    });

    it('aborts and clears the interruption when the gate vetoes (permanent, no retry)', async () => {
      const job = scheduledJob(LifecycleJobPhase.SCHEDULED);
      vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);
      gateBus.runGate.mockRejectedValueOnce(new LifecycleGateRejection('not allowed'));
      const deployment = {
        clearScheduledInterruptionTime: vi.fn().mockReturnThis(),
        save: vi.fn().mockResolvedValue(undefined),
      };
      vi.spyOn(DeploymentRecord, 'findOneUnscoped').mockResolvedValue(
        deployment as unknown as Awaited<ReturnType<typeof DeploymentRecord.findOneUnscoped>>,
      );

      await expect(service.resumeScheduled('job-1')).resolves.toBeUndefined();

      expect(deprovisionOperation.dispatch).not.toHaveBeenCalled();
      expect(deployment.clearScheduledInterruptionTime).toHaveBeenCalled();
      expect(deployment.save).toHaveBeenCalled();
      expect(job.data.phase).toBe(LifecycleJobPhase.ABORTED);
    });

    it('aborts and clears the interruption when a fail-closed gate is unavailable (permanent, no retry)', async () => {
      const job = scheduledJob(LifecycleJobPhase.SCHEDULED);
      vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);
      gateBus.runGate.mockRejectedValueOnce(new GateUnavailableError('deprovision.authorize', 'billing'));
      const deployment = {
        clearScheduledInterruptionTime: vi.fn().mockReturnThis(),
        save: vi.fn().mockResolvedValue(undefined),
      };
      vi.spyOn(DeploymentRecord, 'findOneUnscoped').mockResolvedValue(
        deployment as unknown as Awaited<ReturnType<typeof DeploymentRecord.findOneUnscoped>>,
      );

      await expect(service.resumeScheduled('job-1')).resolves.toBeUndefined();

      expect(deprovisionOperation.dispatch).not.toHaveBeenCalled();
      expect(deployment.clearScheduledInterruptionTime).toHaveBeenCalled();
      expect(deployment.save).toHaveBeenCalled();
      expect(job.data.phase).toBe(LifecycleJobPhase.ABORTED);
    });

    it('aborts and clears the interruption when the deployment is locked (permanent, no retry)', async () => {
      const job = scheduledJob(LifecycleJobPhase.SCHEDULED);
      vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);
      deprovisionOperation.dispatch.mockRejectedValueOnce(
        new BadRequestException('Cannot deprovision a locked deployment'),
      );
      const deployment = {
        clearScheduledInterruptionTime: vi.fn().mockReturnThis(),
        save: vi.fn().mockResolvedValue(undefined),
      };
      vi.spyOn(DeploymentRecord, 'findOneUnscoped').mockResolvedValue(
        deployment as unknown as Awaited<ReturnType<typeof DeploymentRecord.findOneUnscoped>>,
      );

      await expect(service.resumeScheduled('job-1')).resolves.toBeUndefined();

      expect(deployment.clearScheduledInterruptionTime).toHaveBeenCalled();
      expect(job.data.phase).toBe(LifecycleJobPhase.FAILED);
    });

    it('reschedules (keeps the interruption, rethrows) when dispatch fails transiently', async () => {
      const job = scheduledJob(LifecycleJobPhase.SCHEDULED);
      vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);
      deprovisionOperation.dispatch.mockRejectedValueOnce(new Error('bridge unreachable'));
      const clearSpy = vi.spyOn(DeploymentRecord, 'findOneUnscoped');

      await expect(service.resumeScheduled('job-1')).rejects.toThrow('bridge unreachable');

      expect(job.data.phase).toBe(LifecycleJobPhase.SCHEDULED);
      expect(clearSpy).not.toHaveBeenCalled();
    });

    it('reschedules when the gate fails transiently (non-veto error)', async () => {
      const job = scheduledJob(LifecycleJobPhase.SCHEDULED);
      vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);
      gateBus.runGate.mockRejectedValueOnce(new Error('billing service unavailable'));
      const clearSpy = vi.spyOn(DeploymentRecord, 'findOneUnscoped');

      await expect(service.resumeScheduled('job-1')).rejects.toThrow('billing service unavailable');

      expect(deprovisionOperation.dispatch).not.toHaveBeenCalled();
      expect(job.data.phase).toBe(LifecycleJobPhase.SCHEDULED);
      expect(clearSpy).not.toHaveBeenCalled();
    });

    it('cedes without running the gate when the job leaves SCHEDULED concurrently', async () => {
      vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(scheduledJob(LifecycleJobPhase.SCHEDULED));
      vi.spyOn(LifecycleJobRecord, 'claimTransition').mockResolvedValue(false);

      await expect(service.resumeScheduled('job-1')).resolves.toBeUndefined();

      expect(gateBus.runGate).not.toHaveBeenCalled();
      expect(deprovisionOperation.dispatch).not.toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    it('skips dispatch when inbound results resolve the job mid-resume', async () => {
      vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(scheduledJob(LifecycleJobPhase.SCHEDULED));
      vi.spyOn(LifecycleJobRecord, 'claimTransition').mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await expect(service.resumeScheduled('job-1')).resolves.toBeUndefined();

      expect(gateBus.runGate).toHaveBeenCalled();
      expect(deprovisionOperation.dispatch).not.toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalledWith('lifecycle.dispatched', expect.anything());
    });

    it('drops a stale failure verdict when inbound resolved the job concurrently', async () => {
      vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(scheduledJob(LifecycleJobPhase.SCHEDULED));
      vi.spyOn(LifecycleJobRecord, 'claimTransition').mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      gateBus.runGate.mockRejectedValueOnce(new LifecycleGateRejection('not allowed'));
      const clearSpy = vi.spyOn(DeploymentRecord, 'findOneUnscoped');

      await expect(service.resumeScheduled('job-1')).resolves.toBeUndefined();

      expect(clearSpy).not.toHaveBeenCalled();
      expect(deprovisionOperation.dispatch).not.toHaveBeenCalled();
    });
  });

  describe('executeInterruptibleProvision', () => {
    const request = {
      deviceId: 'incoming-device',
      userId: 'incoming-user',
      organizationId: 'incoming-org',
      deploymentName: 'new-box',
      operatingSystemSlug: 'ubuntu-22' as const,
      sshKeyIds: ['key-1'],
      diskLayouts: [],
      cloudInit: null,
      ipxeUrl: null,
      customizations: null,
      source: RequestSource.API,
    };
    const input = { request, deviceId: 'host-device' };

    function mockOutgoing(
      over: {
        interruptibleNoticePeriod?: number | null;
        customerId?: string;
        isInterruptible?: boolean;
        id?: string;
      } = {},
    ) {
      const noticePeriod = 'interruptibleNoticePeriod' in over ? over.interruptibleNoticePeriod : 600_000;
      vi.spyOn(DeploymentRecord, 'findAggregateUnscoped').mockResolvedValue({
        id: over.id ?? 'outgoing-dep',
        customerId: over.customerId ?? 'outgoing-org',
        interruptibleNoticePeriod: noticePeriod,
        isInterruptible: over.isInterruptible ?? true,
      } as unknown as Awaited<ReturnType<typeof DeploymentRecord.findAggregateUnscoped>>);
      vi.spyOn(DeploymentRecord, 'findOneUnscoped').mockResolvedValue({
        setScheduledInterruptionTime: vi.fn().mockReturnThis(),
        save: vi.fn().mockResolvedValue(undefined),
      } as unknown as Awaited<ReturnType<typeof DeploymentRecord.findOneUnscoped>>);
    }

    it('creates the claim, parks the incoming provision in REQUESTED, and schedules the linked eviction', async () => {
      mockOutgoing();

      const result = await service.executeInterruptibleProvision(input);

      expect(client.interruptibleClaim.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            server: { connect: { deviceId: 'host-device' } },
            organization: { connect: { id: 'incoming-org' } },
            user: { connect: { id: 'incoming-user' } },
          }),
        }),
      );
      expect(provisionOperation.createDeployment).not.toHaveBeenCalled();
      expect(gateBus.runGate).not.toHaveBeenCalled();
      expect(provisionOperation.publish).not.toHaveBeenCalled();

      expect(scheduledQueue.add).toHaveBeenCalledWith(
        'resume',
        { jobId: result.deprovisionJobId },
        expect.objectContaining({ delay: 600_000 }),
      );
      expect(eventBus.emit).toHaveBeenCalledWith(
        'deployment.interruption.queued',
        expect.objectContaining({ incomingOrgId: 'incoming-org', deviceId: 'host-device', delayMs: 600_000 }),
      );
      expect(result.claimId).toBe('claim-1');
      expect(result.incomingJobId).not.toBe(result.deprovisionJobId);
    });

    it('reads the notice period from the outgoing deployment, not a request param', async () => {
      mockOutgoing({ interruptibleNoticePeriod: 120_000 });
      const result = await service.executeInterruptibleProvision(input);
      expect(scheduledQueue.add).toHaveBeenCalledWith(
        'resume',
        { jobId: result.deprovisionJobId },
        expect.objectContaining({ delay: 120_000 }),
      );
    });

    it('sets claim.interruptAt from the resolved notice period, matching the grace-timer deadline', async () => {
      mockOutgoing({ interruptibleNoticePeriod: 120_000 });
      const before = Date.now();
      await service.executeInterruptibleProvision(input);
      const after = Date.now();

      const { interruptAt } = client.interruptibleClaim.create.mock.calls[0][0].data;
      expect(interruptAt.getTime()).toBeGreaterThanOrEqual(before + 120_000);
      expect(interruptAt.getTime()).toBeLessThanOrEqual(after + 120_000);
      expect(interruptAt.getTime()).toBeLessThan(before + 300_000);
    });

    it('falls back to the default notice period when the outgoing deployment has none', async () => {
      mockOutgoing({ interruptibleNoticePeriod: null });
      const result = await service.executeInterruptibleProvision(input);
      expect(scheduledQueue.add).toHaveBeenCalledWith(
        'resume',
        { jobId: result.deprovisionJobId },
        expect.objectContaining({ delay: 300_000 }),
      );
    });

    it('throws 409 when a pending claim already exists for the host (P2002)', async () => {
      mockOutgoing();
      client.interruptibleClaim.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
      );
      await expect(service.executeInterruptibleProvision(input)).rejects.toBeInstanceOf(ConflictException);
      expect(scheduledQueue.add).not.toHaveBeenCalled();
    });

    it('throws when there is no active deployment to interrupt', async () => {
      vi.spyOn(DeploymentRecord, 'findAggregateUnscoped').mockResolvedValue(null);
      await expect(service.executeInterruptibleProvision(input)).rejects.toThrow(/No active deployment/);
      expect(client.interruptibleClaim.create).not.toHaveBeenCalled();
    });

    it('refuses to evict a non-interruptible active deployment', async () => {
      mockOutgoing({ isInterruptible: false });
      await expect(service.executeInterruptibleProvision(input)).rejects.toBeInstanceOf(ConflictException);
      expect(client.interruptibleClaim.create).not.toHaveBeenCalled();
      expect(scheduledQueue.add).not.toHaveBeenCalled();
    });

    it('refuses when the captured deployment is no longer the active one on the device', async () => {
      mockOutgoing({ id: 'new-tenant-dep' });
      await expect(
        service.executeInterruptibleProvision({ ...input, expectedDeploymentId: 'outgoing-dep' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(client.interruptibleClaim.create).not.toHaveBeenCalled();
      expect(scheduledQueue.add).not.toHaveBeenCalled();
    });
  });

  describe('requestInterruptibleProvision', () => {
    const request = {
      deviceId: 'incoming-device',
      userId: 'incoming-user',
      organizationId: 'incoming-org',
      deploymentName: 'new-box',
      operatingSystemSlug: 'ubuntu-22' as const,
      sshKeyIds: ['key-1'],
      diskLayouts: [],
      cloudInit: null,
      ipxeUrl: null,
      customizations: null,
      source: RequestSource.API,
    };
    const input = { request, deviceId: 'host-device' };

    function mockOutgoing() {
      vi.spyOn(DeploymentRecord, 'findAggregateUnscoped').mockResolvedValue({
        id: 'outgoing-dep',
        customerId: 'outgoing-org',
        interruptibleNoticePeriod: 600_000,
        isInterruptible: true,
      } as unknown as Awaited<ReturnType<typeof DeploymentRecord.findAggregateUnscoped>>);
      vi.spyOn(DeploymentRecord, 'findOneUnscoped').mockResolvedValue({
        setScheduledInterruptionTime: vi.fn().mockReturnThis(),
        save: vi.fn().mockResolvedValue(undefined),
      } as unknown as Awaited<ReturnType<typeof DeploymentRecord.findOneUnscoped>>);
    }

    afterEach(() => {
      delete process.env.INTERRUPTIBLE_EVICTION_REQUIRES_APPROVAL;
    });

    it('creates a PENDING DEPROVISION request (no claim/jobs) when approval is required', async () => {
      mockOutgoing();

      const result = await service.requestInterruptibleProvision(input);

      expect(result).toEqual({ status: 'pending_approval', requestId: 'request-1' });
      expect(client.adminLifecycleRequest.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: 'DEPROVISION',
            status: 'PENDING',
            deploymentId: 'outgoing-dep',
            deviceId: 'host-device',
            requestedById: 'incoming-user',
            requestBody: expect.objectContaining({ deploymentName: 'new-box', deviceId: 'incoming-device' }),
          }),
        }),
      );
      expect(client.interruptibleClaim.create).not.toHaveBeenCalled();
      expect(scheduledQueue.add).not.toHaveBeenCalled();
    });

    it('executes the eviction directly when approval is disabled', async () => {
      process.env.INTERRUPTIBLE_EVICTION_REQUIRES_APPROVAL = 'false';
      mockOutgoing();

      const result = await service.requestInterruptibleProvision(input);

      expect(result.status).toBe('executing');
      expect(client.interruptibleClaim.create).toHaveBeenCalled();
      expect(scheduledQueue.add).toHaveBeenCalled();
      expect(client.adminLifecycleRequest.create).not.toHaveBeenCalled();
    });

    it('throws NotFound when there is no active deployment to interrupt', async () => {
      vi.spyOn(DeploymentRecord, 'findAggregateUnscoped').mockResolvedValue(null);

      await expect(service.requestInterruptibleProvision(input)).rejects.toThrow(/No active deployment/);
      expect(client.adminLifecycleRequest.create).not.toHaveBeenCalled();
      expect(client.interruptibleClaim.create).not.toHaveBeenCalled();
    });
  });

  describe('enqueueLinkedProvision', () => {
    it('enqueues a retryable start-linked-provision job keyed to the incoming job id', async () => {
      await service.enqueueLinkedProvision('incoming-1');
      const opts = scheduledQueue.add.mock.calls[0]?.[2];
      expect(opts.jobId).toBe(`${START_LINKED_PROVISION_JOB}-incoming-1`);
      expect(opts.jobId).not.toContain(':');
      expect(scheduledQueue.add).toHaveBeenCalledWith(
        START_LINKED_PROVISION_JOB,
        { jobId: 'incoming-1' },
        expect.objectContaining({
          jobId: `${START_LINKED_PROVISION_JOB}-incoming-1`,
          attempts: expect.any(Number),
          backoff: expect.objectContaining({ type: 'exponential' }),
        }),
      );
    });
  });

  describe('startLinkedProvision', () => {
    const request = {
      deviceId: 'incoming-device',
      userId: 'incoming-user',
      organizationId: 'incoming-org',
      deploymentName: 'new-box',
      operatingSystemSlug: 'ubuntu-22' as const,
      sshKeyIds: ['key-1'],
      diskLayouts: [],
      cloudInit: null,
      ipxeUrl: null,
      customizations: null,
      source: RequestSource.API,
    };

    function parkedJob(phase: LifecycleJobPhase) {
      return LifecycleJobRecord.build({
        id: 'incoming-1',
        jobType: JobType.Provision,
        phase,
        deviceId: request.deviceId,
        deploymentId: null,
        organizationId: request.organizationId,
        performedBy: request.userId,
        source: request.source,
        payload: { interruptible: true, interruptibleClaimId: 'claim-1', request },
      });
    }

    it('skips a job that is not REQUESTED (idempotent re-entry)', async () => {
      vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(parkedJob(LifecycleJobPhase.DISPATCHED));
      await service.startLinkedProvision('incoming-1');
      expect(provisionOperation.createDeployment).not.toHaveBeenCalled();
    });

    it('creates the deployment, runs the gate, dispatches, completes the claim, and emits', async () => {
      vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(parkedJob(LifecycleJobPhase.REQUESTED));

      await service.startLinkedProvision('incoming-1');

      expect(provisionOperation.assembleContextForReplay).toHaveBeenCalled();
      expect(provisionOperation.assembleContext).not.toHaveBeenCalled();
      expect(provisionOperation.createReservation).toHaveBeenCalledWith(expect.objectContaining(request));
      expect(provisionOperation.createDeployment).toHaveBeenCalledWith(
        expect.objectContaining(request),
        'layer-1',
        'res-1',
      );
      expect(gateBus.runGate).toHaveBeenCalledWith(
        'provision.authorize',
        expect.objectContaining({ jobId: 'incoming-1', deploymentId: 'dep-1', organizationId: 'incoming-org' }),
      );
      expect(provisionOperation.publish).toHaveBeenCalledWith(
        expect.objectContaining(request),
        'dep-1',
        ['k'],
        'incoming-1',
      );
      expect(client.interruptibleClaim.update).toHaveBeenCalledWith({
        where: { id: 'claim-1' },
        data: { status: 'Complete' },
      });
      expect(eventBus.emit).toHaveBeenCalledWith(
        'provision.started',
        expect.objectContaining({ deploymentId: 'dep-1' }),
      );
      expect(eventBus.emit).toHaveBeenCalledWith(
        'lifecycle.dispatched',
        expect.objectContaining({ jobType: JobType.Provision, deploymentId: 'dep-1' }),
      );
    });

    it('cedes without provisioning when the job leaves REQUESTED concurrently', async () => {
      vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(parkedJob(LifecycleJobPhase.REQUESTED));
      vi.spyOn(LifecycleJobRecord, 'claimTransition').mockResolvedValue(false);

      await service.startLinkedProvision('incoming-1');

      expect(provisionOperation.createDeployment).not.toHaveBeenCalled();
      expect(gateBus.runGate).not.toHaveBeenCalled();
    });

    it('aborts the job, releases the claim, and signals the orphaned deployment on a permanent gate veto', async () => {
      const job = parkedJob(LifecycleJobPhase.REQUESTED);
      vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);
      gateBus.runGate.mockRejectedValueOnce(new LifecycleGateRejection('not allowed'));

      await expect(service.startLinkedProvision('incoming-1')).resolves.toBeUndefined();

      expect(provisionOperation.publish).not.toHaveBeenCalled();
      expect(client.interruptibleClaim.delete).toHaveBeenCalledWith({ where: { id: 'claim-1' } });
      expect(job.data.phase).toBe(LifecycleJobPhase.ABORTED);
      expect(eventBus.emit).toHaveBeenCalledWith(
        'provision.failed',
        expect.objectContaining({ deploymentId: 'dep-1', jobType: JobType.Provision }),
      );
    });

    it('rethrows (no abort) on a transient bridge enqueue failure', async () => {
      const job = parkedJob(LifecycleJobPhase.REQUESTED);
      vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);
      provisionOperation.publish.mockRejectedValueOnce(new Error('bridge unreachable'));

      await expect(service.startLinkedProvision('incoming-1')).rejects.toThrow('bridge unreachable');

      expect(client.interruptibleClaim.delete).not.toHaveBeenCalled();
    });

    it('aborts the job on a permanent assembleContextForReplay failure (no reservation/deployment created)', async () => {
      const job = parkedJob(LifecycleJobPhase.REQUESTED);
      vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);
      provisionOperation.assembleContextForReplay.mockRejectedValueOnce(new BadRequestException('invalid context'));

      await expect(service.startLinkedProvision('incoming-1')).resolves.toBeUndefined();

      expect(job.data.phase).toBe(LifecycleJobPhase.ABORTED);
      expect(client.interruptibleClaim.delete).toHaveBeenCalledWith({ where: { id: 'claim-1' } });
      expect(provisionOperation.createReservation).not.toHaveBeenCalled();
      expect(provisionOperation.createDeployment).not.toHaveBeenCalled();
      expect(gateBus.runGate).not.toHaveBeenCalled();
      expect(provisionOperation.publish).not.toHaveBeenCalled();
    });

    it('rethrows on a transient assembleContextForReplay failure (claim left intact for retry)', async () => {
      const job = parkedJob(LifecycleJobPhase.REQUESTED);
      vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);
      provisionOperation.assembleContextForReplay.mockRejectedValueOnce(new Error('database unavailable'));

      await expect(service.startLinkedProvision('incoming-1')).rejects.toThrow('database unavailable');

      expect(client.interruptibleClaim.delete).not.toHaveBeenCalled();
      expect(provisionOperation.createReservation).not.toHaveBeenCalled();
      expect(provisionOperation.createDeployment).not.toHaveBeenCalled();
    });

    it('parks the linked provision in DEFERRED on a gate deferral, holding the claim and reservation', async () => {
      const job = parkedJob(LifecycleJobPhase.REQUESTED);
      vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);
      gateBus.runGate.mockRejectedValueOnce(new LifecycleGateDeferral('pending operator approval'));

      await expect(service.startLinkedProvision('incoming-1')).resolves.toBeUndefined();

      expect(provisionOperation.publish).not.toHaveBeenCalled();
      expect(client.interruptibleClaim.delete).not.toHaveBeenCalled();
      expect(reservationsService.endReservation).not.toHaveBeenCalled();
      expect(job.data.phase).toBe(LifecycleJobPhase.DEFERRED);
      expect(eventBus.emit).toHaveBeenCalledWith(
        'lifecycle.deferred',
        expect.objectContaining({ jobId: 'incoming-1', deploymentId: 'dep-1', reason: 'pending operator approval' }),
      );
    });
  });

  describe('abortLinkedProvision', () => {
    const linkedDeferredJob = () =>
      LifecycleJobRecord.build({
        id: 'incoming-1',
        jobType: JobType.Provision,
        phase: LifecycleJobPhase.DEFERRED,
        deviceId: 'incoming-device',
        deploymentId: 'dep-1',
        organizationId: 'incoming-org',
        performedBy: 'incoming-user',
        source: RequestSource.API,
        payload: { interruptible: true, interruptibleClaimId: 'claim-1' },
      });

    it('aborts a DEFERRED linked provision, compensates the deployment, and releases the claim', async () => {
      const job = linkedDeferredJob();
      vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);
      vi.spyOn(DeploymentRecord, 'findOneUnscoped').mockResolvedValue({
        data: { reservationId: 'res-1' },
      } as unknown as Awaited<ReturnType<typeof DeploymentRecord.findOneUnscoped>>);

      await service.abortLinkedProvision('incoming-1', 'eviction failed');

      expect(job.data.phase).toBe(LifecycleJobPhase.ABORTED);
      expect(client.interruptibleClaim.delete).toHaveBeenCalledWith({ where: { id: 'claim-1' } });
      expect(reservationsService.endReservation).toHaveBeenCalledWith('res-1');
      expect(eventBus.emit).toHaveBeenCalledWith(
        'provision.failed',
        expect.objectContaining({ deploymentId: 'dep-1' }),
      );
    });
  });

  describe('runSystem', () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);

    it('records an actorless SYSTEM job and walks it REQUESTED → AUTHORIZING → DISPATCHED', async () => {
      const job = await service.runSystem({
        jobType: JobType.InventoryCollection,
        deviceId: 'device-1',
        zoneId: 'zone-1',
        source: 'cron',
        dispatch,
      });

      expect(client.lifecycleJob.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            jobType: JobType.InventoryCollection,
            phase: LifecycleJobPhase.REQUESTED,
            deviceId: 'device-1',
            deploymentId: null,
            organizationId: null,
            performedBy: null,
            source: RequestSource.SYSTEM,
            payload: { source: 'cron', zoneId: 'zone-1' },
          }),
        }),
      );
      expect(dispatch).toHaveBeenCalledWith('job-1');
      expect(job.data.id).toBe('job-1');
      expect(job.data.phase).toBe(LifecycleJobPhase.DISPATCHED);
      expect(gateBus.runGate).not.toHaveBeenCalled();
      expect(watchdogQueue.add).not.toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    it('fails the job and rethrows when the dispatch is refused', async () => {
      dispatch.mockRejectedValueOnce(new Error('queue down'));

      await expect(
        service.runSystem({
          jobType: JobType.Benchmarks,
          deviceId: 'device-1',
          zoneId: 'zone-1',
          source: 'discovery',
          dispatch,
        }),
      ).rejects.toThrow('queue down');

      expect(client.lifecycleJob.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ phase: LifecycleJobPhase.FAILED, error: 'queue down' }),
        }),
      );
    });
  });
});
