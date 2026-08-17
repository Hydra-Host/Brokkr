import type { BgpPeerGroup } from '@repo/api-client';

import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { ServerDataTable } from '@repo/ui/components/server-data-table';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import type { ServerColumnDef } from '@repo/ui/hooks/use-server-table';
import { useServerTable } from '@repo/ui/hooks/use-server-table';

import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

const columns: ServerColumnDef<BgpPeerGroup>[] = [
  {
    id: 'name',
    accessorKey: 'name',
    header: 'Name',
    sortField: 'name',
    size: 200,
    cell: ({ row }) => <span className="text-sm font-medium">{row.original.name}</span>,
  },
  {
    id: 'description',
    accessorKey: 'description',
    header: 'Description',
    cell: ({ row }) => (
      <span className="text-sm">{row.original.description || <span className="text-muted-foreground">--</span>}</span>
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

export const Route = createFileRoute('/_app/bgp/peer-groups/')({
  component: BgpPeerGroupsPage,
});

function BgpPeerGroupsPage() {
  useDocumentTitle('BGP Peer Groups');
  const navigate = useNavigate();
  const table = useServerTable<BgpPeerGroup>({ name: 'bgp-peer-groups', columns });

  const peerGroupsQuery = tsr.listBgpPeerGroups.useQuery({
    queryKey: ['bgp-peer-groups'],
    queryData: { query: {} },
  });

  const rows = peerGroupsQuery.data?.status === 200 ? peerGroupsQuery.data.body : [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>BGP Peer Groups</CardTitle>
              <CardDescription>Manage BGP peer groups.</CardDescription>
            </div>
            <Button asChild>
              <Link to="/bgp/peer-groups/create">Create Peer Group</Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <ServerDataTable
            table={table}
            data={rows}
            isPending={peerGroupsQuery.isPending}
            searchPlaceholder="Search peer groups..."
            searchLabel="Search peer groups"
            emptyMessage="No peer groups found"
            onRowClick={(row) => {
              void navigate({
                to: '/bgp/peer-groups/$peerGroupId',
                params: { peerGroupId: row.id },
              });
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
