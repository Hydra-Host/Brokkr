import type { DeviceJob, LifecycleJobSummary } from '@repo/api-client';
import { JobTypeBadge } from '@repo/ui/components/job-type-badge';
import { Skeleton } from '@repo/ui/components/skeleton';
import { SplitPane } from '@repo/ui/components/split-pane';
import { useFillScrollParent } from '@repo/ui/hooks/use-fill-scroll-parent';
import { cn } from '@repo/ui/utils';
import { useQuery } from '@tanstack/react-query';
import type { Table } from '@tanstack/react-table';
import { useEffect, useRef, type ReactNode } from 'react';
import { isForbiddenError } from '../hooks/api-errors';
import { diagnosticsKeys, useDiagnosticsApi, type DiagnosticsApi } from '../hooks/use-diagnostics-api';
import { useServerTable, type ServerColumnDef } from '../hooks/use-server-table';
import { JobDetail, jobRefFromDeviceJob, jobRefFromSummary, type JobRef } from './job-detail';
import { formatDate, JOB_COLUMNS, NO_LIFECYCLE_JOBS_MESSAGE, useLifecycleJobs } from './job-history-columns';
import { NO_JOB_LOG_ACCESS_MESSAGE } from './job-log-viewer';
import { ServerDataTable } from './server-data-table';

export interface JobsConsoleProps {
  deviceId: string;
  requestedJobId?: string;
  onSelectJob: (jobId: string) => void;
  /** Replaces the default job list columns; extend `JOB_COLUMNS` to add to them. */
  columns?: ServerColumnDef<LifecycleJobSummary>[];
  footer?: (job: JobRef) => ReactNode;
}

type ListDeviceJobs = NonNullable<DiagnosticsApi['listDeviceJobs']>;

const NO_DEVICE_JOBS_MESSAGE = 'No jobs recorded for this device.';
const LIST_COLUMN_IDS = new Set(['jobType', 'phase', 'createdAt']);
const NO_DEVICE_JOBS: DeviceJob[] = [];

const CONSOLE_COLUMNS: ServerColumnDef<LifecycleJobSummary>[] = [
  {
    id: 'id',
    accessorKey: 'id',
    header: 'Job',
    sortField: 'id',
    cell: ({ row }) => <span className="font-mono text-xs">{row.original.id.slice(0, 8)}</span>,
  },
  ...JOB_COLUMNS.filter((column) => column.id !== undefined && LIST_COLUMN_IDS.has(column.id)),
];

function newestJob<T extends { createdAt: string }>(jobs: readonly T[]): T | undefined {
  return jobs.reduce<T | undefined>(
    (newest, candidate) =>
      newest === undefined || Date.parse(candidate.createdAt) > Date.parse(newest.createdAt) ? candidate : newest,
    undefined,
  );
}

export function JobsConsole(props: JobsConsoleProps) {
  const api = useDiagnosticsApi();

  if (api.gates.isLoading) return <Skeleton className="h-64 w-full" />;
  if (api.gates.can('jobs.view')) return <LifecycleJobsConsole {...props} />;
  if (api.listDeviceJobs !== undefined && api.gates.can('job-logs.access')) {
    return <DeviceJobsConsole {...props} listDeviceJobs={api.listDeviceJobs} />;
  }
  return null;
}

interface ConsoleLayoutProps {
  deviceId: string;
  list: ReactNode;
  selectedJobId: string | undefined;
  job: JobRef | undefined;
  listPending: boolean;
  emptyMessage: string;
  footer: JobsConsoleProps['footer'];
}

function ConsoleLayout({ deviceId, list, selectedJobId, job, listPending, emptyMessage, footer }: ConsoleLayoutProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  useFillScrollParent(wrapperRef);

  let detail: ReactNode = null;
  if (selectedJobId !== undefined) {
    detail = (
      <JobDetail
        key={selectedJobId}
        jobId={selectedJobId}
        deviceId={deviceId}
        job={job}
        footer={job && footer ? footer(job) : null}
        fill
      />
    );
  } else if (!listPending) {
    detail = <p className="text-muted-foreground text-sm">{emptyMessage}</p>;
  }

  return (
    <div ref={wrapperRef} className="min-h-[32rem] lg:h-(--console-fill)">
      <SplitPane
        className="h-full"
        primary={<div className="h-full min-h-0 overflow-y-auto">{list}</div>}
        secondary={detail}
        defaultPrimaryWidth={360}
        minPrimaryWidth={260}
        maxPrimaryWidth={640}
        stackBelow="lg"
        handleLabel="Resize job list"
      />
    </div>
  );
}

