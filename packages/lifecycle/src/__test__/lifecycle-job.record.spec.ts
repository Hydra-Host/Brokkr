import { ActiveRecordRegistry } from '@repo/active-record';
import { JobType, LifecycleJobPhase, RequestSource } from '@repo/database';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LifecycleJobRecord } from '../lifecycle-job.record';
import { IllegalPhaseTransitionError } from '../lifecycle-state.machine';

function jobAt(phase: LifecycleJobPhase, jobType: JobType = JobType.Provision): LifecycleJobRecord {
  return LifecycleJobRecord.build({
    jobType,
    source: RequestSource.API,
    organizationId: 'org-1',
    payload: {},
    phase,
  });
}

describe('LifecycleJobRecord transitions', () => {
  it('authorize(): REQUESTED and SCHEDULED → AUTHORIZING; illegal elsewhere', () => {
    expect(jobAt(LifecycleJobPhase.REQUESTED).authorize().data.phase).toBe(LifecycleJobPhase.AUTHORIZING);
    expect(jobAt(LifecycleJobPhase.SCHEDULED).authorize().data.phase).toBe(LifecycleJobPhase.AUTHORIZING);
    expect(() => jobAt(LifecycleJobPhase.DISPATCHED).authorize()).toThrow(IllegalPhaseTransitionError);
  });

  it('schedule(at): REQUESTED → SCHEDULED and records the deadline; illegal elsewhere', () => {
    const at = new Date('2026-06-04T00:00:00Z');
    const job = jobAt(LifecycleJobPhase.REQUESTED).schedule(at);
    expect(job.data.phase).toBe(LifecycleJobPhase.SCHEDULED);
    expect(job.data.scheduledAt).toBe(at);
    expect(() => jobAt(LifecycleJobPhase.RUNNING).schedule(at)).toThrow(IllegalPhaseTransitionError);
  });

  it('reschedule(): retry edge from AUTHORIZING and DISPATCHED → SCHEDULED; illegal from RUNNING', () => {
    expect(jobAt(LifecycleJobPhase.AUTHORIZING).reschedule().data.phase).toBe(LifecycleJobPhase.SCHEDULED);
    expect(jobAt(LifecycleJobPhase.DISPATCHED).reschedule().data.phase).toBe(LifecycleJobPhase.SCHEDULED);
    expect(() => jobAt(LifecycleJobPhase.RUNNING).reschedule()).toThrow(IllegalPhaseTransitionError);
  });

  it('dispatch(): AUTHORIZING → DISPATCHED; illegal from REQUESTED', () => {
    expect(jobAt(LifecycleJobPhase.AUTHORIZING).dispatch().data.phase).toBe(LifecycleJobPhase.DISPATCHED);
    expect(() => jobAt(LifecycleJobPhase.REQUESTED).dispatch()).toThrow(IllegalPhaseTransitionError);
  });

  it('beginRunning(): DISPATCHED → RUNNING; not idempotent from RUNNING', () => {
    expect(jobAt(LifecycleJobPhase.DISPATCHED).beginRunning().data.phase).toBe(LifecycleJobPhase.RUNNING);
    expect(() => jobAt(LifecycleJobPhase.RUNNING).beginRunning()).toThrow(IllegalPhaseTransitionError);
  });

  it('awaitPhoneHome(deadline): RUNNING → AWAITING_PHONE_HOME and records the deadline', () => {
    const deadline = new Date('2026-06-04T01:00:00Z');
    const job = jobAt(LifecycleJobPhase.RUNNING).awaitPhoneHome(deadline);
    expect(job.data.phase).toBe(LifecycleJobPhase.AWAITING_PHONE_HOME);
    expect(job.data.phoneHomeDeadline).toBe(deadline);
    expect(() => jobAt(LifecycleJobPhase.DISPATCHED).awaitPhoneHome(deadline)).toThrow(IllegalPhaseTransitionError);
  });

  it('complete(): RUNNING and AWAITING_PHONE_HOME → COMPLETED; illegal from DISPATCHED', () => {
    expect(jobAt(LifecycleJobPhase.RUNNING).complete().data.phase).toBe(LifecycleJobPhase.COMPLETED);
    expect(jobAt(LifecycleJobPhase.AWAITING_PHONE_HOME).complete().data.phase).toBe(LifecycleJobPhase.COMPLETED);
    expect(() => jobAt(LifecycleJobPhase.DISPATCHED).complete()).toThrow(IllegalPhaseTransitionError);
  });

  it('fail(error): from RUNNING → FAILED and records the error; illegal from REQUESTED', () => {
    const job = jobAt(LifecycleJobPhase.RUNNING).fail('bridge timeout');
    expect(job.data.phase).toBe(LifecycleJobPhase.FAILED);
    expect(job.data.error).toBe('bridge timeout');
    expect(() => jobAt(LifecycleJobPhase.REQUESTED).fail('x')).toThrow(IllegalPhaseTransitionError);
  });

  it('abort(error): from REQUESTED/SCHEDULED/AUTHORIZING → ABORTED; illegal from RUNNING', () => {
    for (const phase of [LifecycleJobPhase.REQUESTED, LifecycleJobPhase.SCHEDULED, LifecycleJobPhase.AUTHORIZING]) {
      const job = jobAt(phase).abort('card declined');
      expect(job.data.phase).toBe(LifecycleJobPhase.ABORTED);
      expect(job.data.error).toBe('card declined');
    }
    expect(() => jobAt(LifecycleJobPhase.RUNNING).abort('x')).toThrow(IllegalPhaseTransitionError);
  });
});

