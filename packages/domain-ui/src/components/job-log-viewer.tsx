import { Skeleton } from '@repo/ui/components/skeleton';
import { isNotFoundError } from '../hooks/api-errors';
import { useDiagnosticsApi } from '../hooks/use-diagnostics-api';
import { useJobLogTail } from '../hooks/use-job-log-tail';
import { LogStreamView } from './log-stream-view';

export const NO_JOB_LOG_ACCESS_MESSAGE = 'You do not have access to job logs.';
const NO_STREAM_MESSAGE = 'No log stream is retained for this job.';

interface JobLogViewerProps {
  jobId: string;
  inFlight: boolean;
  /** Fill the parent's height and scroll the log inside it instead of capping it at 32rem. */
  fill?: boolean;
}

export function JobLogViewer({ jobId, inFlight, fill = false }: JobLogViewerProps) {
  const { gates } = useDiagnosticsApi();
  if (gates.isLoading) return <Skeleton className="h-40 w-full" />;
  if (!gates.can('job-logs.access')) {
    return <p className="text-muted-foreground text-sm">{NO_JOB_LOG_ACCESS_MESSAGE}</p>;
  }
  return <JobLogStream jobId={jobId} inFlight={inFlight} fill={fill} />;
}

function JobLogStream({ jobId, inFlight, fill = false }: JobLogViewerProps) {
  const tail = useJobLogTail(jobId, inFlight);

  if (tail.isForbidden) {
    return <p className="text-muted-foreground text-sm">{NO_JOB_LOG_ACCESS_MESSAGE}</p>;
  }
  if (tail.isError) {
    return (
      <p className="text-muted-foreground text-sm">
        {isNotFoundError(tail.error) ? NO_STREAM_MESSAGE : 'Failed to load job logs.'}
      </p>
    );
  }
  if (tail.isPending) {
    return <Skeleton className="h-40 w-full" />;
  }

  return (
    <LogStreamView
      tail={tail}
      ariaLabel="Job log output"
      emptyMessage={NO_STREAM_MESSAGE}
      waitingMessage="Waiting for log output."
      fill={fill}
    />
  );
}
