import type { BootTrail } from '@/contract';
import { tsr } from '@/lib/api';
import { usePoll } from '@/lib/use-poll';

const clock = (ms: number) => new Date(ms).toLocaleTimeString();

export function bootTrailLine(trail: BootTrail): string {
  if (trail.readError !== null) return `boot trail unreadable: ${trail.readError}`;
  if (trail.pxe === null) return 'no PXE request seen yet';
  const pxe = `PXE ${trail.pxe.outcome} at ${clock(trail.pxe.atMs)}`;
  if (trail.chainReached !== true) return `${pxe}; iPXE chain not reached yet`;
  return trail.chainAtMs === null
    ? `${pxe}; iPXE chain reached`
    : `${pxe}; iPXE chain reached at ${clock(trail.chainAtMs)}`;
}

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
