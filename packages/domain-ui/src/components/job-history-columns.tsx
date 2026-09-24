import type { LifecycleJobSummary } from '@repo/api-client';
import { Badge } from '@repo/ui/components/badge';
import { ClickToCopyString } from '@repo/ui/components/click-to-copy-string';
import { JobTypeBadge } from '@repo/ui/components/job-type-badge';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Clock } from 'lucide-react';
import { diagnosticsKeys, useDiagnosticsApi, type LifecycleJobsScope } from '../hooks/use-diagnostics-api';
import type { ServerColumnDef, useServerTable } from '../hooks/use-server-table';

const PHASE_STYLES: Record<string, string> = {
  COMPLETED: 'border-green-600/30 bg-green-600/10 text-green-600',
  FAILED: 'border-red-600/30 bg-red-600/10 text-red-600',
  ABORTED: 'border-red-600/30 bg-red-600/10 text-red-600',
  RUNNING: 'border-yellow-600/30 bg-yellow-600/10 text-yellow-600',
  DISPATCHED: 'border-yellow-600/30 bg-yellow-600/10 text-yellow-600',
  AWAITING_PHONE_HOME: 'border-yellow-600/30 bg-yellow-600/10 text-yellow-600',
};

export const PENDING_PHASES = new Set(['RUNNING', 'DISPATCHED', 'AWAITING_PHONE_HOME']);

export function PhaseBadge({ phase }: { phase: string }) {
  return (
    <Badge variant="outline" className={PHASE_STYLES[phase] ?? 'text-muted-foreground'}>
      {PENDING_PHASES.has(phase) && <Clock className="mr-1 h-3 w-3" />}
      {phase}
    </Badge>
  );
}

export function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleString();
}

export const JOB_COLUMNS: ServerColumnDef<LifecycleJobSummary>[] = [
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
];

export const NO_LIFECYCLE_JOBS_MESSAGE =
  'No lifecycle jobs recorded. Jobs appear when a provision, power, deprovision, inventory or benchmark saga is dispatched.';

export function useCanViewJobHistory(): { canView: boolean; isPending: boolean } {
  const { gates } = useDiagnosticsApi();
  return { canView: gates.can('jobs.view'), isPending: gates.isLoading };
}

const NO_JOBS: LifecycleJobSummary[] = [];

type LifecycleJobsTable = Pick<ReturnType<typeof useServerTable<LifecycleJobSummary>>, 'query'>;

export function useLifecycleJobs(
  table: LifecycleJobsTable,
  scope: LifecycleJobsScope,
  options: { refetchInterval?: number | false } = {},
) {
  const api = useDiagnosticsApi();
  const jobsQuery = useQuery({
    queryKey: diagnosticsKeys.jobs(scope, table.query),
    queryFn: () => api.listJobs(scope, table.query),
    placeholderData: keepPreviousData,
    ...options,
  });

  return {
    rows: jobsQuery.data?.data ?? NO_JOBS,
    meta: jobsQuery.data?.meta,
    isPending: jobsQuery.isPending,
    isFetching: jobsQuery.isFetching,
    isError: jobsQuery.isError,
  };
}
