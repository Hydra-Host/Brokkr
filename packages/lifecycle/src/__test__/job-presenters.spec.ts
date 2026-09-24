import {
  JobType,
  LifecycleJobPhase,
  RequestSource,
  type LifecycleJob,
  type LifecycleJobEvent,
} from '@repo/database';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readJobEvents,
  toCustomerJobEvent,
  toCustomerJobSummary,
  toLifecycleJobEvent,
  toLifecycleJobSummary,
} from '../job-presenters';
import { LifecycleJobRecord } from '../lifecycle-job.record';

const JOB = '44444444-4444-4444-4444-444444444444';

const jobRow = (overrides: Partial<LifecycleJob> = {}): LifecycleJob => ({
  id: JOB,
  jobType: JobType.Provision,
  phase: LifecycleJobPhase.RUNNING,
  payload: {},
  deviceId: 'device-1',
  deploymentId: null,
  organizationId: 'org-1',
  source: RequestSource.UI,
  performedBy: 'user-1',
  scheduledAt: null,
  phoneHomeDeadline: null,
  linkedJobId: null,
  error: null,
  createdAt: new Date('2026-08-28T10:00:00.000Z'),
  updatedAt: new Date('2026-08-28T10:05:00.000Z'),
  ...overrides,
});

const eventRow = (overrides: Partial<LifecycleJobEvent> = {}): LifecycleJobEvent => ({
  id: 'e-1',
  jobId: JOB,
  sagaName: 'provision',
  stepName: 'power_cycle',
  operation: 'Set the boot order',
  eventType: 'job_failed',
  status: 'failed',
  result: { password: 'x', ok: 1 },
  error: 'BMC did not answer',
  attempt: 1,
  occurredAt: new Date('2026-09-16T12:00:00.000Z'),
  recordedAt: new Date('2026-09-16T12:00:06.200Z'),
  ...overrides,
});

afterEach(() => vi.restoreAllMocks());

describe('toLifecycleJobSummary', () => {
  it('leaves completedAt null while the job is in flight', () => {
    expect(toLifecycleJobSummary(jobRow())).toEqual({
      id: JOB,
      jobType: JobType.Provision,
      phase: LifecycleJobPhase.RUNNING,
      deviceId: 'device-1',
      deploymentId: null,
      source: RequestSource.UI,
      performedBy: 'user-1',
      error: null,
      createdAt: '2026-08-28T10:00:00.000Z',
      completedAt: null,
    });
  });

  it('reports updatedAt as completedAt on the terminal phases', () => {
    const completed = toLifecycleJobSummary(jobRow({ phase: LifecycleJobPhase.COMPLETED }));
    const failed = toLifecycleJobSummary(jobRow({ phase: LifecycleJobPhase.FAILED, error: 'ipmi timeout' }));
    expect(completed.completedAt).toBe('2026-08-28T10:05:00.000Z');
    expect(failed).toMatchObject({ completedAt: '2026-08-28T10:05:00.000Z', error: 'ipmi timeout' });
  });
});

describe('toLifecycleJobEvent', () => {
  it('redacts secret-shaped result keys and serializes the timestamps', () => {
    expect(toLifecycleJobEvent(eventRow())).toEqual({
      id: 'e-1',
      sagaName: 'provision',
      stepName: 'power_cycle',
      operation: 'Set the boot order',
      eventType: 'job_failed',
      status: 'failed',
      result: { password: '***', ok: 1 },
      error: 'BMC did not answer',
      attempt: 1,
      occurredAt: '2026-09-16T12:00:00.000Z',
      recordedAt: '2026-09-16T12:00:06.200Z',
      origin: 'bridge',
    });
  });

  it('marks the hub-stamped event types as hub origin', () => {
    const origins = ['phone_home', 'power_watchdog', 'stuck_sweep', 'job_completed'].map(
      (eventType) => toLifecycleJobEvent(eventRow({ eventType })).origin,
    );
    expect(origins).toEqual(['hub', 'hub', 'hub', 'bridge']);
  });
});

describe('toCustomerJobSummary', () => {
  it('nulls the failure text and the requesting user and keeps every other field', () => {
    const summary = toLifecycleJobSummary(
      jobRow({ phase: LifecycleJobPhase.FAILED, error: 'bridge reported failure', performedBy: 'user-1' }),
    );

    expect(toCustomerJobSummary(summary)).toEqual({
      id: JOB,
      jobType: JobType.Provision,
      phase: LifecycleJobPhase.FAILED,
      deviceId: 'device-1',
      deploymentId: null,
      source: RequestSource.UI,
      performedBy: null,
      error: null,
      createdAt: '2026-08-28T10:00:00.000Z',
      completedAt: '2026-08-28T10:05:00.000Z',
    });
  });
});

describe('toCustomerJobEvent', () => {
  it('nulls the step result and the bridge error and keeps the attempt, origin and both clocks', () => {
    const event = toLifecycleJobEvent(
      eventRow({ result: { wwn: '0x5000' }, error: 'IPMI ping failed - IP 10.40.0.17', attempt: 2 }),
    );

    expect(toCustomerJobEvent(event)).toEqual({
      id: 'e-1',
      sagaName: 'provision',
      stepName: 'power_cycle',
      operation: 'Set the boot order',
      eventType: 'job_failed',
      status: 'failed',
      result: null,
      error: null,
      attempt: 2,
      occurredAt: '2026-09-16T12:00:00.000Z',
      recordedAt: '2026-09-16T12:00:06.200Z',
      origin: 'bridge',
    });
  });
});

describe('readJobEvents', () => {
  it('reads one past the cap and reports truncation', async () => {
    const rows = Array.from({ length: 4 }, (_, i) => eventRow({ id: `e-${i}` }));
    const list = vi.spyOn(LifecycleJobRecord, 'listEventsUnscoped').mockResolvedValue(rows);

    const page = await readJobEvents(JOB, 3);

    expect(list).toHaveBeenCalledWith(JOB, 4);
    expect(page.truncated).toBe(true);
    expect(page.events.map((event) => event.id)).toEqual(['e-0', 'e-1', 'e-2']);
  });

  it('returns every presented event when the job stays within the cap', async () => {
    vi.spyOn(LifecycleJobRecord, 'listEventsUnscoped').mockResolvedValue([
      eventRow(),
      eventRow({ id: 'e-2', eventType: 'phone_home' }),
    ]);

    const page = await readJobEvents(JOB, 3);

    expect(page.truncated).toBe(false);
    expect(page.events.map((event) => [event.id, event.origin])).toEqual([
      ['e-1', 'bridge'],
      ['e-2', 'hub'],
    ]);
  });
});
