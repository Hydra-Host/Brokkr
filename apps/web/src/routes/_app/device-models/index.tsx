import type { DeviceModel } from '@repo/api-client';

import { ServerDataTable } from '@repo/domain-ui/components/server-data-table';
import type { ServerColumnDef } from '@repo/domain-ui/hooks/use-server-table';
import { useServerTable } from '@repo/domain-ui/hooks/use-server-table';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';

import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

const columns: ServerColumnDef<DeviceModel>[] = [
  {
    id: 'manufacturer',
    accessorKey: 'manufacturer',
    header: 'Manufacturer',
    sortField: 'manufacturer',
    size: 160,
    cell: ({ row }) => <span className="text-sm font-medium">{row.original.manufacturer}</span>,
  },
  {
    id: 'model',
    accessorKey: 'model',
    header: 'Model',
    sortField: 'model',
    size: 200,
    cell: ({ row }) => <span className="text-sm">{row.original.model}</span>,
  },
  {
    id: 'formFactor',
    accessorKey: 'formFactor',
    header: 'Form Factor',
    size: 100,
    cell: ({ row }) => (
      <span className="text-sm">{row.original.formFactor || <span className="text-muted-foreground">--</span>}</span>
    ),
  },
  {
    id: 'heightU',
    header: 'Height (U)',
    size: 90,
    cell: ({ row }) => (
      <span className="text-sm">
        {row.original.heightU != null ? `${row.original.heightU}U` : <span className="text-muted-foreground">--</span>}
      </span>
    ),
  },
  {
    id: 'maxPowerW',
    header: 'Max Power',
    size: 100,
    cell: ({ row }) => (
      <span className="text-sm">
        {row.original.maxPowerW != null ? (
          `${row.original.maxPowerW}W`
        ) : (
          <span className="text-muted-foreground">--</span>
        )}
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

export const Route = createFileRoute('/_app/device-models/')({
  staticData: { breadcrumb: 'Device Models' },
  component: DeviceModelsPage,
});

function DeviceModelsPage() {
  useDocumentTitle('Device Models');
  const navigate = useNavigate();
  const table = useServerTable<DeviceModel>({ name: 'device-models', columns });

  const query = tsr.listDeviceModels.useQuery({
    queryKey: ['device-models'],
    queryData: { query: {} },
  });

  const rows = query.data?.status === 200 ? query.data.body : [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Device Models</CardTitle>
              <CardDescription>Hardware device model definitions.</CardDescription>
            </div>
            <Button asChild>
              <Link to="/device-models/create">Create Device Model</Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <ServerDataTable
            table={table}
            data={rows}
            isPending={query.isPending}
            searchPlaceholder="Search device models..."
            searchLabel="Search device models"
            emptyMessage="No device models found"
            onRowClick={(row) => {
              void navigate({ to: '/device-models/$modelId', params: { modelId: row.id } });
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
