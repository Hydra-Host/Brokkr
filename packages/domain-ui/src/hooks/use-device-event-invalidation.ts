import {
  DEVICE_HEALTH_RECORDED,
  DEVICE_METADATA_UPDATED,
  JOB_EVENT_RECORDED,
  type DeviceEventFrame,
} from '@repo/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';
import { useDeviceEventStream } from './use-device-event-stream';
import { diagnosticsKeys } from './use-diagnostics-api';

// a fast provision records dozens of step events per second; one trailing refetch per job absorbs them
export const JOB_INVALIDATION_DEBOUNCE_MS = 500;

export type DeviceMetadataUpdatedFrame = Extract<DeviceEventFrame, { type: typeof DEVICE_METADATA_UPDATED }>;

export interface DeviceEventInvalidationOptions {
  deviceId?: string;
  deploymentId?: string;
  onMetadata?: (frame: DeviceMetadataUpdatedFrame) => void;
}

const [LIFECYCLE_JOBS_KEY] = diagnosticsKeys.jobs({}, undefined);

// a frame kind without a case above lands here as never, so a new union member fails to compile
function unhandledEvent(frame: never): void {
  console.warn('Unhandled device event', frame);
}

function inScope(frame: DeviceEventFrame, { deviceId, deploymentId }: DeviceEventInvalidationOptions): boolean {
  if (deviceId !== undefined && frame.deviceId !== deviceId) return false;
  if (deploymentId === undefined) return true;
  return 'deploymentId' in frame && frame.deploymentId === deploymentId;
}

function useDebouncedByKey(delayMs: number) {
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  return useCallback(
    (key: string, run: () => void) => {
      const timers = timersRef.current;
      const pending = timers.get(key);
      if (pending !== undefined) clearTimeout(pending);
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          run();
        }, delayMs),
      );
    },
    [delayMs],
  );
}

export function useDeviceEventInvalidation({
  deviceId,
  deploymentId,
  onMetadata,
}: DeviceEventInvalidationOptions): void {
  const queryClient = useQueryClient();
  const debounceByJob = useDebouncedByKey(JOB_INVALIDATION_DEBOUNCE_MS);

  useDeviceEventStream(
    useCallback(
      (frame) => {
        if (!inScope(frame, { deviceId, deploymentId })) return;
        switch (frame.type) {
          case JOB_EVENT_RECORDED: {
            const { jobId, deviceId: jobDeviceId, deploymentId: jobDeploymentId } = frame;
            debounceByJob(jobId, () => {
              queryClient.invalidateQueries({ queryKey: [LIFECYCLE_JOBS_KEY] });
              queryClient.invalidateQueries({ queryKey: diagnosticsKeys.jobEvents(jobId) });
              queryClient.invalidateQueries({ queryKey: diagnosticsKeys.jobLogs(jobId) });
              queryClient.invalidateQueries({ queryKey: diagnosticsKeys.solLogs(jobId) });
              queryClient.invalidateQueries({ queryKey: diagnosticsKeys.deviceJobs(jobDeviceId) });
              if (jobDeploymentId !== null) {
                queryClient.invalidateQueries({ queryKey: diagnosticsKeys.deploymentSolLog(jobDeploymentId) });
              }
            });
            return;
          }
          case DEVICE_HEALTH_RECORDED: {
            const [healthChecksKey, healthChecksDeviceId] = diagnosticsKeys.healthChecks(frame.deviceId, undefined);
            queryClient.invalidateQueries({ queryKey: diagnosticsKeys.health(frame.deviceId) });
            queryClient.invalidateQueries({ queryKey: [healthChecksKey, healthChecksDeviceId] });
            return;
          }
          case DEVICE_METADATA_UPDATED:
            onMetadata?.(frame);
            return;
          default:
            unhandledEvent(frame);
        }
      },
      [debounceByJob, deploymentId, deviceId, onMetadata, queryClient],
    ),
  );
}
