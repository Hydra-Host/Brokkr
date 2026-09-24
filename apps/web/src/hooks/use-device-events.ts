import { useDeviceEventInvalidation } from '@repo/domain-ui/hooks/use-device-event-invalidation';
import { useDeviceEventStream } from '@repo/domain-ui/hooks/use-device-event-stream';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { useCallback } from 'react';

export function useDeploymentEvents(deploymentId: string) {
  const queryClient = useQueryClient();
  const router = useRouter();

  useDeviceEventInvalidation({
    deploymentId,
    onMetadata: useCallback(() => {
      queryClient.invalidateQueries({ queryKey: ['deployment', deploymentId] });
      queryClient.invalidateQueries({ queryKey: ['deployment-projects'] });
      router.invalidate();
    }, [deploymentId, queryClient, router]),
  });
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

export function useDcimDeviceEvents(deviceId: string) {
  const queryClient = useQueryClient();
  const router = useRouter();

  useDeviceEventInvalidation({
    deviceId,
    onMetadata: useCallback(() => {
      queryClient.invalidateQueries({ queryKey: ['server', deviceId] });
      router.invalidate();
    }, [deviceId, queryClient, router]),
  });
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
