import type { LifecycleJobEvent, LifecycleJobEventsResponse } from '@repo/api-client';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OPEN_JOB_POLL_MS } from '../../hooks/poll-intervals';
import type { DiagnosticsApi } from '../../hooks/use-diagnostics-api';
import { fakeDiagnosticsApi, renderWithDiagnostics } from '../../test/diagnostics-harness';
import { JobStepsPane, recoveryNotes } from '../job-steps-pane';

const jobEvents = vi.fn<DiagnosticsApi['jobEvents']>();
const gate = { canView: true };

const api = () =>
  fakeDiagnosticsApi({
    jobEvents,
    gates: { isLoading: false, can: (name) => (name === 'jobs.view' ? gate.canView : true) },
  });

const event = (over: Partial<LifecycleJobEvent> = {}): LifecycleJobEvent => ({
  id: 'e-1',
  sagaName: 'provision',
  stepName: 'set_boot_order',
  operation: null,
  eventType: 'job_completed',
  status: 'complete',
  result: null,
  error: null,
  attempt: 0,
  occurredAt: '2026-09-16T12:00:00.000Z',
  recordedAt: '2026-09-16T12:00:00.000Z',
  origin: 'bridge',
  ...over,
});

const page = (data: LifecycleJobEvent[]): LifecycleJobEventsResponse => ({
  data,
  meta: { truncated: false, cap: 500 },
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  jobEvents.mockReset();
  gate.canView = true;
});

describe('recoveryNotes', () => {
  it('reports the highest retry per step once', () => {
    const notes = recoveryNotes([
      event({ id: 'a', stepName: 'power_cycle', attempt: 1, status: 'failed' }),
      event({ id: 'b', stepName: 'power_cycle', attempt: 2 }),
    ]);
    expect(notes).toEqual(['The bridge retried power_cycle 2 times.']);
  });

  it('names a retried step by its label when the event carries one', () => {
    const notes = recoveryNotes([
      event({ id: 'a', stepName: 'disable_os_boot', operation: 'Disable OS boot options', attempt: 1 }),
    ]);
    expect(notes).toEqual(['The bridge retried Disable OS boot options 1 time.']);
  });

  it('names hub-stamped failures and the ipxe give-up', () => {
    const notes = recoveryNotes([
      event({
        id: 'a',
        stepName: 'power_watchdog',
        eventType: 'power_watchdog',
        status: 'failed',
        origin: 'hub',
        error: 'power saga deadline exceeded',
      }),
      event({
        id: 'b',
        stepName: 'ipxe_chainload',
        eventType: 'job_failed',
        status: 'failed',
        error: 'gave up after 5 attempts',
      }),
    ]);
    expect(notes).toEqual([
      'The hub power watchdog failed the job: power saga deadline exceeded.',
      'iPXE gave up chainloading: gave up after 5 attempts.',
    ]);
  });
});

describe('JobStepsPane', () => {
  it('does not query and shows the access message without the history gate', () => {
    gate.canView = false;
    renderWithDiagnostics(<JobStepsPane jobId="job-1" inFlight={false} />, api());
    expect(screen.getByText('You do not have access to job events.')).toBeInTheDocument();
    expect(jobEvents).not.toHaveBeenCalled();
  });

  it('shows the recorded-sagas note when a job has no step events', async () => {
    jobEvents.mockResolvedValue(page([]));
    renderWithDiagnostics(<JobStepsPane jobId="job-1" inFlight={false} />, api());
    expect(await screen.findByText(/No step events were recorded for this job\./)).toBeInTheDocument();
    expect(jobEvents).toHaveBeenCalledWith('job-1');
  });

  it('lists recovery notes above the timeline', async () => {
    jobEvents.mockResolvedValue(page([event({ id: 'a', stepName: 'power_cycle', attempt: 2 })]));
    renderWithDiagnostics(<JobStepsPane jobId="job-1" inFlight={false} />, api());
    expect(await screen.findByText('The bridge retried power_cycle 2 times.')).toBeInTheDocument();
  });

  it('tells a forbidden viewer so instead of showing the generic failure', async () => {
    jobEvents.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    renderWithDiagnostics(<JobStepsPane jobId="job-1" inFlight={false} />, api());
    expect(await screen.findByText('You do not have access to job events.')).toBeInTheDocument();
  });

  it('polls an in-flight job at the open job interval', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    jobEvents.mockResolvedValue(page([]));
    renderWithDiagnostics(<JobStepsPane jobId="job-1" inFlight />, api());
    await screen.findByText(/No step events were recorded for this job\./);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OPEN_JOB_POLL_MS);
    });
    await waitFor(() => expect(jobEvents).toHaveBeenCalledTimes(2));
  });
});
