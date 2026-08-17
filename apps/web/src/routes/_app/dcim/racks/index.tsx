import type { DcimRack } from '@repo/api-client';

import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { ServerDataTable } from '@repo/ui/components/server-data-table';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import type { ServerColumnDef } from '@repo/ui/hooks/use-server-table';
import { useServerTable } from '@repo/ui/hooks/use-server-table';

import { keepPreviousData } from '@tanstack/react-query';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

const columns: ServerColumnDef<DcimRack>[] = [
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
    sortField: 'status',
    size: 120,
    cell: ({ row }) => <Badge variant="outline">{row.original.status}</Badge>,
  },
  {
    id: 'role',
    accessorKey: 'role',
    header: 'Role',
    sortField: 'role',
    size: 150,
    cell: ({ row }) => (
      <span className="text-sm">{row.original.role || <span className="text-muted-foreground">--</span>}</span>
    ),
  },
  {
    id: 'heightU',
    accessorKey: 'heightU',
    header: 'Height (U)',
    sortField: 'heightU',
    size: 100,
    cell: ({ row }) => <span className="text-sm">{row.original.heightU}</span>,
  },
  {
    id: 'serial',
    accessorKey: 'serial',
    header: 'Serial',
    size: 150,
    cell: ({ row }) => (
      <span className="text-sm">{row.original.serial || <span className="text-muted-foreground">--</span>}</span>
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

export const Route = createFileRoute('/_app/dcim/racks/')({
  component: RacksPage,
});

function RacksPage() {
  useDocumentTitle('Racks');
  const navigate = useNavigate();
  const table = useServerTable<DcimRack>({ name: 'racks', columns });

  const query = tsr.listDcimRacks.useQuery({
    queryKey: ['dcim-racks', table.query],
    queryData: { query: table.query },
    placeholderData: keepPreviousData,
  });

  const rows = query.data?.status === 200 ? query.data.body.data : [];
  const meta = query.data?.status === 200 ? query.data.body.meta : undefined;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Racks</CardTitle>
              <CardDescription>Manage racks across your zones.</CardDescription>
            </div>
            <Button asChild>
              <Link to="/dcim/racks/create">Create Rack</Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <ServerDataTable
            table={table}
            data={rows}
            meta={meta}
            isPending={query.isPending}
            isFetching={query.isFetching}
            searchPlaceholder="Search racks..."
            searchLabel="Search racks"
            searchableFields={['Name', 'Description', 'Serial', 'Asset tag']}
            emptyMessage="No racks found"
            onRowClick={(row) => {
              void navigate({
                to: '/dcim/racks/$rackId',
                params: { rackId: row.id },
              });
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
