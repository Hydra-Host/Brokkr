import type { CcBuild } from '@/contract';
import { tsr } from '@/lib/api';

export function useCcBuild(): { ccBuild: CcBuild | null } {
  const host = tsr.getHost.useQuery({ queryKey: ['host'], refetchInterval: 10_000 });
  return { ccBuild: host.data?.status === 200 ? host.data.body.ccBuild : null };
}
