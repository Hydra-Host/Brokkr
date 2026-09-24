import type { JobLogEntry, JobSolLogEntry } from '@repo/api-client';
import { diagnosticsKeys, useDiagnosticsApi } from './use-diagnostics-api';
import { usePagedLogTail, type PagedLogTail } from './use-paged-log-tail';

// the bridge ends a session after 300 s without a console line and flushes within 5 s; the rest covers two polls of hub latency
export const SOL_TAIL_GRACE_MS = 330_000;

export type SolLogTail = PagedLogTail;

// an empty appClassName hides the class column; logLevel only satisfies the row type
export function toSolLogEntry({ index, timestamp, message }: JobSolLogEntry): JobLogEntry {
  return { id: String(index), timestamp, logLevel: 'info', message, appName: 'bridge-api', appClassName: '' };
}

export function useSolLogTail(deviceId: string, jobId: string, inFlight: boolean): SolLogTail {
  const api = useDiagnosticsApi();
  return usePagedLogTail<number>({
    queryKey: diagnosticsKeys.solLogs(jobId),
    initialCursor: 0,
    inFlight,
    graceMs: SOL_TAIL_GRACE_MS,
    fetchPage: async (cursor, limit) => {
      const { entries, nextCursor, complete } = await api.solLogsPage(deviceId, jobId, cursor, limit);
      const last = entries.at(-1);
      return {
        entries: entries.map(toSolLogEntry),
        nextCursor,
        complete,
        tipCursor: last === undefined ? undefined : last.index + 1,
      };
    },
  });
}
