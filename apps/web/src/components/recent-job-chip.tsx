import { Badge } from '@repo/ui/components/badge';
import { Link } from '@tanstack/react-router';
import { useCanViewJobHistory } from '~/hooks/use-can-view-job-history';
import { usePermissions } from '~/hooks/use-permissions';

export interface RecentJob {
  jobId: string;
  label: string;
  startedAt: number;
}

export function RecentJobChip({ deviceId, job }: { deviceId: string; job: RecentJob }) {
  const { canView: canViewJobs } = useCanViewJobHistory();
  const { can } = usePermissions();
  const text = `${job.label} ${job.jobId.slice(0, 8)} started ${new Date(job.startedAt).toLocaleTimeString()}`;

  if (canViewJobs || can('job-log', 'access')) {
    return (
      <Badge variant="outline">
        <Link to="/dcim/servers/$deviceId/jobs" params={{ deviceId }} search={{ job: job.jobId }}>
          {text}. Open job
        </Link>
      </Badge>
    );
  }
  return <Badge variant="outline">{text}</Badge>;
}
