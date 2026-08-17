import type { DeliveryStatus, DeviceTokenStatus, LifecycleJobPhase } from '@/contract';
import { errText } from '@/features/datastore/shared/error-banner';
import { tsr } from '@/lib/api';

// slower than the queue inspector's 2s: these are database reads, and none of them changes
// faster than a lifecycle phase transition or a webhook retry backoff
const POLL_MS = 5000;
const PAGE = 50;

export function useWebhookDeliveries(status: DeliveryStatus | undefined, webhookId: string | undefined) {
  const q = tsr.listWebhookDeliveries.useQuery({
    queryKey: ['hub-webhook-deliveries', status ?? null, webhookId ?? null],
    queryData: { query: { status, webhookId, limit: PAGE, offset: 0 } },
    refetchInterval: POLL_MS,
  });
  return { page: q.data?.status === 200 ? q.data.body : null, error: errText(q.data, q.error), isPending: q.isPending };
}

export function useLifecycleJobs(phases: readonly LifecycleJobPhase[], deviceId: string | undefined) {
  const csv = phases.join(',');
  const q = tsr.listLifecycleJobs.useQuery({
    queryKey: ['hub-lifecycle-jobs', csv, deviceId ?? null],
    queryData: { query: { phases: csv || undefined, deviceId, limit: PAGE, offset: 0 } },
    refetchInterval: POLL_MS,
  });
  return { page: q.data?.status === 200 ? q.data.body : null, error: errText(q.data, q.error), isPending: q.isPending };
}

export function useLifecycleJob(jobId: string | undefined) {
  const q = tsr.getLifecycleJob.useQuery({
    queryKey: ['hub-lifecycle-job', jobId ?? null],
    queryData: { params: { jobId: jobId ?? '' } },
    enabled: !!jobId,
    refetchInterval: POLL_MS,
  });
  return {
    detail: q.data?.status === 200 ? q.data.body : null,
    error: errText(q.data, q.error),
    isPending: q.isPending,
  };
}

// slower than the rest: a queue job moves on saga-step timescales, and each poll costs one key scan
// per saga queue rather than a single indexed read
const QUEUE_JOIN_POLL_MS = 15_000;

export function useLifecycleQueueJobs(jobId: string | undefined) {
  const q = tsr.getLifecycleJobQueueJobs.useQuery({
    queryKey: ['hub-lifecycle-queue-jobs', jobId ?? null],
    queryData: { params: { jobId: jobId ?? '' } },
    enabled: !!jobId,
    refetchInterval: QUEUE_JOIN_POLL_MS,
  });
  return { join: q.data?.status === 200 ? q.data.body : null, error: errText(q.data, q.error), isPending: q.isPending };
}

export function useDeviceTokens(deviceId: string | undefined, status: DeviceTokenStatus | undefined) {
  const q = tsr.listDeviceTokens.useQuery({
    queryKey: ['hub-device-tokens', deviceId ?? null, status ?? null],
    queryData: { query: { deviceId, status, limit: PAGE, offset: 0 } },
    refetchInterval: POLL_MS,
  });
  return { page: q.data?.status === 200 ? q.data.body : null, error: errText(q.data, q.error), isPending: q.isPending };
}

export function useDeviceTokenEvents(tokenId: string | undefined) {
  const q = tsr.getDeviceTokenEvents.useQuery({
    queryKey: ['hub-device-token-events', tokenId ?? null],
    queryData: { params: { tokenId: tokenId ?? '' }, query: { limit: PAGE, offset: 0 } },
    enabled: !!tokenId,
    refetchInterval: POLL_MS,
  });
  return { page: q.data?.status === 200 ? q.data.body : null, error: errText(q.data, q.error), isPending: q.isPending };
}
