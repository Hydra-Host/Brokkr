import type { DcimInterface } from '@repo/api-client';

import { ServerDataTable } from '@repo/domain-ui/components/server-data-table';
import type { ServerColumnDef } from '@repo/domain-ui/hooks/use-server-table';
import { useServerTable } from '@repo/domain-ui/hooks/use-server-table';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';

import { keepPreviousData } from '@tanstack/react-query';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

const columns: ServerColumnDef<DcimInterface>[] = [
  {
    id: 'name',
    accessorKey: 'name',
    header: 'Name',
    sortField: 'name',
    size: 200,
    cell: ({ row }) => <span className="text-sm font-medium">{row.original.name}</span>,
  },
  {
    id: 'type',
    accessorKey: 'type',
    header: 'Type',
    sortField: 'type',
    size: 150,
    cell: ({ row }) => (
      <span className="text-sm">{row.original.type || <span className="text-muted-foreground">--</span>}</span>
    ),
  },
  {
    id: 'enabled',
    accessorKey: 'enabled',
    header: 'Enabled',
    sortField: 'enabled',
    size: 100,
    cell: ({ row }) => (
      <Badge variant={row.original.enabled ? 'default' : 'secondary'}>{row.original.enabled ? 'Yes' : 'No'}</Badge>
    ),
  },
  {
    id: 'speed',
    accessorKey: 'speed',
    header: 'Speed',
    sortField: 'speed',
    size: 120,
    cell: ({ row }) => (
      <span className="text-sm">{row.original.speed ?? <span className="text-muted-foreground">--</span>}</span>
    ),
  },
  {
    id: 'macAddress',
    accessorKey: 'macAddress',
    header: 'MAC Address',
    size: 160,
    cell: ({ row }) => (
      <span className="font-mono text-sm">
        {row.original.macAddress || <span className="text-muted-foreground font-sans">--</span>}
      </span>
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

export const Route = createFileRoute('/_app/dcim/interfaces/')({
  component: InterfacesPage,
});

function InterfacesPage() {
  useDocumentTitle('Interfaces');
  const navigate = useNavigate();
  const table = useServerTable<DcimInterface>({ name: 'interfaces', columns });

  const query = tsr.listDcimInterfaces.useQuery({
    queryKey: ['dcim-interfaces', table.query],
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
              <CardTitle>Interfaces</CardTitle>
              <CardDescription>Manage network interfaces for devices.</CardDescription>
            </div>
            <Button asChild>
              <Link to="/dcim/interfaces/create">Create Interface</Link>
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
            searchPlaceholder="Search interfaces..."
            searchLabel="Search interfaces"
            searchableFields={['Name', 'MAC address', 'Description', 'GUID', 'LLDP neighbor']}
            emptyMessage="No interfaces found"
            onRowClick={(row) => {
              void navigate({
                to: '/dcim/interfaces/$interfaceId',
                params: { interfaceId: row.id },
              });
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
