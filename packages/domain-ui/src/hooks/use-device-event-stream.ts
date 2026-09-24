import { DeviceEventFrameSchema, type DeviceEventFrame } from '@repo/api-client';
import { useEffect, useRef } from 'react';

export const DEVICE_EVENTS_URL = '/api/events/devices';

export function useDeviceEventStream(onEvent: (frame: DeviceEventFrame) => void, url = DEVICE_EVENTS_URL): void {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    const eventSource = new EventSource(url);

    eventSource.onmessage = (event: MessageEvent) => {
      try {
        const frame = DeviceEventFrameSchema.safeParse(JSON.parse(event.data));
        if (!frame.success) {
          console.warn('Device event frame rejected', frame.error);
          return;
        }
        onEventRef.current(frame.data);
      } catch (error) {
        console.warn('Device event handling failed', error);
      }
    };

    return () => eventSource.close();
  }, [url]);
}
