import type { ZoneRuntime } from '@/contract';
import { errText } from '@/features/datastore/shared/error-banner';
import { tsr } from '@/lib/api';
import { usePoll } from '@/lib/use-poll';

// under the bridges' 10s leader renew and the 25s presence freshness window, so a failover shows up
// while it is still in flight rather than after the fact.
const POLL_MS = 5000;

export interface ZoneRuntimeQuery {
  zones: ZoneRuntime[] | null;
  error: string | null;
  isPending: boolean;
}

export function useZoneRuntime(): ZoneRuntimeQuery {
  const q = tsr.listZoneRuntimes.useQuery({ queryKey: ['zone-runtime'], refetchInterval: usePoll(POLL_MS) });
  return {
    zones: q.data?.status === 200 ? q.data.body : null,
    error: errText(q.data, q.error),
    isPending: q.isPending,
  };
}
