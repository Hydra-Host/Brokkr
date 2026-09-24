import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeEventSource } from '../../test/fake-event-source';
import {
  JOB_INVALIDATION_DEBOUNCE_MS,
  useDeviceEventInvalidation,
  type DeviceEventInvalidationOptions,
} from '../use-device-event-invalidation';

function renderInvalidation(options: DeviceEventInvalidationOptions) {
  const queryClient = new QueryClient();
  const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const rendered = renderHook(() => useDeviceEventInvalidation(options), { wrapper });
  return { ...rendered, invalidateQueries, source: FakeEventSource.latest() };
}

type InvalidateSpy = ReturnType<typeof renderInvalidation>['invalidateQueries'];

function invalidatedKeys(spy: InvalidateSpy) {
  return spy.mock.calls.map(([filters]) => filters?.queryKey);
}

function jobFrame(
  jobId: string,
  { deviceId = 'dev-1', deploymentId = 'dep-1' }: { deviceId?: string; deploymentId?: string | null } = {},
) {
  return { type: 'job.event.recorded', deviceId, deploymentId, jobId, phase: 'RUNNING' };
}

function healthFrame(deviceId = 'dev-1') {
  return { type: 'device.health.recorded', deviceId, healthCheckId: 'hc-1', testedAt: '2026-09-17T00:00:00.000Z' };
}

function metadataFrame(deviceId = 'dev-1', deploymentId: string | null = 'dep-1') {
  return { type: 'device.metadata.updated', deviceId, deploymentId, status: 'provisioning', powerStatus: 'on' };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('useDeviceEventInvalidation', () => {
  it('collapses job frames for one job into a single trailing invalidation per key', () => {
    const { invalidateQueries, source } = renderInvalidation({ deviceId: 'dev-1' });

    source.emit(jobFrame('job-1'));
    act(() => vi.advanceTimersByTime(100));
    source.emit(jobFrame('job-1'));
    act(() => vi.advanceTimersByTime(100));
    source.emit(jobFrame('job-1'));

    act(() => vi.advanceTimersByTime(JOB_INVALIDATION_DEBOUNCE_MS - 1));
    expect(invalidateQueries).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(invalidatedKeys(invalidateQueries)).toEqual([
      ['lifecycle-jobs'],
      ['job-events', 'job-1'],
      ['job-logs', 'job-1'],
      ['sol-logs', 'job-1'],
      ['device-jobs', 'dev-1'],
      ['deployment-sol-log', 'dep-1'],
    ]);
  });

  it('skips the deployment sol log for a device-only job', () => {
    const { invalidateQueries, source } = renderInvalidation({ deviceId: 'dev-1' });

    source.emit(jobFrame('job-1', { deploymentId: null }));
    act(() => vi.advanceTimersByTime(JOB_INVALIDATION_DEBOUNCE_MS));

    const keys = invalidatedKeys(invalidateQueries);
    expect(keys).toHaveLength(5);
    expect(keys.filter((key) => key?.[0] === 'deployment-sol-log')).toHaveLength(0);
  });

  it('keeps a separate timer per job id', () => {
    const { invalidateQueries, source } = renderInvalidation({ deviceId: 'dev-1' });

    source.emit(jobFrame('job-1'));
    source.emit(jobFrame('job-2'));
    source.emit(jobFrame('job-1'));

    act(() => vi.advanceTimersByTime(JOB_INVALIDATION_DEBOUNCE_MS));
    const keys = invalidatedKeys(invalidateQueries);
    expect(keys).toHaveLength(12);
    expect(keys).toContainEqual(['sol-logs', 'job-1']);
    expect(keys).toContainEqual(['sol-logs', 'job-2']);
  });

  it('refreshes the health summary and every health-checks page immediately', () => {
    const { invalidateQueries, source } = renderInvalidation({ deviceId: 'dev-1' });

    source.emit(healthFrame());

    expect(invalidatedKeys(invalidateQueries)).toEqual([
      ['device-health', 'dev-1'],
      ['device-health-checks', 'dev-1'],
    ]);
  });

  it('hands metadata frames to the caller without invalidating anything itself', () => {
    const onMetadata = vi.fn();
    const { invalidateQueries, source } = renderInvalidation({ deviceId: 'dev-1', onMetadata });

    source.emit(metadataFrame());

    expect(invalidateQueries).not.toHaveBeenCalled();
    expect(onMetadata).toHaveBeenCalledWith(metadataFrame());
  });

  it('ignores frames for another device', () => {
    const onMetadata = vi.fn();
    const { invalidateQueries, source } = renderInvalidation({ deviceId: 'dev-1', onMetadata });

    source.emit(jobFrame('job-1', { deviceId: 'dev-2' }));
    source.emit(healthFrame('dev-2'));
    source.emit(metadataFrame('dev-2'));
    act(() => vi.advanceTimersByTime(JOB_INVALIDATION_DEBOUNCE_MS));

    expect(invalidateQueries).not.toHaveBeenCalled();
    expect(onMetadata).not.toHaveBeenCalled();
  });

  it('scopes to a deployment and leaves health frames out of that scope', () => {
    const onMetadata = vi.fn();
    const { invalidateQueries, source } = renderInvalidation({ deploymentId: 'dep-1', onMetadata });

    source.emit(jobFrame('job-1', { deploymentId: 'dep-2' }));
    source.emit(metadataFrame('dev-1', 'dep-2'));
    source.emit(healthFrame());
    act(() => vi.advanceTimersByTime(JOB_INVALIDATION_DEBOUNCE_MS));
    expect(invalidateQueries).not.toHaveBeenCalled();
    expect(onMetadata).not.toHaveBeenCalled();

    source.emit(jobFrame('job-1'));
    source.emit(metadataFrame());
    act(() => vi.advanceTimersByTime(JOB_INVALIDATION_DEBOUNCE_MS));
    expect(invalidatedKeys(invalidateQueries)).toContainEqual(['deployment-sol-log', 'dep-1']);
    expect(onMetadata).toHaveBeenCalledTimes(1);
  });

  it('follows every device when no scope is given', () => {
    const { invalidateQueries, source } = renderInvalidation({});

    source.emit(healthFrame('dev-1'));
    source.emit(healthFrame('dev-2'));

    expect(invalidatedKeys(invalidateQueries)).toEqual([
      ['device-health', 'dev-1'],
      ['device-health-checks', 'dev-1'],
      ['device-health', 'dev-2'],
      ['device-health-checks', 'dev-2'],
    ]);
  });

  it('drops pending job invalidations and closes the stream on unmount', () => {
    const { invalidateQueries, source, unmount } = renderInvalidation({ deviceId: 'dev-1' });

    source.emit(jobFrame('job-1'));
    unmount();
    act(() => vi.advanceTimersByTime(JOB_INVALIDATION_DEBOUNCE_MS));

    expect(invalidateQueries).not.toHaveBeenCalled();
    expect(source.closeCount).toBe(1);
  });
});
