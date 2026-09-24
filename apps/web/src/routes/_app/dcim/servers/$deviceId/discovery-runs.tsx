import type { DiscoveryRun, DiscoveryRunIssue } from '@repo/api-client';
import { ServerDataTable } from '@repo/domain-ui/components/server-data-table';
import type { ServerColumnDef } from '@repo/domain-ui/hooks/use-server-table';
import { useServerTable } from '@repo/domain-ui/hooks/use-server-table';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { ClickToCopyString } from '@repo/ui/components/click-to-copy-string';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@repo/ui/components/dialog';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { formatDuration, formatShortDateTime } from '@repo/utils';
import { keepPreviousData } from '@tanstack/react-query';
import { createFileRoute, getRouteApi } from '@tanstack/react-router';
import { Eye, ScanSearch } from 'lucide-react';
import { useMemo, useState } from 'react';
import { tsr } from '~/lib/api';
import { type IssueSeverity, type RunStatus, worstSeverity } from './-discovery-run-severity';

const parentRoute = getRouteApi('/_app/dcim/servers/$deviceId');

export const Route = createFileRoute('/_app/dcim/servers/$deviceId/discovery-runs')({
  staticData: { breadcrumb: 'Discovery Runs' },
  component: ServerDiscoveryRuns,
});

const STATUS_CLASSES: Record<RunStatus, string> = {
  STARTED: 'border-blue-600/30 bg-blue-600/10 text-blue-600',
  SUCCEEDED: 'border-green-600/30 bg-green-600/10 text-green-600',
  PARTIAL: 'border-yellow-600/30 bg-yellow-600/10 text-yellow-600',
  FAILED: 'border-red-600/30 bg-red-600/10 text-red-600',
  REJECTED: 'border-red-600/30 bg-red-600/10 text-red-600',
};

const SEVERITY_CLASSES: Record<IssueSeverity, string> = {
  ERROR: 'border-red-600/30 bg-red-600/10 text-red-600',
  WARN: 'border-yellow-600/30 bg-yellow-600/10 text-yellow-600',
  INFO: 'border-blue-600/30 bg-blue-600/10 text-blue-600',
};

function formatRunDuration(durationMs: number | null): string {
  return formatDuration(durationMs === null ? null : Math.round(durationMs / 1000));
}

function StatusBadge({ status }: { status: RunStatus }) {
  return (
    <Badge variant="outline" className={STATUS_CLASSES[status]}>
      {status}
    </Badge>
  );
}

function SeverityBadge({ severity }: { severity: IssueSeverity }) {
  return (
    <Badge variant="outline" className={SEVERITY_CLASSES[severity]}>
      {severity}
    </Badge>
  );
}

function IssueDetail({ issue }: { issue: DiscoveryRunIssue }) {
  return (
    <div className="rounded-sm border p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <SeverityBadge severity={issue.severity} />
        <span className="font-medium">{issue.code}</span>
        <span className="text-muted-foreground">{issue.phase}</span>
        {issue.collector && <span className="font-mono text-xs">{issue.collector}</span>}
        <span className="text-muted-foreground text-xs">{formatShortDateTime(issue.createdAt)}</span>
      </div>
      {issue.detail !== null && issue.detail !== undefined && (
        <pre className="bg-muted mt-2 max-h-48 overflow-auto rounded-sm p-2 font-mono text-xs wrap-break-word whitespace-pre-wrap">
          {JSON.stringify(issue.detail, null, 2)}
        </pre>
      )}
    </div>
  );
}

