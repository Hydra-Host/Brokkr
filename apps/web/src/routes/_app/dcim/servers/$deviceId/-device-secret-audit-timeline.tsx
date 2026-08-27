import type { DeviceSecretAuditEvent } from '@repo/api-client';
import { ServerDataTable } from '@repo/domain-ui/components/server-data-table';
import type { ServerColumnDef } from '@repo/domain-ui/hooks/use-server-table';
import { useServerTable } from '@repo/domain-ui/hooks/use-server-table';
import { Badge } from '@repo/ui/components/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { ClickToCopyString } from '@repo/ui/components/click-to-copy-string';
import { tsr } from '~/lib/api';

function eventVariant(event: DeviceSecretAuditEvent['event']): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (event) {
    case 'WRITE':
    case 'UPDATE':
      return 'default';
    case 'REVEAL_REQUESTED':
    case 'DISPATCH':
      return 'secondary';
    case 'INVALIDATED':
      return 'destructive';
    case 'REVEAL_DELIVERED':
      return 'outline';
  }
}

const auditColumns: ServerColumnDef<DeviceSecretAuditEvent>[] = [
  {
    id: 'createdAt',
    header: 'When',
    cell: ({ row }) => (
      <span className="text-muted-foreground text-sm">{new Date(row.original.createdAt).toLocaleString()}</span>
    ),
  },
  {
    id: 'event',
    header: 'Event',
    cell: ({ row }) => <Badge variant={eventVariant(row.original.event)}>{row.original.event}</Badge>,
  },
  {
    id: 'purpose',
    header: 'Purpose / version',
    cell: ({ row }) => (
      <span className="text-sm">
        {row.original.purpose ?? '--'}
        {row.original.version != null ? ` v${row.original.version}` : ''}
      </span>
    ),
  },
  {
    id: 'actor',
    header: 'Actor',
    cell: ({ row }) => {
      const label = row.original.actorDisplay ?? row.original.actor;
      return (
        <span className="text-sm">
          <span className="text-muted-foreground">{row.original.actorType}</span>
          {label ? ` · ${label}` : ''}
        </span>
      );
    },
  },
  {
    id: 'requestId',
    header: 'Request ID',
    cell: ({ row }) =>
      row.original.requestId ? (
        <ClickToCopyString value={row.original.requestId} truncate maxWidth="160px" />
      ) : (
        <span className="text-muted-foreground">--</span>
      ),
  },
];

export function DeviceSecretAuditTimeline({ deviceId }: { deviceId: string }) {
  const table = useServerTable<DeviceSecretAuditEvent>({ name: 'device-secret-audit', columns: auditColumns });

  const query = tsr.listDeviceSecretAuditEvents.useQuery({
    queryKey: ['server', deviceId, 'secret-audit', table.query],
    queryData: { params: { deviceId }, query: table.query },
  });

  const rows = query.data?.status === 200 ? query.data.body.data : [];
  const meta = query.data?.status === 200 ? query.data.body.meta : undefined;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Audit Timeline</CardTitle>
        <CardDescription>
          Device-secret lifecycle events, newest first. The request ID correlates a reveal request with its dispatch and
          delivery rows.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ServerDataTable
          table={table}
          data={rows}
          meta={meta}
          isPending={query.isPending}
          emptyMessage="No device-secret audit events for this device"
        />
      </CardContent>
    </Card>
  );
}
