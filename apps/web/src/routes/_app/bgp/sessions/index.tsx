import type { BgpSession } from '@repo/api-client';

import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { ServerDataTable } from '@repo/ui/components/server-data-table';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import type { ServerColumnDef } from '@repo/ui/hooks/use-server-table';
import { useServerTable } from '@repo/ui/hooks/use-server-table';

import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

const columns: ServerColumnDef<BgpSession>[] = [
  {
    id: 'name',
    accessorKey: 'name',
    header: 'Name',
    sortField: 'name',
    size: 200,
    cell: ({ row }) => <span className="text-sm font-medium">{row.original.name}</span>,
  },
  {
    id: 'status',
    accessorKey: 'status',
    header: 'Status',
    size: 140,
    cell: ({ row }) => <Badge variant="outline">{row.original.status}</Badge>,
  },
  {
    id: 'localAsnId',
    accessorKey: 'localAsnId',
    header: 'Local ASN ID',
    cell: ({ row }) => (
      <span className="text-sm">{row.original.localAsnId || <span className="text-muted-foreground">--</span>}</span>
    ),
  },
  {
    id: 'remoteAsnId',
    accessorKey: 'remoteAsnId',
    header: 'Remote ASN ID',
    cell: ({ row }) => (
      <span className="text-sm">{row.original.remoteAsnId || <span className="text-muted-foreground">--</span>}</span>
    ),
  },
  {
    id: 'createdAt',
    header: 'Created',
    sortField: 'createdAt',
    breakpoint: 'desktop',
    size: 110,
    cell: ({ row }) => (
      <span className="text-muted-foreground text-sm">{new Date(row.original.createdAt).toLocaleDateString()}</span>
    ),
  },
];

export const Route = createFileRoute('/_app/bgp/sessions/')({
  component: BgpSessionsPage,
});

function BgpSessionsPage() {
  useDocumentTitle('BGP Sessions');
  const navigate = useNavigate();
  const table = useServerTable<BgpSession>({ name: 'bgp-sessions', columns });

  const sessionsQuery = tsr.listBgpSessions.useQuery({
    queryKey: ['bgp-sessions'],
    queryData: { query: {} },
  });

  const rows = sessionsQuery.data?.status === 200 ? sessionsQuery.data.body : [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>BGP Sessions</CardTitle>
              <CardDescription>Manage BGP sessions.</CardDescription>
            </div>
            <Button asChild>
              <Link to="/bgp/sessions/create">Create BGP Session</Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <ServerDataTable
            table={table}
            data={rows}
            isPending={sessionsQuery.isPending}
            searchPlaceholder="Search BGP sessions..."
            searchLabel="Search BGP sessions"
            emptyMessage="No BGP sessions found"
            onRowClick={(row) => {
              void navigate({
                to: '/bgp/sessions/$sessionId',
                params: { sessionId: row.id },
              });
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
