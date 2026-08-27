import type { DcimPowerPort } from '@repo/api-client';

import { ServerDataTable } from '@repo/domain-ui/components/server-data-table';
import type { ServerColumnDef } from '@repo/domain-ui/hooks/use-server-table';
import { useServerTable } from '@repo/domain-ui/hooks/use-server-table';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';

import { keepPreviousData } from '@tanstack/react-query';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

const columns: ServerColumnDef<DcimPowerPort>[] = [
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
    id: 'maximumDraw',
    accessorKey: 'maximumDraw',
    header: 'Max Draw',
    sortField: 'maximumDraw',
    size: 120,
    cell: ({ row }) => (
      <span className="text-sm">{row.original.maximumDraw ?? <span className="text-muted-foreground">--</span>}</span>
    ),
  },
  {
    id: 'allocatedDraw',
    accessorKey: 'allocatedDraw',
    header: 'Allocated Draw',
    sortField: 'allocatedDraw',
    size: 130,
    cell: ({ row }) => (
      <span className="text-sm">{row.original.allocatedDraw ?? <span className="text-muted-foreground">--</span>}</span>
    ),
  },
  {
    id: 'deviceId',
    accessorKey: 'deviceId',
    header: 'Device ID',
    size: 200,
    cell: ({ row }) => <span className="font-mono text-sm">{row.original.deviceId}</span>,
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

export const Route = createFileRoute('/_app/dcim/power-ports/')({
  component: PowerPortsPage,
});

function PowerPortsPage() {
  useDocumentTitle('Power Ports');
  const navigate = useNavigate();
  const table = useServerTable<DcimPowerPort>({ name: 'power-ports', columns });

  const query = tsr.listDcimPowerPorts.useQuery({
    queryKey: ['dcim-power-ports', table.query],
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
              <CardTitle>Power Ports</CardTitle>
              <CardDescription>Manage power ports on devices.</CardDescription>
            </div>
            <Button asChild>
              <Link to="/dcim/power-ports/create">Create Power Port</Link>
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
            searchPlaceholder="Search power ports..."
            searchLabel="Search power ports"
            searchableFields={['Name', 'Description']}
            emptyMessage="No power ports found"
            onRowClick={(row) => {
              void navigate({
                to: '/dcim/power-ports/$portId',
                params: { portId: row.id },
              });
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
