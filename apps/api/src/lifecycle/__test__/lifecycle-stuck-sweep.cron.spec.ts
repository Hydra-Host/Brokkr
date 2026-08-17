import type { ConfigService } from '@nestjs/config';
import { LIFECYCLE_STUCK_SWEEP_JOB, LIFECYCLE_STUCK_SWEEP_SCHEDULE } from '@repo/lifecycle';
import type { Job, Queue } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LoggerService } from '../../logger/logger.service';
import type { LifecycleInboundService } from '../inbound/lifecycle-inbound.service';
import { LifecycleStuckSweepCron } from '../inbound/lifecycle-stuck-sweep.cron';
import { LifecycleModule } from '../lifecycle.module';

const { counterAdd } = vi.hoisted(() => ({ counterAdd: vi.fn() }));
vi.mock('@repo/telemetry', () => ({
  getTelemetryMeter: () => ({
    createCounter: (name: string) => ({
      add: (value: number, attributes?: Record<string, unknown>) => counterAdd(name, value, attributes),
    }),
  }),
  getBullMqTelemetry: () => undefined,
}));

const JOB = {} as Job;

function buildCron(opts?: { enabled?: string; swept?: number }) {
  const sweepStuckJobs = vi.fn().mockResolvedValue(opts?.swept ?? 0);
  const inbound = { sweepStuckJobs } as unknown as LifecycleInboundService;
  const configService = { get: vi.fn().mockReturnValue(opts?.enabled ?? 'true') } as unknown as ConfigService;

  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as LoggerService;

  const cron = new LifecycleStuckSweepCron(inbound, configService, logger);
  const pause = vi.fn(async () => {});
  (cron as unknown as { _worker: { pause: typeof pause } })._worker = { pause };

  return { cron, sweepStuckJobs, pause };
}

describe('LifecycleStuckSweepCron.process', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs the sweep once per tick', async () => {
    const { cron, sweepStuckJobs } = buildCron({ swept: 2 });
    await cron.process(JOB);
    expect(sweepStuckJobs).toHaveBeenCalledOnce();
  });

  it('counts terminalized jobs on brokkr.lifecycle.stuck_swept', async () => {
    const { cron } = buildCron({ swept: 3 });
    await cron.process(JOB);
    expect(counterAdd).toHaveBeenCalledExactlyOnceWith('brokkr.lifecycle.stuck_swept', 3, undefined);
  });

  it('does not count a sweep that terminalized nothing', async () => {
    const { cron } = buildCron({ swept: 0 });
    await cron.process(JOB);
    expect(counterAdd).not.toHaveBeenCalled();
  });

  it('throws without sweeping when disabled so the tick fails instead of being silently acked', async () => {
    const { cron, sweepStuckJobs } = buildCron({ enabled: 'false' });
    await expect(cron.process(JOB)).rejects.toThrow();
    expect(sweepStuckJobs).not.toHaveBeenCalled();
  });

  it('rethrows a sweep failure so the tick is marked failed', async () => {
    const { cron, sweepStuckJobs } = buildCron();
    sweepStuckJobs.mockRejectedValueOnce(new Error('db down'));
    await expect(cron.process(JOB)).rejects.toThrow('db down');
  });

  it('pauses the worker on bootstrap when disabled, runs when enabled', async () => {
    const disabled = buildCron({ enabled: 'false' });
    await disabled.cron.onApplicationBootstrap();
    expect(disabled.pause).toHaveBeenCalledOnce();

    const enabled = buildCron();
    await enabled.cron.onApplicationBootstrap();
    expect(enabled.pause).not.toHaveBeenCalled();
  });
});

describe('LifecycleModule.onModuleInit', () => {
  beforeEach(() => vi.clearAllMocks());

  function buildModule(enabled?: string) {
    const upsertJobScheduler = vi.fn().mockResolvedValue(undefined);
    const queue = { upsertJobScheduler } as unknown as Queue;
    const configService = { get: vi.fn().mockReturnValue(enabled) } as unknown as ConfigService;
    return { module: new LifecycleModule(queue, configService), upsertJobScheduler };
  }

  it('registers the stuck-sweep repeatable scheduler with retry', async () => {
    const { module, upsertJobScheduler } = buildModule();
    await module.onModuleInit();
    expect(upsertJobScheduler).toHaveBeenCalledWith(
      LIFECYCLE_STUCK_SWEEP_JOB,
      { pattern: LIFECYCLE_STUCK_SWEEP_SCHEDULE },
      expect.objectContaining({ name: LIFECYCLE_STUCK_SWEEP_JOB }),
    );
    const [, , template] = upsertJobScheduler.mock.calls[0];
    expect(template.opts.attempts).toBeGreaterThan(1);
  });

  it('skips registration when disabled', async () => {
    const { module, upsertJobScheduler } = buildModule('false');
    await module.onModuleInit();
    expect(upsertJobScheduler).not.toHaveBeenCalled();
  });
});
