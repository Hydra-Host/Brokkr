import type { ExportLogsJobType } from '@repo/api-client';
import { diagnosticsKeys } from '@repo/domain-ui/hooks/use-diagnostics-api';
import { usePagedLogTail } from '@repo/domain-ui/hooks/use-paged-log-tail';
import { SOL_TAIL_GRACE_MS, toSolLogEntry, type SolLogTail } from '@repo/domain-ui/hooks/use-sol-log-tail';
import { tsr } from '~/lib/api';

// the deployment route has no cursor: each poll re-reads the whole list, bounded by the 24-hour TTL and the inactivity grace
export function useDeploymentSolLog(deploymentId: string, jobType: ExportLogsJobType): SolLogTail {
  return usePagedLogTail<undefined>({
    queryKey: [...diagnosticsKeys.deploymentSolLog(deploymentId), jobType],
    initialCursor: undefined,
    inFlight: false,
    graceMs: SOL_TAIL_GRACE_MS,
    fetchPage: async () => {
      const response = await tsr.getLogs.mutate({ params: { id: deploymentId }, body: { jobType } });
      if (response.status !== 200) throw response;
      return {
        entries: response.body.entries.map((entry, index) => toSolLogEntry({ index, ...entry })),
        nextCursor: null,
        complete: response.body.complete,
      };
    },
  });
}
