import type { QueueCleanableState } from '@/contract';
import { tsr } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { useToast } from '@/lib/toast';

import type { QueueAddress } from './queue-health';

export type RetryableJobState = 'failed' | 'completed';

export interface QueueJobTarget {
  queue: QueueAddress;
  jobId: string;
}

export interface CleanQueueBody {
  state: QueueCleanableState;
  grace: number;
  limit: number;
}

// ts-rest splices path params raw, so the encode idiom from the job list/detail reads applies here too
const queueParams = (queue: QueueAddress) => ({
  prefix: encodeURIComponent(queue.prefix),
  name: encodeURIComponent(queue.name),
});

const jobParams = (target: QueueJobTarget) => ({
  ...queueParams(target.queue),
  jobId: encodeURIComponent(target.jobId),
});

export function useQueueMutations(onChanged: () => void) {
  const toast = useToast();
  const retry = tsr.retryQueueJob.useMutation();
  const remove = tsr.removeQueueJob.useMutation();
  const drain = tsr.drainQueue.useMutation();
  const clean = tsr.cleanQueue.useMutation();

  const retryJob = (target: QueueJobTarget, state: RetryableJobState = 'failed', after?: () => void) => {
    retry.mutate(
      { params: jobParams(target), body: { state } },
      {
        onSuccess: () => {
          toast.ok('retried job');
          onChanged();
          after?.();
        },
        onError: (e) => toast.error(`retry — ${errorMessage(e) ?? 'request failed'}`),
      },
    );
  };

  const removeJob = (target: QueueJobTarget, after?: () => void) => {
    remove.mutate(
      { params: jobParams(target) },
      {
        onSuccess: () => {
          toast.ok('removed job');
          onChanged();
          after?.();
        },
        onError: (e) => toast.error(`remove — ${errorMessage(e) ?? 'request failed'}`),
      },
    );
  };

  const drainQueue = (queue: QueueAddress, delayed: boolean, after?: () => void) => {
    drain.mutate(
      { params: queueParams(queue), body: { delayed } },
      {
        onSuccess: () => {
          toast.ok('drained queue');
          onChanged();
          after?.();
        },
        onError: (e) => toast.error(`drain — ${errorMessage(e) ?? 'request failed'}`),
      },
    );
  };

  const cleanQueue = (queue: QueueAddress, body: CleanQueueBody, after?: () => void) => {
    clean.mutate(
      { params: queueParams(queue), body },
      {
        onSuccess: () => {
          toast.ok(`cleaned ${body.state} jobs`);
          onChanged();
          after?.();
        },
        onError: (e) => toast.error(`clean — ${errorMessage(e) ?? 'request failed'}`),
      },
    );
  };

  return {
    retryJob,
    removeJob,
    drainQueue,
    cleanQueue,
    retryBusy: retry.isPending,
    removeBusy: remove.isPending,
    drainBusy: drain.isPending,
    cleanBusy: clean.isPending,
  };
}
