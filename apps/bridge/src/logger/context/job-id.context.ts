import { AsyncLocalStorage } from 'node:async_hooks';

import { NIL_JOB_ID } from './logging-context.constants';

interface JobIdContextStore {
  jobId: string;
}

const storage = new AsyncLocalStorage<JobIdContextStore>();

export function getJobId(): string {
  return storage.getStore()?.jobId ?? '';
}

export function runWithJobId<T>(jobId: string, fn: () => T): T {
  return storage.run({ jobId }, fn);
}

export function setJobIdInCurrentContext(jobId: string): void {
  const store = storage.getStore();
  if (store) {
    store.jobId = jobId;
    return;
  }
  storage.enterWith({ jobId });
}

export function shouldPropagateJobId(jobId: string): boolean {
  return jobId !== '' && jobId !== NIL_JOB_ID;
}
