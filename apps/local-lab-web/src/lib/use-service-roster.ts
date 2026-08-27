import { tsr } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { usePoll } from '@/lib/use-poll';
import type { Svc } from '@/lib/use-stack-config-form';

export function useServiceRoster() {
  const services = tsr.listServices.useQuery({ queryKey: ['services'], refetchInterval: usePoll(4000) });

  const roster = services.data?.status === 200 ? services.data.body : [];
  const svcState = (group: Svc) => roster.find((s) => s.group === group);
  const kindStats = (kind: Svc) => {
    const items = roster.filter((s) => s.group === kind);
    return {
      total: items.length,
      ready: items.filter((i) => i.ready).length,
      running: items.filter((i) => i.running).length,
    };
  };

  return { svcState, kindStats, error: errorMessage(services.error), refetch: services.refetch };
}
