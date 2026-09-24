import type { LifecycleJobSummary } from '@repo/api-client';
import { JobEventsSheet } from '@repo/domain-ui/components/job-events-sheet';
import {
  JOB_COLUMNS,
  NO_LIFECYCLE_JOBS_MESSAGE,
  useLifecycleJobs,
} from '@repo/domain-ui/components/job-history-columns';
import { ServerDataTable } from '@repo/domain-ui/components/server-data-table';
import type { LifecycleJobsScope } from '@repo/domain-ui/hooks/use-diagnostics-api';
import type { ServerColumnDef } from '@repo/domain-ui/hooks/use-server-table';
import { useServerTable } from '@repo/domain-ui/hooks/use-server-table';
import { Button } from '@repo/ui/components/button';
import { useMemo, useState } from 'react';
import { useCanViewJobHistory } from '~/hooks/use-can-view-job-history';

function buildColumns(onOpen: (job: LifecycleJobSummary) => void): ServerColumnDef<LifecycleJobSummary>[] {
  return [
    ...JOB_COLUMNS,
    {
      id: 'error',
      accessorKey: 'error',
      header: 'Error',
      cell: ({ row }) =>
        row.original.error ? (
          <button
            type="button"
            className="text-destructive block max-w-[280px] truncate text-left text-sm underline"
            onClick={() => onOpen(row.original)}
          >
            {row.original.error}
          </button>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => (
        <Button variant="ghost" size="sm" onClick={() => onOpen(row.original)}>
          Events
        </Button>
      ),
    },
  ];
}

export { useCanViewJobHistory };

interface JobHistoryTableProps extends LifecycleJobsScope {
  tableName: string;
}

export function JobHistoryTable({ deviceId, deploymentId, tableName }: JobHistoryTableProps) {
  const [openJob, setOpenJob] = useState<LifecycleJobSummary | null>(null);
  const tableColumns = useMemo(() => buildColumns(setOpenJob), []);
  const table = useServerTable<LifecycleJobSummary>({ name: tableName, columns: tableColumns });
  const jobsQuery = useLifecycleJobs(table, { deviceId, deploymentId });
  const { rows, meta } = jobsQuery;

  return (
    <>
      {jobsQuery.isError && (
        <div className="border-destructive/30 bg-destructive/5 text-destructive mb-4 rounded border p-3 text-sm">
          Failed to load jobs.
        </div>
      )}

      <ServerDataTable
        table={table}
        data={rows}
        meta={meta}
        isPending={jobsQuery.isPending}
        isFetching={jobsQuery.isFetching && !jobsQuery.isPending}
        emptyMessage={NO_LIFECYCLE_JOBS_MESSAGE}
      />
      <JobEventsSheet job={openJob} onClose={() => setOpenJob(null)} />
    </>
  );
}
