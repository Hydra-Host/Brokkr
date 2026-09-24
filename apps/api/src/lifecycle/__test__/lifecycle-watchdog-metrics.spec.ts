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

describe('LifecycleInboundService — brokkr.lifecycle.watchdog_timeouts', () => {
  const eventBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
  const prisma = {
    device: { update: vi.fn().mockResolvedValue({}) },
    server: {
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };

  const watchdogCalls = () => counterAdd.mock.calls.filter((c) => c[0] === 'brokkr.lifecycle.watchdog_timeouts');
  const watchdogQueue = { add: vi.fn().mockResolvedValue({ id: 'bull-1' }) };
  const lifecycleService = {
    enqueueLinkedProvision: vi.fn().mockResolvedValue(undefined),
    abortLinkedProvision: vi.fn().mockResolvedValue(undefined),
  };

  let service: LifecycleInboundService;

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    counterAdd.mockClear();
    prisma.server.findUnique.mockResolvedValue(null);
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
    counterAdd.mockClear();
  });

  it('counts a phone-home deadline that fails the job', async () => {
    vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(jobAt(LifecycleJobPhase.AWAITING_PHONE_HOME));

    await service.checkPhoneHomeDeadline('job-1');

    expect(watchdogCalls()).toEqual([['brokkr.lifecycle.watchdog_timeouts', 1, undefined]]);
  });

  it('does not count when another context already terminalized the job (claim lost)', async () => {
    vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(jobAt(LifecycleJobPhase.AWAITING_PHONE_HOME));
    vi.spyOn(LifecycleJobRecord, 'claimTransition').mockResolvedValue(false);

    await service.checkPhoneHomeDeadline('job-1');

    expect(watchdogCalls()).toEqual([]);
  });

  it('does not count the completed-instead-of-failed rescue path', async () => {
    vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(jobAt(LifecycleJobPhase.AWAITING_PHONE_HOME));
    prisma.server.findUnique.mockResolvedValue({ lifecycleStatus: ServerLifecycleStatus.PROVISIONED });

    await service.checkPhoneHomeDeadline('job-1');

    expect(watchdogCalls()).toEqual([]);
  });

  it('does not count a job that already resolved before the deadline fired', async () => {
    vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(jobAt(LifecycleJobPhase.COMPLETED));

    await service.checkPhoneHomeDeadline('job-1');

    expect(watchdogCalls()).toEqual([]);
  });

  it('counts a power-saga deadline that fails the job', async () => {
    vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(
      jobAt(LifecycleJobPhase.DISPATCHED, JobType.Reboot),
    );

    await service.checkPowerSagaDeadline('job-1');

    expect(watchdogCalls()).toEqual([['brokkr.lifecycle.watchdog_timeouts', 1, undefined]]);
  });

  it('counts a power-saga deadline that fails a RUNNING job', async () => {
    vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(
      jobAt(LifecycleJobPhase.RUNNING, JobType.Reboot),
    );

    await service.checkPowerSagaDeadline('job-1');

    expect(watchdogCalls()).toEqual([['brokkr.lifecycle.watchdog_timeouts', 1, undefined]]);
  });

  it('does not count a power job that already resolved', async () => {
    vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(
      jobAt(LifecycleJobPhase.COMPLETED, JobType.Reboot),
    );

    await service.checkPowerSagaDeadline('job-1');

    expect(watchdogCalls()).toEqual([]);
  });
});
