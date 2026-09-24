import { Skeleton } from '@repo/ui/components/skeleton';
import { isNotFoundError } from '../hooks/api-errors';
import { useSolLogTail } from '../hooks/use-sol-log-tail';
import { NO_JOB_LOG_ACCESS_MESSAGE } from './job-log-viewer';
import { LogStreamView } from './log-stream-view';

export const SOL_LOG_ARIA_LABEL = 'Serial console output';
export const NO_SOL_LOG_MESSAGE =
  'No serial console output is stored for this job. The bridge keeps console output for 24 hours after capture.';

interface SolLogViewerProps {
  deviceId: string;
  jobId: string;
  inFlight: boolean;
  /** Fill the parent's height and scroll the log inside it instead of capping it at 32rem. */
  fill?: boolean;
}

// no permission pre-gate: JobDetail gates the Logs section once; consumers remount on jobId
export function SolLogViewer({ deviceId, jobId, inFlight, fill = false }: SolLogViewerProps) {
  const tail = useSolLogTail(deviceId, jobId, inFlight);

  if (tail.isForbidden) {
    return <p className="text-muted-foreground text-sm">{NO_JOB_LOG_ACCESS_MESSAGE}</p>;
  }
  if (tail.isError) {
    return (
      <p className="text-muted-foreground text-sm">
        {isNotFoundError(tail.error) ? NO_SOL_LOG_MESSAGE : 'Failed to load serial console output.'}
      </p>
    );
  }
  if (tail.isPending) {
    return <Skeleton className="h-40 w-full" />;
  }

  return (
    <LogStreamView
      tail={tail}
      ariaLabel={SOL_LOG_ARIA_LABEL}
      emptyMessage={NO_SOL_LOG_MESSAGE}
      waitingMessage="Waiting for console output."
      showLevelFilter={false}
      fill={fill}
    />
  );
}
