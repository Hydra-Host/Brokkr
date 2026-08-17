import { AsyncLocalStorage } from 'node:async_hooks';

export interface DispatchContext {
  signal: AbortSignal;
  job_id?: string | undefined;
  work_id?: string | undefined;
  operation?: string | undefined;
}

export const dispatchContext = new AsyncLocalStorage<DispatchContext>();
