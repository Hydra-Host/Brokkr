import type { DcimPowerOutlet } from '@repo/api-client';

import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { ServerDataTable } from '@repo/ui/components/server-data-table';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import type { ServerColumnDef } from '@repo/ui/hooks/use-server-table';
import { useServerTable } from '@repo/ui/hooks/use-server-table';

import { keepPreviousData } from '@tanstack/react-query';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

const columns: ServerColumnDef<DcimPowerOutlet>[] = [
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
    id: 'feedLegPhase',
    accessorKey: 'feedLegPhase',
    header: 'Feed Leg Phase',
    sortField: 'feedLegPhase',
    size: 130,
    cell: ({ row }) => (
      <span className="text-sm">{row.original.feedLegPhase || <span className="text-muted-foreground">--</span>}</span>
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

export const Route = createFileRoute('/_app/dcim/power-outlets/')({
  component: PowerOutletsPage,
});

function PowerOutletsPage() {
  useDocumentTitle('Power Outlets');
  const navigate = useNavigate();
  const table = useServerTable<DcimPowerOutlet>({ name: 'power-outlets', columns });

  const query = tsr.listDcimPowerOutlets.useQuery({
    queryKey: ['dcim-power-outlets', table.query],
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
              <CardTitle>Power Outlets</CardTitle>
              <CardDescription>Manage power outlets on devices.</CardDescription>
            </div>
            <Button asChild>
              <Link to="/dcim/power-outlets/create">Create Power Outlet</Link>
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
            searchPlaceholder="Search power outlets..."
            searchLabel="Search power outlets"
            searchableFields={['Name', 'Description']}
            emptyMessage="No power outlets found"
            onRowClick={(row) => {
              void navigate({
                to: '/dcim/power-outlets/$outletId',
                params: { outletId: row.id },
              });
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
