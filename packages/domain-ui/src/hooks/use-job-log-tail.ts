import { diagnosticsKeys, useDiagnosticsApi } from './use-diagnostics-api';
import { usePagedLogTail, type PagedLogTail } from './use-paged-log-tail';

export type JobLogTail = PagedLogTail;

export function useJobLogTail(jobId: string, inFlight: boolean): JobLogTail {
  const api = useDiagnosticsApi();
  return usePagedLogTail<string | undefined>({
    queryKey: diagnosticsKeys.jobLogs(jobId),
    initialCursor: undefined,
    inFlight,
    fetchPage: async (cursor, limit) => {
      const { entries, nextCursor } = await api.jobLogsPage(jobId, cursor, limit);
      return { entries, nextCursor, tipCursor: entries.at(-1)?.id };
    },
  });
}
