import type { Vrf } from '@repo/api-client';

import { ServerDataTable } from '@repo/domain-ui/components/server-data-table';
import type { ServerColumnDef } from '@repo/domain-ui/hooks/use-server-table';
import { useServerTable } from '@repo/domain-ui/hooks/use-server-table';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';

import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

const columns: ServerColumnDef<Vrf>[] = [
  {
    id: 'name',
    accessorKey: 'name',
    header: 'Name',
    sortField: 'name',
    size: 200,
    cell: ({ row }) => <span className="text-sm font-medium">{row.original.name}</span>,
  },
  {
    id: 'rd',
    accessorKey: 'rd',
    header: 'Route Distinguisher',
    size: 180,
    cell: ({ row }) => (
      <span className="font-mono text-sm">{row.original.rd || <span className="text-muted-foreground">--</span>}</span>
    ),
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

export const Route = createFileRoute('/_app/ipam/vrfs/')({
  staticData: { breadcrumb: 'VRFs' },
  component: VrfsPage,
});

function VrfsPage() {
  useDocumentTitle('VRFs');
  const navigate = useNavigate();
  const table = useServerTable<Vrf>({ name: 'vrfs', columns });

  const vrfsQuery = tsr.listVrfs.useQuery({
    queryKey: ['vrfs'],
    queryData: { query: {} },
  });

  const rows = vrfsQuery.data?.status === 200 ? vrfsQuery.data.body : [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>VRFs</CardTitle>
              <CardDescription>Manage Virtual Routing and Forwarding instances.</CardDescription>
            </div>
            <Button asChild>
              <Link to="/ipam/vrfs/create">Create VRF</Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <ServerDataTable
            table={table}
            data={rows}
            isPending={vrfsQuery.isPending}
            searchPlaceholder="Search VRFs..."
            searchLabel="Search VRFs"
            emptyMessage="No VRFs found"
            onRowClick={(row) => {
              void navigate({
                to: '/ipam/vrfs/$vrfId',
                params: { vrfId: row.id },
              });
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