function LifecycleJobsConsole({ deviceId, requestedJobId, onSelectJob, columns, footer }: JobsConsoleProps) {
  const table = useServerTable<LifecycleJobSummary>({
    name: `device-jobs-${deviceId}`,
    columns: columns ?? CONSOLE_COLUMNS,
  });
  const jobs = useLifecycleJobs(table, { deviceId });
  const tableRef = useRef<Table<LifecycleJobSummary> | null>(null);
  const selectedJobId = requestedJobId ?? newestJob(jobs.rows)?.id;
  const selected = jobs.rows.find((row) => row.id === selectedJobId);

  // the shared table drops its row selection whenever the data changes, so re-apply it after every page
  useEffect(() => {
    const instance = tableRef.current;
    if (!instance) return;
    const row = jobs.rows.find((candidate) => candidate.id === selectedJobId);
    instance.setRowSelection(row ? { [row.id]: true } : {});
  }, [jobs.rows, selectedJobId]);

  return (
    <ConsoleLayout
      deviceId={deviceId}
      list={
        <div className="space-y-3">
          {jobs.isError && (
            <div className="border-destructive/30 bg-destructive/5 text-destructive rounded border p-3 text-sm">
              Failed to load jobs.
            </div>
          )}
          <ServerDataTable
            table={table}
            data={jobs.rows}
            meta={jobs.meta}
            isPending={jobs.isPending}
            isFetching={jobs.isFetching && !jobs.isPending}
            emptyMessage={NO_LIFECYCLE_JOBS_MESSAGE}
            onRowClick={(row) => onSelectJob(row.id)}
            tableInstanceRef={tableRef}
          />
        </div>
      }
      selectedJobId={selectedJobId}
      job={selected ? jobRefFromSummary(selected) : undefined}
      listPending={jobs.isPending}
      emptyMessage={NO_LIFECYCLE_JOBS_MESSAGE}
      footer={footer}
    />
  );
}

function DeviceJobsConsole({
  deviceId,
  requestedJobId,
  onSelectJob,
  footer,
  listDeviceJobs,
}: JobsConsoleProps & { listDeviceJobs: ListDeviceJobs }) {
  const { data, isPending, isError, error } = useQuery({
    queryKey: diagnosticsKeys.deviceJobs(deviceId),
    queryFn: () => listDeviceJobs(deviceId),
  });
  const jobs = data ?? NO_DEVICE_JOBS;
  const selectedJobId = isError ? undefined : (requestedJobId ?? newestJob(jobs)?.id);
  const selected = jobs.find((job) => job.id === selectedJobId);

  let list: ReactNode;
  if (isError) {
    list = (
      <p className="text-muted-foreground text-sm">
        {isForbiddenError(error) ? NO_JOB_LOG_ACCESS_MESSAGE : 'Failed to load jobs.'}
      </p>
    );
  } else if (isPending) {
    list = <Skeleton className="h-40 w-full" />;
  } else if (jobs.length === 0) {
    list = <p className="text-muted-foreground text-sm">{NO_DEVICE_JOBS_MESSAGE}</p>;
  } else {
    list = <DeviceJobList jobs={jobs} selectedJobId={selectedJobId} onSelectJob={onSelectJob} />;
  }

  return (
    <ConsoleLayout
      deviceId={deviceId}
      list={list}
      selectedJobId={selectedJobId}
      job={selected ? jobRefFromDeviceJob(selected) : undefined}
      listPending={isPending || isError}
      emptyMessage={NO_DEVICE_JOBS_MESSAGE}
      footer={footer}
    />
  );
}

interface DeviceJobListProps {
  jobs: DeviceJob[];
  selectedJobId: string | undefined;
  onSelectJob: (jobId: string) => void;
}

function DeviceJobList({ jobs, selectedJobId, onSelectJob }: DeviceJobListProps) {
  return (
    <ul className="divide-y rounded-md border">
      {jobs.map((job) => {
        const selected = job.id === selectedJobId;
        return (
          <li key={job.id}>
            <button
              type="button"
              aria-current={selected ? 'true' : undefined}
              onClick={() => onSelectJob(job.id)}
              className={cn(
                'hover:bg-hover-bg/70 flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left text-sm',
                selected && 'bg-hover-bg',
              )}
            >
              <span className="font-mono text-xs">{job.id.slice(0, 8)}</span>
              <JobTypeBadge jobType={job.jobType} />
              <span className="text-muted-foreground text-xs">{formatDate(job.createdAt)}</span>
              <span className="text-muted-foreground ml-auto text-xs">{job.status}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
