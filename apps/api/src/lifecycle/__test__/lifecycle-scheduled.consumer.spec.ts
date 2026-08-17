import { Test } from '@nestjs/testing';
import { RESUME_SCHEDULED_JOB, START_LINKED_PROVISION_JOB, type ScheduledJobData } from '@repo/lifecycle';
import type { Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LifecycleScheduledConsumer } from '../inbound/lifecycle-scheduled.consumer';
import { LifecycleService } from '../lifecycle.service';

describe('LifecycleScheduledConsumer', () => {
  const lifecycle = {
    resumeScheduled: vi.fn().mockResolvedValue(undefined),
    startLinkedProvision: vi.fn().mockResolvedValue(undefined),
  };
  let consumer: LifecycleScheduledConsumer;

  beforeEach(async () => {
    vi.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        LifecycleScheduledConsumer,
        { provide: LifecycleService, useValue: lifecycle },
        {
          provide: 'LoggerServiceLifecycleScheduledConsumer',
          useValue: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        },
      ],
    }).compile();
    consumer = moduleRef.get(LifecycleScheduledConsumer);
  });

  const bullJob = (name: string, jobId: string) => ({ name, data: { jobId } }) as Job<ScheduledJobData, void, string>;

  it('resumes the scheduled job on a resume timer', async () => {
    const jobId = '11111111-1111-4111-8111-111111111111';
    await consumer.process(bullJob(RESUME_SCHEDULED_JOB, jobId));
    expect(lifecycle.resumeScheduled).toHaveBeenCalledWith(jobId);
    expect(lifecycle.startLinkedProvision).not.toHaveBeenCalled();
  });

  it('starts the linked provision on a start-linked-provision job', async () => {
    const jobId = '22222222-2222-4222-8222-222222222222';
    await consumer.process(bullJob(START_LINKED_PROVISION_JOB, jobId));
    expect(lifecycle.startLinkedProvision).toHaveBeenCalledWith(jobId);
    expect(lifecycle.resumeScheduled).not.toHaveBeenCalled();
  });

  it('rejects malformed job data (non-uuid) before dispatching', async () => {
    await expect(consumer.process(bullJob(RESUME_SCHEDULED_JOB, 'not-a-uuid'))).rejects.toThrow();
    expect(lifecycle.resumeScheduled).not.toHaveBeenCalled();
    expect(lifecycle.startLinkedProvision).not.toHaveBeenCalled();
  });
});
