import type { CcBuild } from '@/contract';
import { tsr } from '@/lib/api';
import { usePoll } from '@/lib/use-poll';

export function useCcBuild(): { ccBuild: CcBuild | null } {
  const host = tsr.getHost.useQuery({ queryKey: ['host'], refetchInterval: usePoll(10_000) });
  return { ccBuild: host.data?.status === 200 ? host.data.body.ccBuild : null };
}
