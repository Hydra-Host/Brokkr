import type { LifecycleJobSummary } from '@repo/api-client';
import { ServerDataTable } from '@repo/domain-ui/components/server-data-table';
import type { ServerColumnDef } from '@repo/domain-ui/hooks/use-server-table';
import { useServerTable } from '@repo/domain-ui/hooks/use-server-table';
import { Badge } from '@repo/ui/components/badge';
import { ClickToCopyString } from '@repo/ui/components/click-to-copy-string';
import { JobTypeBadge } from '@repo/ui/components/job-type-badge';
import { keepPreviousData } from '@tanstack/react-query';
import { Clock } from 'lucide-react';
import { useIsInstanceOperator } from '~/hooks/use-is-instance-operator';
import { usePermissions } from '~/hooks/use-permissions';
import { tsr } from '~/lib/api';
import { LIFECYCLE_JOBS_KEY } from '~/lib/query-keys';

const PHASE_STYLES: Record<string, string> = {
  COMPLETED: 'border-green-600/30 bg-green-600/10 text-green-600',
  FAILED: 'border-red-600/30 bg-red-600/10 text-red-600',
  ABORTED: 'border-red-600/30 bg-red-600/10 text-red-600',
  RUNNING: 'border-yellow-600/30 bg-yellow-600/10 text-yellow-600',
  DISPATCHED: 'border-yellow-600/30 bg-yellow-600/10 text-yellow-600',
  AWAITING_PHONE_HOME: 'border-yellow-600/30 bg-yellow-600/10 text-yellow-600',
};

const PENDING_PHASES = new Set(['RUNNING', 'DISPATCHED', 'AWAITING_PHONE_HOME']);

function PhaseBadge({ phase }: { phase: string }) {
  return (
    <Badge variant="outline" className={PHASE_STYLES[phase] ?? 'text-muted-foreground'}>
      {PENDING_PHASES.has(phase) && <Clock className="mr-1 h-3 w-3" />}
      {phase}
    </Badge>
  );
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleString();
}

const columns: ServerColumnDef<LifecycleJobSummary>[] = [
  {
    id: 'id',
    accessorKey: 'id',
    header: 'Job ID',
    sortField: 'id',
    cell: ({ row }) => <ClickToCopyString value={row.original.id} className="font-mono text-xs" />,
  },
  {
    id: 'jobType',
    accessorKey: 'jobType',
    header: 'Kind',
    sortField: 'jobType',
    cell: ({ row }) => <JobTypeBadge jobType={row.original.jobType} />,
  },
  {
    id: 'phase',
    accessorKey: 'phase',
    header: 'Status',
    sortField: 'phase',
    cell: ({ row }) => <PhaseBadge phase={row.original.phase} />,
  },
  {
    id: 'createdAt',
    accessorKey: 'createdAt',
    header: 'Requested',
    sortField: 'createdAt',
    cell: ({ row }) => <span className="text-sm">{formatDate(row.original.createdAt)}</span>,
  },
  {
    id: 'completedAt',
    accessorKey: 'completedAt',
    header: 'Completed',
    cell: ({ row }) =>
      row.original.completedAt ? (
        <span className="text-sm">{formatDate(row.original.completedAt)}</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    id: 'error',
    accessorKey: 'error',
    header: 'Error',
    cell: ({ row }) =>
      row.original.error ? (
        <span className="text-destructive block max-w-[280px] truncate text-sm" title={row.original.error}>
          {row.original.error}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
];

export function useCanViewJobHistory(): { canView: boolean; isPending: boolean } {
  const { isInstanceOperator, isPending } = useIsInstanceOperator();
  const { can } = usePermissions();
  return { canView: isInstanceOperator && can('job', 'read'), isPending };
}

interface JobHistoryTableProps {
  deviceId?: string;
  deploymentId?: string;
  tableName: string;
}

export function JobHistoryTable({ deviceId, deploymentId, tableName }: JobHistoryTableProps) {
  const table = useServerTable<LifecycleJobSummary>({ name: tableName, columns });

  const queryParams = {
    ...table.query,
    ...(deviceId ? { deviceId } : {}),
    ...(deploymentId ? { deploymentId } : {}),
  };

  const jobsQuery = tsr.listLifecycleJobs.useQuery({
    queryKey: [...LIFECYCLE_JOBS_KEY, queryParams],
    queryData: { query: queryParams },
    placeholderData: keepPreviousData,
  });

  const rows = jobsQuery.data?.status === 200 ? jobsQuery.data.body.data : [];
  const meta = jobsQuery.data?.status === 200 ? jobsQuery.data.body.meta : undefined;

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
        emptyMessage="No jobs found"
      />
    </>
  );
}
