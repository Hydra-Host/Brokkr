import type { DeviceJob, LifecycleJobSummary } from '@repo/api-client';
import { ClickToCopyString } from '@repo/ui/components/click-to-copy-string';
import { JobTypeBadge } from '@repo/ui/components/job-type-badge';
import { Skeleton } from '@repo/ui/components/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@repo/ui/components/tabs';
import { cn } from '@repo/ui/utils';
import type { ReactNode } from 'react';
import { useDiagnosticsApi } from '../hooks/use-diagnostics-api';
import { formatDate, PENDING_PHASES, PhaseBadge } from './job-history-columns';
import { JobLogViewer, NO_JOB_LOG_ACCESS_MESSAGE } from './job-log-viewer';
import { JobStepsPane } from './job-steps-pane';
import { SolLogViewer } from './sol-log-viewer';

export const SERIAL_CONSOLE_UNAVAILABLE_MESSAGE =
  'Serial console output is unavailable because this job is not tied to a device.';

export interface JobRef {
  id: string;
  jobType: string;
  phase: string;
  createdAt: string;
  completedAt: string | null;
  error: string | null;
  inFlight: boolean;
}

// device jobs carry either an engine phase or a legacy Job status; anything unrecognized reads as finished
const OTHER_OPEN_STATUSES = new Set(['REQUESTED', 'AUTHORIZING', 'SCHEDULED', 'DEFERRED', 'Pending', 'InProgress']);

export function jobRefFromSummary(job: LifecycleJobSummary): JobRef {
  return {
    id: job.id,
    jobType: job.jobType,
    phase: job.phase,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    error: job.error,
    inFlight: job.completedAt === null,
  };
}

export function jobRefFromDeviceJob(job: DeviceJob): JobRef {
  return {
    id: job.id,
    jobType: job.jobType,
    phase: job.status,
    createdAt: job.createdAt,
    completedAt: null,
    error: job.error,
    inFlight: PENDING_PHASES.has(job.status) || OTHER_OPEN_STATUSES.has(job.status),
  };
}

interface JobDetailProps {
  jobId: string;
  deviceId: string | null;
  job?: JobRef;
  footer?: ReactNode;
  /** Fill the parent's height and let the steps and logs panes scroll on their own instead of growing the page. */
  fill?: boolean;
  /** Render the log pane beside the steps; false keeps the header and the steps in one column. */
  logs?: boolean;
}

export function JobDetail({ jobId, deviceId, job, footer, fill = false, logs = true }: JobDetailProps) {
  const inFlight = job?.inFlight ?? false;

  return (
    <div className={cn('flex flex-col gap-4', fill && 'h-full min-h-0')}>
      <div className="flex flex-wrap items-center gap-2">
        {job && <JobTypeBadge jobType={job.jobType} />}
        <ClickToCopyString value={jobId} className="font-mono text-xs" />
        {job && <PhaseBadge phase={job.phase} />}
        {job && (
          <span className="text-muted-foreground text-xs">
            Requested {formatDate(job.createdAt)}
            {job.completedAt !== null ? ` · Completed ${formatDate(job.completedAt)}` : ''}
          </span>
        )}
      </div>
      {job?.error && <p className="text-destructive text-sm whitespace-pre-wrap">{job.error}</p>}
      <div className={cn('@container', fill && 'min-h-0 flex-1')}>
        <div
          className={cn(
            'grid gap-6',
            logs && '@3xl:grid-cols-2',
            fill && 'h-full',
            fill && logs && 'grid-rows-2 @3xl:grid-rows-1',
          )}
        >
          <section className={cn('flex min-w-0 flex-col gap-2', fill && 'min-h-0')}>
            <h4 className="text-sm font-medium">Steps</h4>
            <div className={cn(fill && 'min-h-0 flex-1 overflow-y-auto')}>
              <JobStepsPane jobId={jobId} inFlight={inFlight} />
            </div>
          </section>
          {logs && (
            <section className={cn('flex min-w-0 flex-col gap-2', fill && 'min-h-0')}>
              <JobLogsSection jobId={jobId} deviceId={deviceId} inFlight={inFlight} fill={fill} />
            </section>
          )}
        </div>
      </div>
      {footer}
    </div>
  );
}

interface JobLogsSectionProps {
  jobId: string;
  deviceId: string | null;
  inFlight: boolean;
  fill: boolean;
}

// gated once here so the access message renders once for both tabs; JobLogViewer keeps its own gate for its unit tests
function JobLogsSection({ jobId, deviceId, inFlight, fill }: JobLogsSectionProps) {
  const { gates } = useDiagnosticsApi();
  if (gates.isLoading) return <Skeleton className="h-40 w-full" />;
  if (!gates.can('job-logs.access')) {
    return <p className="text-muted-foreground text-sm">{NO_JOB_LOG_ACCESS_MESSAGE}</p>;
  }

  // keepMounted keeps the hidden tail's cursor and rows alive across tab switches
  const panelClassName = cn('mt-2 font-sans', fill && 'min-h-0 flex-1');
  return (
    <Tabs defaultValue="job-log" className={cn(fill && 'flex min-h-0 flex-1 flex-col')}>
      <TabsList>
        <TabsTrigger value="job-log">Job log</TabsTrigger>
        <TabsTrigger value="serial-console">Serial console</TabsTrigger>
      </TabsList>
      <TabsContent value="job-log" keepMounted className={panelClassName}>
        <JobLogViewer jobId={jobId} inFlight={inFlight} fill={fill} />
      </TabsContent>
      <TabsContent value="serial-console" keepMounted className={panelClassName}>
        {deviceId === null ? (
          <p className="text-muted-foreground text-sm">{SERIAL_CONSOLE_UNAVAILABLE_MESSAGE}</p>
        ) : (
          <SolLogViewer deviceId={deviceId} jobId={jobId} inFlight={inFlight} fill={fill} />
        )}
      </TabsContent>
    </Tabs>
  );
}
