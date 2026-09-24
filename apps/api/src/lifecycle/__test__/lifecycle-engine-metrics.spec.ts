import { PLUGIN_EVENT_BUS } from '@hydrahost/plugin-sdk';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { ActiveRecordRegistry } from '@repo/active-record';
import { JobType, LifecycleJobPhase, ServerLifecycleStatus } from '@repo/database';
import { LIFECYCLE_WATCHDOG_QUEUE, LifecycleJobRecord } from '@repo/lifecycle';
import { DeviceTokensService } from 'src/device-tokens/device-tokens.service';
import { RedisPubSubService } from 'src/events/redis-pubsub.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LifecycleInboundService } from '../inbound/lifecycle-inbound.service';
import { LifecycleService } from '../lifecycle.service';
import { jobAt, makeMockClient } from './test-helpers';

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

describe('LifecycleInboundService — brokkr.device_lifecycle.transitions (engine)', () => {
  const eventBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
  const prisma = {
    device: { update: vi.fn().mockResolvedValue({}), findUnique: vi.fn() },
    server: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn().mockResolvedValue(1),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
  const watchdogQueue = { add: vi.fn().mockResolvedValue({ id: 'bull-1' }) };
  const lifecycleService = {
    enqueueLinkedProvision: vi.fn().mockResolvedValue(undefined),
    abortLinkedProvision: vi.fn().mockResolvedValue(undefined),
  };

  let service: LifecycleInboundService;
  let constructionAdds: unknown[][];

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    counterAdd.mockClear();
    prisma.server.findUnique.mockResolvedValue(null);
    prisma.server.updateMany.mockResolvedValue({ count: 1 });
    ActiveRecordRegistry.configureForTest(makeMockClient(), null);
    vi.spyOn(LifecycleJobRecord, 'appendEvent').mockResolvedValue(undefined as never);
    vi.spyOn(LifecycleJobRecord, 'claimTransition').mockResolvedValue(true);

    const moduleRef = await Test.createTestingModule({
      providers: [
        LifecycleInboundService,
        { provide: PLUGIN_EVENT_BUS, useValue: eventBus },
        { provide: PrismaClient, useValue: prisma },
        { provide: getQueueToken(LIFECYCLE_WATCHDOG_QUEUE), useValue: watchdogQueue },
        { provide: LifecycleService, useValue: lifecycleService },
        { provide: DeviceTokensService, useValue: { runWithDeploymentTokenRevocation: vi.fn() } },
        { provide: RedisPubSubService, useValue: { publish: vi.fn() } },
        {
          provide: 'LoggerServiceLifecycleInboundService',
          useValue: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        },
      ],
    }).compile();
    service = moduleRef.get(LifecycleInboundService);
    constructionAdds = counterAdd.mock.calls.map((call) => [...call]);
    counterAdd.mockClear();
  });

  const failViaPhoneHomeDeadline = () => {
    vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(jobAt(LifecycleJobPhase.AWAITING_PHONE_HOME));
    return service.checkPhoneHomeDeadline('job-1');
  };

  const writeServer = (write: { lifecycleStatus?: ServerLifecycleStatus; powerStatus?: null }) =>
    (service as any).writeServer('device-1', 'job-1', write) as Promise<void>;

  it('pre-registers the FAILED/lifecycle_engine series at zero for alert birth', () => {
    expect(constructionAdds).toContainEqual([
      'brokkr.device_lifecycle.transitions',
      0,
      { to_status: ServerLifecycleStatus.FAILED, source: 'lifecycle_engine' },
    ]);
  });

  it('counts an engine-written FAILED transition with source=lifecycle_engine', async () => {
    prisma.server.updateMany.mockResolvedValue({ count: 1 });

    await failViaPhoneHomeDeadline();

    expect(prisma.server.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deviceId: 'device-1', lifecycleStatus: { not: ServerLifecycleStatus.FAILED } },
        data: { lifecycleStatus: ServerLifecycleStatus.FAILED },
      }),
    );
    expect(counterAdd).toHaveBeenCalledWith('brokkr.device_lifecycle.transitions', 1, {
      to_status: ServerLifecycleStatus.FAILED,
      source: 'lifecycle_engine',
    });
  });

  it('does not count a same-status re-write (conditional updateMany matches nothing)', async () => {
    prisma.server.updateMany.mockResolvedValue({ count: 0 });

    await failViaPhoneHomeDeadline();

    expect(prisma.device.update).toHaveBeenCalled();
    expect(counterAdd).not.toHaveBeenCalledWith('brokkr.device_lifecycle.transitions', 1, expect.anything());
  });

  it('counts an engine-written INVENTORY transition (deprovision → inventory)', async () => {
    prisma.server.updateMany.mockResolvedValue({ count: 1 });

    await writeServer({ lifecycleStatus: ServerLifecycleStatus.INVENTORY });

    expect(counterAdd).toHaveBeenCalledWith('brokkr.device_lifecycle.transitions', 1, {
      to_status: ServerLifecycleStatus.INVENTORY,
      source: 'lifecycle_engine',
    });
  });

  it('never probes for a transition on a power-only write (a failed power saga clears powerStatus)', async () => {
    vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(
      jobAt(LifecycleJobPhase.DISPATCHED, JobType.Reboot),
    );

    await service.checkPowerSagaDeadline('job-1');

    expect(prisma.server.updateMany).not.toHaveBeenCalled();
    expect(counterAdd).not.toHaveBeenCalledWith('brokkr.device_lifecycle.transitions', 1, expect.anything());
  });
});