describe('LifecycleJobRecord.appendEvent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    ActiveRecordRegistry.configureForTest(null, null);
  });

  it('writes a LifecycleJobEvent through the raw client, skipping redelivered duplicates', async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    ActiveRecordRegistry.configureForTest({ lifecycleJobEvent: { createMany } }, null);

    const occurredAt = new Date('2026-06-04T02:00:00Z');
    await LifecycleJobRecord.appendEvent({
      jobId: 'job-1',
      sagaName: 'provision',
      stepName: 'prepare_storage',
      eventType: 'stage_changed',
      status: 'running',
      result: { ok: true },
      occurredAt,
    });

    expect(createMany).toHaveBeenCalledWith({
      data: [
        {
          jobId: 'job-1',
          sagaName: 'provision',
          stepName: 'prepare_storage',
          operation: null,
          eventType: 'stage_changed',
          status: 'running',
          result: { ok: true },
          error: null,
          attempt: 0,
          occurredAt,
        },
      ],
      skipDuplicates: true,
    });
  });
});

describe('LifecycleJobRecord.findPageByTargetUnscoped', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    ActiveRecordRegistry.configureForTest(null, null);
  });

  function mockLifecycleJobDelegate(rows: unknown[] = [], total = rows.length) {
    const findMany = vi.fn().mockResolvedValue(rows);
    const count = vi.fn().mockResolvedValue(total);
    ActiveRecordRegistry.configureForTest({ lifecycleJob: { findMany, count } }, null);
    return { findMany, count };
  }

  it('filters by deviceId and applies the createdAt-desc default sort', async () => {
    const { findMany, count } = mockLifecycleJobDelegate();

    await LifecycleJobRecord.findPageByTargetUnscoped({}, { deviceId: 'device-1' });

    expect(findMany).toHaveBeenCalledWith({
      where: { deviceId: 'device-1' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: 0,
      take: 20,
    });
    expect(count).toHaveBeenCalledWith({ where: { deviceId: 'device-1' } });
  });

  it('filters by deploymentId without a deviceId key', async () => {
    const { findMany, count } = mockLifecycleJobDelegate();

    await LifecycleJobRecord.findPageByTargetUnscoped({}, { deploymentId: 'dep-1' });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { deploymentId: 'dep-1' } }));
    expect(count).toHaveBeenCalledWith({ where: { deploymentId: 'dep-1' } });
  });

  it('combines deviceId and deploymentId filters and paginates', async () => {
    const { findMany, count } = mockLifecycleJobDelegate();

    await LifecycleJobRecord.findPageByTargetUnscoped(
      { page: 2, pageSize: 10 },
      { deviceId: 'device-1', deploymentId: 'dep-1' },
    );

    expect(findMany).toHaveBeenCalledWith({
      where: { deviceId: 'device-1', deploymentId: 'dep-1' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: 10,
      take: 10,
    });
    expect(count).toHaveBeenCalledWith({ where: { deviceId: 'device-1', deploymentId: 'dep-1' } });
  });

  it('keeps the target filter when a search term is present', async () => {
    const { findMany } = mockLifecycleJobDelegate();

    await LifecycleJobRecord.findPageByTargetUnscoped({ search: 'job-a' }, { deploymentId: 'dep-1' });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          deploymentId: 'dep-1',
          AND: [{ OR: [{ id: { contains: 'job-a', mode: 'insensitive' } }] }],
        },
      }),
    );
  });

  it('returns the rows with pagination meta', async () => {
    const rows = [{ id: 'job-1' }, { id: 'job-2' }];
    mockLifecycleJobDelegate(rows, 5);

    const result = await LifecycleJobRecord.findPageByTargetUnscoped({ page: 2, pageSize: 2 }, { deviceId: 'device-1' });

    expect(result.data).toEqual(rows);
    expect(result.meta).toEqual({ page: 2, pageSize: 2, totalItems: 5, totalPages: 3 });
  });
});

describe('LifecycleJobRecord.claimTransition', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    ActiveRecordRegistry.configureForTest(null, null);
  });

  it('applies the phase-guarded write and reports the claim', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    ActiveRecordRegistry.configureForTest({ lifecycleJob: { updateMany } }, null);

    await expect(
      LifecycleJobRecord.claimTransition('job-1', LifecycleJobPhase.DISPATCHED, LifecycleJobPhase.FAILED, 'stuck'),
    ).resolves.toBe(true);

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', phase: LifecycleJobPhase.DISPATCHED },
      data: { phase: LifecycleJobPhase.FAILED, error: 'stuck' },
    });
  });

  it('omits the error column when no error is given (non-failure claims)', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    ActiveRecordRegistry.configureForTest({ lifecycleJob: { updateMany } }, null);

    await LifecycleJobRecord.claimTransition('job-1', LifecycleJobPhase.SCHEDULED, LifecycleJobPhase.AUTHORIZING);

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', phase: LifecycleJobPhase.SCHEDULED },
      data: { phase: LifecycleJobPhase.AUTHORIZING },
    });
  });

  it('returns false when the job moved on (no row matched the expected phase)', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    ActiveRecordRegistry.configureForTest({ lifecycleJob: { updateMany } }, null);

    await expect(
      LifecycleJobRecord.claimTransition('job-1', LifecycleJobPhase.RUNNING, LifecycleJobPhase.FAILED, 'stuck'),
    ).resolves.toBe(false);
  });

  it('rejects an illegal edge without writing', async () => {
    const updateMany = vi.fn();
    ActiveRecordRegistry.configureForTest({ lifecycleJob: { updateMany } }, null);

    await expect(
      LifecycleJobRecord.claimTransition('job-1', LifecycleJobPhase.REQUESTED, LifecycleJobPhase.FAILED, 'stuck'),
    ).rejects.toThrow(IllegalPhaseTransitionError);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
