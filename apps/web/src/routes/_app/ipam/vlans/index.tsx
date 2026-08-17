import type { Vlan } from '@repo/api-client';

import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { ServerDataTable } from '@repo/ui/components/server-data-table';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import type { ServerColumnDef } from '@repo/ui/hooks/use-server-table';
import { useServerTable } from '@repo/ui/hooks/use-server-table';

import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

function statusVariant(status: string) {
  switch (status) {
    case 'ACTIVE':
      return 'default';
    case 'RESERVED':
      return 'secondary';
    case 'DEPRECATED':
      return 'destructive';
    default:
      return 'outline';
  }
}

const columns: ServerColumnDef<Vlan>[] = [
  {
    id: 'vid',
    accessorKey: 'vid',
    header: 'VID',
    sortField: 'vid',
    size: 100,
    cell: ({ row }) => <span className="font-mono text-sm">{row.original.vid}</span>,
  },
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
    size: 120,
    cell: ({ row }) => <Badge variant={statusVariant(row.original.status)}>{row.original.status}</Badge>,
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

export const Route = createFileRoute('/_app/ipam/vlans/')({
  staticData: { breadcrumb: 'VLANs' },
  component: VlansPage,
});

function VlansPage() {
  useDocumentTitle('VLANs');
  const navigate = useNavigate();
  const table = useServerTable<Vlan>({ name: 'vlans', columns });

  const vlansQuery = tsr.listVlans.useQuery({
    queryKey: ['vlans'],
    queryData: { query: {} },
  });

  const rows = vlansQuery.data?.status === 200 ? vlansQuery.data.body : [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>VLANs</CardTitle>
              <CardDescription>Manage Virtual LANs.</CardDescription>
            </div>
            <Button asChild>
              <Link to="/ipam/vlans/create">Create VLAN</Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <ServerDataTable
            table={table}
            data={rows}
            isPending={vlansQuery.isPending}
            searchPlaceholder="Search VLANs..."
            searchLabel="Search VLANs"
            emptyMessage="No VLANs found"
            onRowClick={(row) => {
              void navigate({
                to: '/ipam/vlans/$vlanId',
                params: { vlanId: row.id },
              });
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
