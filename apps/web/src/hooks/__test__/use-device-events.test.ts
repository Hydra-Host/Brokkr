import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDcimDeviceEvents, useDeploymentEvents } from '../use-device-events';

const routerInvalidate = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ invalidate: routerInvalidate }),
}));

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  close = vi.fn();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  emit(frame: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) }));
  }
}

function renderWithClient<T>(hook: () => T) {
  const queryClient = new QueryClient();
  const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  const rendered = renderHook(hook, { wrapper });
  const source = FakeEventSource.instances.at(-1);
  if (!source) throw new Error('hook did not open an EventSource');
  return { ...rendered, invalidateQueries, source };
}

type InvalidateSpy = ReturnType<typeof renderWithClient>['invalidateQueries'];

function invalidatedKeys(spy: InvalidateSpy) {
  return spy.mock.calls.map(([filters]) => filters?.queryKey);
}

function jobFrame(jobId: string, deviceId = 'dev-1') {
  return { type: 'job.event.recorded', deviceId, deploymentId: 'dep-1', jobId, phase: 'provision' };
}

const metadataFrame = {
  type: 'device.metadata.updated',
  deviceId: 'dev-1',
  deploymentId: 'dep-1',
  status: 'provisioning',
  powerStatus: 'on',
};

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('useDcimDeviceEvents', () => {
  it('opens the device event stream', () => {
    const { source } = renderWithClient(() => useDcimDeviceEvents('dev-1'));

    expect(source.url).toBe('/api/events/devices');
  });

  it('collapses job frames for one job into a single trailing invalidation per key', () => {
    const { invalidateQueries, source } = renderWithClient(() => useDcimDeviceEvents('dev-1'));

    source.emit(jobFrame('job-1'));
    act(() => vi.advanceTimersByTime(100));
    source.emit(jobFrame('job-1'));
    act(() => vi.advanceTimersByTime(100));
    source.emit(jobFrame('job-1'));

    act(() => vi.advanceTimersByTime(499));
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

  it('keeps a separate timer per job id', () => {
    const { invalidateQueries, source } = renderWithClient(() => useDcimDeviceEvents('dev-1'));

    source.emit(jobFrame('job-1'));
    source.emit(jobFrame('job-2'));
    source.emit(jobFrame('job-1'));

    act(() => vi.advanceTimersByTime(500));
    const keys = invalidatedKeys(invalidateQueries);
    expect(keys).toHaveLength(12);
    expect(keys).toContainEqual(['job-logs', 'job-1']);
    expect(keys).toContainEqual(['job-logs', 'job-2']);
    expect(keys.filter((key) => key?.[0] === 'device-jobs')).toHaveLength(2);
  });

  it('invalidates metadata frames immediately', () => {
    const { invalidateQueries, source } = renderWithClient(() => useDcimDeviceEvents('dev-1'));

    source.emit(metadataFrame);

    expect(invalidatedKeys(invalidateQueries)).toEqual([['server', 'dev-1']]);
    expect(routerInvalidate).toHaveBeenCalledTimes(1);
  });

  it('ignores frames for another device', () => {
    const { invalidateQueries, source } = renderWithClient(() => useDcimDeviceEvents('dev-1'));

    source.emit(jobFrame('job-1', 'dev-2'));
    act(() => vi.advanceTimersByTime(500));

    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it('drops pending job invalidations and closes the stream on unmount', () => {
    const { invalidateQueries, source, unmount } = renderWithClient(() => useDcimDeviceEvents('dev-1'));

    source.emit(jobFrame('job-1'));
    unmount();
    act(() => vi.advanceTimersByTime(500));

    expect(invalidateQueries).not.toHaveBeenCalled();
    expect(source.close).toHaveBeenCalledTimes(1);
  });
});

describe('useDeploymentEvents', () => {
  it('collapses job frames and refreshes the job log for the deployment', () => {
    const { invalidateQueries, source } = renderWithClient(() => useDeploymentEvents('dep-1'));

    source.emit(jobFrame('job-1'));
    source.emit(jobFrame('job-1'));
    source.emit(jobFrame('job-1'));

    act(() => vi.advanceTimersByTime(500));
    expect(invalidatedKeys(invalidateQueries)).toEqual([
      ['lifecycle-jobs'],
      ['job-events', 'job-1'],
      ['job-logs', 'job-1'],
      ['sol-logs', 'job-1'],
      ['device-jobs', 'dev-1'],
      ['deployment-sol-log', 'dep-1'],
    ]);
  });

  it('ignores job frames for another deployment', () => {
    const { invalidateQueries, source } = renderWithClient(() => useDeploymentEvents('dep-2'));

    source.emit(jobFrame('job-1'));
    act(() => vi.advanceTimersByTime(500));

    expect(invalidateQueries).not.toHaveBeenCalled();
  });
});
