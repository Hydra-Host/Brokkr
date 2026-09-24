import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeEventSource } from '../../test/fake-event-source';
import { DEVICE_EVENTS_URL, useDeviceEventStream } from '../use-device-event-stream';

const healthFrame = {
  type: 'device.health.recorded',
  deviceId: 'dev-1',
  healthCheckId: 'hc-1',
  testedAt: '2026-09-17T00:00:00.000Z',
};

beforeEach(() => {
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useDeviceEventStream', () => {
  it('opens the hub device stream by default', () => {
    renderHook(() => useDeviceEventStream(() => {}));

    expect(FakeEventSource.latest().url).toBe(DEVICE_EVENTS_URL);
    expect(FakeEventSource.latest().url).toBe('/api/events/devices');
  });

  it('opens the url it is given', () => {
    renderHook(() => useDeviceEventStream(() => {}, '/api/admin/events/devices'));

    expect(FakeEventSource.latest().url).toBe('/api/admin/events/devices');
  });

  it('delivers a valid frame to the latest handler', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ onEvent }) => useDeviceEventStream(onEvent), {
      initialProps: { onEvent: first },
    });
    rerender({ onEvent: second });

    FakeEventSource.latest().emit(healthFrame);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(healthFrame);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('drops a frame the schema rejects', () => {
    const onEvent = vi.fn();
    renderHook(() => useDeviceEventStream(onEvent));

    FakeEventSource.latest().emit({ type: 'device.health.recorded', deviceId: 'dev-1' });

    expect(onEvent).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith('Device event frame rejected', expect.anything());
  });

  it('drops a message that is not json', () => {
    const onEvent = vi.fn();
    renderHook(() => useDeviceEventStream(onEvent));

    FakeEventSource.latest().emitRaw('not json');

    expect(onEvent).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith('Device event handling failed', expect.anything());
  });

  it('closes the stream on unmount', () => {
    const { unmount } = renderHook(() => useDeviceEventStream(() => {}));
    const source = FakeEventSource.latest();

    unmount();

    expect(source.closeCount).toBe(1);
  });
});
