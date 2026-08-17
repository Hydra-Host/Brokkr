import { tsr } from '@/lib/api';

// the results and testing pages poll the same rows under the same key, so they share one cache entry
export function useTestRuns() {
  return tsr.listRuns.useQuery({
    queryKey: ['runs', 'test'],
    queryData: { query: { section: 'test', limit: 100 } },
    refetchInterval: 2000,
  });
}