function ServerDiscoveryRuns() {
  const device = parentRoute.useLoaderData();
  const displayName = device.dcim?.nickname || device.name;
  useDocumentTitle(`${displayName} - Discovery Runs`);

  const [selectedRun, setSelectedRun] = useState<DiscoveryRun | null>(null);

  const columns = useMemo<ServerColumnDef<DiscoveryRun>[]>(
    () => [
      {
        id: 'startedAt',
        accessorKey: 'startedAt',
        header: 'Started',
        sortField: 'startedAt',
        cell: ({ row }) => <span className="text-sm">{formatShortDateTime(row.original.startedAt)}</span>,
      },
      {
        id: 'status',
        accessorKey: 'status',
        header: 'Status',
        sortField: 'status',
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
      {
        id: 'jobId',
        accessorKey: 'jobId',
        header: 'Job',
        cell: ({ row }) => <ClickToCopyString value={row.original.jobId} className="text-xs" />,
      },
      {
        id: 'collectors',
        accessorKey: 'collectorsApplied',
        header: 'Collectors',
        cell: ({ row }) => (
          <div className="flex flex-col text-sm">
            <span>
              {row.original.collectorsReceived ?? '—'} received of {row.original.collectorsExpected ?? '—'}
            </span>
            <span className="text-muted-foreground text-xs">
              {row.original.collectorsApplied.length} applied · {row.original.collectorsSkipped.length} skipped
            </span>
          </div>
        ),
      },
      {
        id: 'durationMs',
        accessorKey: 'durationMs',
        header: 'Duration',
        sortField: 'durationMs',
        cell: ({ row }) => <span className="text-sm">{formatRunDuration(row.original.durationMs)}</span>,
      },
      {
        id: 'issues',
        accessorKey: 'issues',
        header: 'Issues',
        cell: ({ row }) => {
          const issues = row.original.issues;
          const worst = worstSeverity(issues);
          if (worst === null) return <span className="text-muted-foreground">—</span>;
          return (
            <div className="flex items-center gap-2">
              <SeverityBadge severity={worst} />
              <span className="text-sm">{issues.length}</span>
            </div>
          );
        },
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) => (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSelectedRun(row.original)}
            disabled={row.original.issues.length === 0}
          >
            <Eye className="mr-1 h-4 w-4" />
            View Issues
          </Button>
        ),
      },
    ],
    [],
  );

  const table = useServerTable<DiscoveryRun>({ name: `dcim-discovery-runs-${device.id}`, columns });

  const runsQuery = tsr.listDeviceDiscoveryRuns.useQuery({
    queryKey: ['device-discovery-runs', device.id, table.query],
    queryData: { params: { deviceId: device.id }, query: table.query },
    placeholderData: keepPreviousData,
  });

  const rows = runsQuery.data?.status === 200 ? runsQuery.data.body.data : [];
  const meta = runsQuery.data?.status === 200 ? runsQuery.data.body.meta : undefined;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ScanSearch className="h-5 w-5" />
          Discovery Runs
        </CardTitle>
        <CardDescription>Hardware discovery passes recorded for {displayName}.</CardDescription>
      </CardHeader>
      <CardContent>
        {runsQuery.isError && (
          <div className="border-destructive/30 bg-destructive/5 text-destructive mb-4 rounded border p-3 text-sm">
            Failed to load discovery runs.
          </div>
        )}

        <ServerDataTable
          table={table}
          data={rows}
          meta={meta}
          isPending={runsQuery.isPending}
          isFetching={runsQuery.isFetching && !runsQuery.isPending}
          searchPlaceholder="Search by job or handler version..."
          searchLabel="Search discovery runs"
          emptyMessage="No discovery runs recorded"
        />

        <Dialog open={!!selectedRun} onOpenChange={() => setSelectedRun(null)}>
          <DialogContent className="max-w-3xl">
            <DialogHeader>
              <DialogTitle>Discovery run issues</DialogTitle>
              {selectedRun && (
                <div className="text-muted-foreground flex flex-wrap items-center gap-2 pt-1 text-sm">
                  <StatusBadge status={selectedRun.status} />
                  <span>{formatShortDateTime(selectedRun.startedAt)}</span>
                  <span>·</span>
                  <span className="font-mono text-xs">{selectedRun.jobId}</span>
                </div>
              )}
            </DialogHeader>
            <div className="max-h-[60vh] space-y-2 overflow-auto">
              {selectedRun?.issues.map((issue) => (
                <IssueDetail key={issue.id} issue={issue} />
              ))}
            </div>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
