import { tsr } from '@/lib/api';
import { usePoll } from '@/lib/use-poll';
import { bootTrailLine } from '@repo/utils';

export { bootTrailLine };

// the query key is the machine name alone, so the config page and the fleet card share one poll per machine
export function BootTrailLine({ name }: { name: string }) {
  const q = tsr.getMachineBootTrail.useQuery({
    queryKey: ['fleet-boot-trail', name],
    queryData: { params: { name } },
    refetchInterval: usePoll(30000),
  });
  const trail = q.data?.status === 200 ? q.data.body : null;
  if (trail === null) return null;
  return (
    <div className="text-[11px]">
      <span className="text-text-muted">boot trail </span>
      <span className="text-text-primary">{bootTrailLine(trail)}</span>
    </div>
  );
}
