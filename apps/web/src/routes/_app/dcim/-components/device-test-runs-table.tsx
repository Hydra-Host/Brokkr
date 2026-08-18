import type { DcimDeviceTestRunWithDevice } from '@repo/api-client';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { ClickToCopyString } from '@repo/ui/components/click-to-copy-string';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@repo/ui/components/dialog';
import { ServerDataTable } from '@repo/ui/components/server-data-table';
import type { ServerColumnDef } from '@repo/ui/hooks/use-server-table';
import { useServerTable } from '@repo/ui/hooks/use-server-table';
import { formatDuration } from '@repo/utils';
import { keepPreviousData } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CheckCircle, Clock, Eye, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { tsr } from '~/lib/api';

const TEST_TYPE_LABELS: Record<string, string> = {
  GpuBurnIn: 'GPU Burn-in',
  NcclPerformance: 'NCCL Performance',
};

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleString();
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'Completed') {
    return (
      <Badge variant="outline" className="border-green-600/30 bg-green-600/10 text-green-600">
        Completed
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="border-yellow-600/30 bg-yellow-600/10 text-yellow-600">
      <Clock className="mr-1 h-3 w-3" />
      Running
    </Badge>
  );
}

function TestPassedIndicator({ passed }: { passed: boolean | null }) {
  if (passed === null) return <span className="text-muted-foreground">—</span>;
  if (passed) return <CheckCircle className="h-5 w-5 text-green-600" />;
  return <XCircle className="h-5 w-5 text-red-600" />;
}

type TestType = 'GpuBurnIn' | 'NcclPerformance';
type TestStatus = 'Running' | 'Completed';

interface DeviceTestRunsTableProps {
  deviceId?: string;
  showDeviceColumn?: boolean;
  tableName: string;
  type?: TestType;
  status?: TestStatus;
}

export function DeviceTestRunsTable({
  deviceId,
  showDeviceColumn = true,
  tableName,
  type,
  status,
}: DeviceTestRunsTableProps) {
  const [selectedTestRun, setSelectedTestRun] = useState<DcimDeviceTestRunWithDevice | null>(null);

  const columns = useMemo<ServerColumnDef<DcimDeviceTestRunWithDevice>[]>(() => {
    const cols: ServerColumnDef<DcimDeviceTestRunWithDevice>[] = [];

    if (showDeviceColumn) {
      cols.push({
        id: 'deviceId',
        accessorKey: 'deviceId',
        header: 'Device',
        sortField: 'deviceId',
        cell: ({ row }) => {
          const device = row.original.device;
          if (!device) return <span className="text-muted-foreground">—</span>;
          return (
            <div className="flex min-h-9 flex-col justify-center">
              <Link
                to="/dcim/servers/$deviceId"
                params={{ deviceId: device.id }}
                className="hover:text-primary font-medium underline"
                onClick={(e) => e.stopPropagation()}
              >
                {device.name}
              </Link>
              <span className="font-mono text-xs">{device.id}</span>
            </div>
          );
        },
      });
    }

    cols.push(
      {
        id: 'type',
        accessorKey: 'type',
        header: 'Test Type',
        sortField: 'type',
        cell: ({ row }) => <span className="text-sm">{TEST_TYPE_LABELS[row.original.type] ?? row.original.type}</span>,
      },
      {
        id: 'status',
        accessorKey: 'status',
        header: 'Status',
        sortField: 'status',
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
      {
        id: 'testPassed',
        accessorKey: 'testPassed',
        header: 'Passed',
        sortField: 'testPassed',
        cell: ({ row }) => <TestPassedIndicator passed={row.original.testPassed} />,
      },
      {
        id: 'duration',
        accessorKey: 'durationSeconds',
        header: 'Duration',
        sortField: 'durationSeconds',
        cell: ({ row }) => <span className="text-sm">{formatDuration(row.original.durationSeconds)}</span>,
      },
      {
        id: 'startTime',
        accessorKey: 'startTime',
        header: 'Start Time',
        sortField: 'startTime',
        cell: ({ row }) => <span className="text-sm">{formatDate(row.original.startTime)}</span>,
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) => (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSelectedTestRun(row.original)}
            disabled={!row.original.data}
          >
            <Eye className="mr-1 h-4 w-4" />
            View Results
          </Button>
        ),
      },
    );

    return cols;
  }, [showDeviceColumn]);

  const table = useServerTable<DcimDeviceTestRunWithDevice>({ name: tableName, columns });

  const queryParams = {
    ...table.query,
    ...(deviceId ? { deviceId } : {}),
    ...(type ? { type } : {}),
    ...(status ? { status } : {}),
  };

  const testRunsQuery = tsr.getServerTestRuns.useQuery({
    queryKey: ['device-test-runs', queryParams],
    queryData: { query: queryParams },
    placeholderData: keepPreviousData,
  });

  const rows = testRunsQuery.data?.status === 200 ? testRunsQuery.data.body.data : [];
  const meta = testRunsQuery.data?.status === 200 ? testRunsQuery.data.body.meta : undefined;

  return (
    <>
      {testRunsQuery.isError && (
        <div className="border-destructive/30 bg-destructive/5 text-destructive mb-4 rounded border p-3 text-sm">
          Failed to load device test runs.
        </div>
      )}

      <ServerDataTable
        table={table}
        data={rows}
        meta={meta}
        isPending={testRunsQuery.isPending}
        isFetching={testRunsQuery.isFetching && !testRunsQuery.isPending}
        searchPlaceholder="Search devices..."
        searchLabel="Search devices"
        emptyMessage="No test runs found"
      />

      <Dialog open={!!selectedTestRun} onOpenChange={() => setSelectedTestRun(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {selectedTestRun && (TEST_TYPE_LABELS[selectedTestRun.type] ?? selectedTestRun.type)}
            </DialogTitle>
            {selectedTestRun && (
              <div className="text-text-muted flex flex-col gap-2 pt-1 text-sm">
                {selectedTestRun.device ? (
                  <>
                    <span>
                      <span className="text-muted-foreground font-medium">Name:</span> {selectedTestRun.device.name}
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="text-muted-foreground font-medium">ID:</span>
                      <ClickToCopyString value={selectedTestRun.device.id} className="text-xs" />
                    </span>
                  </>
                ) : (
                  <span className="text-muted-foreground">Unknown device</span>
                )}
                <span className="flex items-center gap-2">
                  <StatusBadge status={selectedTestRun.status} />
                  {selectedTestRun.testPassed !== null && (
                    <span className="inline-flex items-center gap-1">
                      <TestPassedIndicator passed={selectedTestRun.testPassed} />
                      <span className={selectedTestRun.testPassed ? 'text-green-600' : 'text-red-600'}>
                        {selectedTestRun.testPassed ? 'Passed' : 'Failed'}
                      </span>
                    </span>
                  )}
                  <span className="text-muted-foreground">·</span>
                  <span>{formatDate(selectedTestRun.startTime)}</span>
                  {selectedTestRun.durationSeconds !== null && (
                    <>
                      <span className="text-muted-foreground">·</span>
                      <span>{formatDuration(selectedTestRun.durationSeconds)}</span>
                    </>
                  )}
                </span>
              </div>
            )}
          </DialogHeader>
          <div className="bg-muted max-h-[60vh] overflow-auto rounded-sm border p-4">
            <pre className="font-mono text-sm wrap-break-word whitespace-pre-wrap">
              {selectedTestRun?.data ? JSON.stringify(selectedTestRun.data, null, 2) : 'No data available'}
            </pre>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
