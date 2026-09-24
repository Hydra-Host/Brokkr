import type { DeviceHealthCheck } from '@repo/api-client';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@repo/ui/components/table';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { HeartPulse } from 'lucide-react';
import { useMemo } from 'react';
import { isForbiddenError } from '../hooks/api-errors';
import { HEALTH_REQUESTED_MESSAGE, healthRequestMessage, healthSummaryLine, relativeTime } from '../hooks/health-copy';
import { HEALTH_SUMMARY_POLL_MS } from '../hooks/poll-intervals';
import { diagnosticsKeys, useDiagnosticsApi } from '../hooks/use-diagnostics-api';
import { type ServerColumnDef, useServerTable } from '../hooks/use-server-table';
import { DeviceHealthSummaryCard } from './device-health-summary-card';
import type { DiagnosticDevice } from './diagnostic-header-lines';
import { HEALTH_CHECK_COLUMNS, HealthCheckStatusIcon, isDormantCheck } from './health-check-status-icon';
import { ServerDataTable } from './server-data-table';

const historyColumns = (deployedOs: boolean): ServerColumnDef<DeviceHealthCheck>[] => [
  {
    id: 'testedAt',
    accessorKey: 'testedAt',
    header: 'Changed at',
    sortField: 'testedAt',
    cell: ({ row }) => <span className="text-sm">{new Date(row.original.testedAt).toLocaleString()}</span>,
  },
  ...HEALTH_CHECK_COLUMNS.map(
    (column): ServerColumnDef<DeviceHealthCheck> => ({
      id: column.key,
      accessorKey: column.key,
      header: column.label,
      cell: ({ row }) => (
        <HealthCheckStatusIcon
          value={row.original[column.key]}
          label={column.label}
          dormant={isDormantCheck(column.key, deployedOs)}
        />
      ),
    }),
  ),
  {
    id: 'reachability',
    accessorKey: 'reachability',
    header: 'Reachability',
    cell: ({ row }) => <Badge variant="outline">{row.original.reachability}</Badge>,
  },
];

export function HealthDiagnostics({ device }: { device: DiagnosticDevice }) {
  const api = useDiagnosticsApi();
  const summaryQuery = useQuery({
    queryKey: diagnosticsKeys.health(device.id),
    queryFn: () => api.healthSummary(device.id),
    refetchInterval: HEALTH_SUMMARY_POLL_MS,
  });
  const request = useMutation({ mutationFn: () => api.requestHealthCheck(device.id) });
  const canRequest = api.gates.can('health.request');
  const requestMessage = request.isSuccess
    ? HEALTH_REQUESTED_MESSAGE
    : request.isError
      ? healthRequestMessage(request.error)
      : null;

  return (
    <div className="space-y-6">
      {summaryQuery.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : summaryQuery.isError ? (
        <Card>
          <CardContent className="text-muted-foreground pt-6 text-sm">
            {isForbiddenError(summaryQuery.error)
              ? 'You do not have access to this device.'
              : 'The health summary could not be loaded.'}
          </CardContent>
        </Card>
      ) : (
        <DeviceHealthSummaryCard
          summary={summaryQuery.data}
          line={healthSummaryLine(summaryQuery.data, Date.now())}
          deployedOs={device.deployedOs}
          message={requestMessage}
          action={
            <Button
              variant="outline"
              size="sm"
              disabled={!canRequest || request.isPending}
              onClick={() => request.mutate()}
            >
              <HeartPulse className="mr-2 h-4 w-4" />
              {request.isPending ? 'Requesting…' : 'Check now'}
            </Button>
          }
        />
      )}
      <HealthHistoryCard deviceId={device.id} deployedOs={device.deployedOs} />
      {api.gates.can('device-tokens.read') && <DeviceTokensCard deviceId={device.id} />}
    </div>
  );
}

export function HealthHistoryCard({ deviceId, deployedOs }: { deviceId: string; deployedOs: boolean }) {
  const api = useDiagnosticsApi();
  const columns = useMemo(() => historyColumns(deployedOs), [deployedOs]);
  const table = useServerTable<DeviceHealthCheck>({
    name: `device-health-checks-${deviceId}`,
    columns,
  });
  const query = useQuery({
    queryKey: diagnosticsKeys.healthChecks(deviceId, table.query),
    queryFn: () => api.listHealthChecks(deviceId, table.query),
    placeholderData: keepPreviousData,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>History</CardTitle>
        <CardDescription>
          A row appears only when a check result changed. Rows older than {query.data?.retentionDays ?? 7} days are
          deleted. No rows means no change, not no checks.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ServerDataTable
          table={table}
          data={query.data?.data ?? []}
          meta={query.data?.meta}
          isPending={query.isPending}
          isFetching={query.isFetching && !query.isPending}
          emptyMessage="No health change recorded in the last 7 days. The bridge writes a row only when a result changes."
        />
      </CardContent>
    </Card>
  );
}

export function DeviceTokensCard({ deviceId }: { deviceId: string }) {
  const api = useDiagnosticsApi();
  const query = useQuery({
    queryKey: diagnosticsKeys.deviceTokens(deviceId),
    queryFn: () => api.listDeviceTokens(deviceId),
  });
  const tokens = query.data ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Device tokens</CardTitle>
        <CardDescription>
          Last accepted use per token. Updates at most once per 60 seconds. The token itself is never shown.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {query.isPending ? (
          <Skeleton className="h-20 w-full" />
        ) : query.isError && isForbiddenError(query.error) ? (
          <p className="text-muted-foreground text-sm">You do not have access to device tokens.</p>
        ) : query.isError ? (
          <p className="text-muted-foreground text-sm">Device tokens could not be loaded.</p>
        ) : tokens.length === 0 ? (
          <p className="text-muted-foreground text-sm">No token has been issued for this device.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Context</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>Generation</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tokens.map((token) => (
                <TableRow key={token.id}>
                  <TableCell className="font-mono text-xs">{token.context}</TableCell>
                  <TableCell>
                    <Badge variant={token.status === 'ACTIVE' ? 'success' : 'outline'}>
                      {token.status.toLowerCase()}
                    </Badge>
                    {token.revokedReason && (
                      <span className="text-muted-foreground ml-2 text-xs">{token.revokedReason}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">
                    {token.lastUsedAt
                      ? `${relativeTime(new Date(token.lastUsedAt).toISOString(), Date.now())}${token.lastUsedIp ? ` from ${token.lastUsedIp}` : ''}`
                      : 'never used'}
                  </TableCell>
                  <TableCell className="text-sm">{token.rotationGeneration}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
