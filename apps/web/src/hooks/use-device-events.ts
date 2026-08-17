import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { useCallback, useEffect, useRef } from 'react';

interface DeviceMetadataEvent {
  type: string;
  deviceId: string;
  deploymentId: string | null;
  status: string | null;
  powerStatus: string | null;
}

function useDeviceEventStream(onEvent: (data: DeviceMetadataEvent) => void) {
  const eventSourceRef = useRef<EventSource | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    const eventSource = new EventSource('/api/events/devices');
    eventSourceRef.current = eventSource;

    eventSource.onmessage = (event: MessageEvent) => {
      try {
        const data: DeviceMetadataEvent = JSON.parse(event.data);
        onEventRef.current(data);
      } catch (error) {
        console.warn('Device event handling failed', error);
      }
    };

    return () => {
      eventSource.close();
      eventSourceRef.current = null;
    };
  }, []);
}

export function useDeploymentEvents(deploymentId: string | undefined) {
  const queryClient = useQueryClient();
  const router = useRouter();

  useDeviceEventStream(
    useCallback(
      (data) => {
        if (!deploymentId || String(data.deploymentId) !== deploymentId) return;
        queryClient.invalidateQueries({ queryKey: ['deployment', deploymentId] });
        queryClient.invalidateQueries({ queryKey: ['deployment-projects'] });
        router.invalidate();
      },
      [deploymentId, queryClient, router],
    ),
  );
}

export function useDeploymentListEvents() {
  const queryClient = useQueryClient();
  const router = useRouter();

  useDeviceEventStream(
    useCallback(() => {
      queryClient.invalidateQueries({ queryKey: ['deployment-projects'] });
      router.invalidate();
    }, [queryClient, router]),
  );
}

export function useDcimDeviceEvents(deviceId: string | undefined) {
  const queryClient = useQueryClient();
  const router = useRouter();

  useDeviceEventStream(
    useCallback(
      (data) => {
        if (!deviceId || data.deviceId !== deviceId) return;
        queryClient.invalidateQueries({ queryKey: ['server', deviceId] });
        router.invalidate();
      },
      [deviceId, queryClient, router],
    ),
  );
}

export function useDcimDeviceListEvents() {
  const queryClient = useQueryClient();

  useDeviceEventStream(
    useCallback(() => {
      queryClient.invalidateQueries({ queryKey: ['servers-active'] });
      queryClient.invalidateQueries({ queryKey: ['servers-decommissioned'] });
    }, [queryClient]),
  );
}
