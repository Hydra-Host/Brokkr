import { Test } from '@nestjs/testing';
import { PHONE_HOME_WATCHDOG_JOB, POWER_WATCHDOG_JOB, type ScheduledJobData } from '@repo/lifecycle';
import type { Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LifecycleInboundService } from '../inbound/lifecycle-inbound.service';
import { LifecycleWatchdogConsumer } from '../inbound/lifecycle-watchdog.consumer';

const JOB_ID = '11111111-1111-4111-8111-111111111111';

function makeBullJob(name: string, jobId: string): Job<ScheduledJobData, void, string> {
  return { name, data: { jobId } } as Job<ScheduledJobData, void, string>;
}

describe('LifecycleWatchdogConsumer', () => {
  const inbound = {
    checkPhoneHomeDeadline: vi.fn().mockResolvedValue(undefined),
    checkPowerSagaDeadline: vi.fn().mockResolvedValue(undefined),
  };
  let consumer: LifecycleWatchdogConsumer;

  beforeEach(async () => {
    vi.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        LifecycleWatchdogConsumer,
        { provide: LifecycleInboundService, useValue: inbound },
        {
          provide: 'LoggerServiceLifecycleWatchdogConsumer',
          useValue: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        },
      ],
    }).compile();
    consumer = moduleRef.get(LifecycleWatchdogConsumer);
  });

  it('routes the phone-home watchdog to checkPhoneHomeDeadline', async () => {
    await consumer.process(makeBullJob(PHONE_HOME_WATCHDOG_JOB, JOB_ID));
    expect(inbound.checkPhoneHomeDeadline).toHaveBeenCalledWith(JOB_ID);
    expect(inbound.checkPowerSagaDeadline).not.toHaveBeenCalled();
  });

  it('routes the power watchdog to checkPowerSagaDeadline', async () => {
    await consumer.process(makeBullJob(POWER_WATCHDOG_JOB, JOB_ID));
    expect(inbound.checkPowerSagaDeadline).toHaveBeenCalledWith(JOB_ID);
    expect(inbound.checkPhoneHomeDeadline).not.toHaveBeenCalled();
  });

  it('ignores unknown watchdog job names', async () => {
    await consumer.process(makeBullJob('unknown-watchdog', JOB_ID));
    expect(inbound.checkPhoneHomeDeadline).not.toHaveBeenCalled();
    expect(inbound.checkPowerSagaDeadline).not.toHaveBeenCalled();
  });

  it('rejects malformed job data before checking', async () => {
    await expect(consumer.process(makeBullJob(PHONE_HOME_WATCHDOG_JOB, 'not-a-uuid'))).rejects.toThrow();
    expect(inbound.checkPhoneHomeDeadline).not.toHaveBeenCalled();
  });
});
