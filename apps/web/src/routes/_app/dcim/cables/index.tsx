import type { DcimCable } from '@repo/api-client';

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

const columns: ServerColumnDef<DcimCable>[] = [
  {
    id: 'label',
    accessorKey: 'label',
    header: 'Label',
    sortField: 'label',
    size: 200,
    cell: ({ row }) => (
      <span className="text-sm font-medium">
        {row.original.label || <span className="text-muted-foreground">--</span>}
      </span>
    ),
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
    id: 'status',
    accessorKey: 'status',
    header: 'Status',
    sortField: 'status',
    size: 120,
    cell: ({ row }) => <Badge variant="outline">{row.original.status}</Badge>,
  },
  {
    id: 'color',
    accessorKey: 'color',
    header: 'Color',
    size: 100,
    cell: ({ row }) =>
      row.original.color ? (
        <div className="flex items-center gap-2">
          <span className="inline-block h-3 w-3 rounded-full border" style={{ backgroundColor: row.original.color }} />
          <span className="font-mono text-xs">{row.original.color}</span>
        </div>
      ) : (
        <span className="text-muted-foreground text-sm">--</span>
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

export const Route = createFileRoute('/_app/dcim/cables/')({
  component: CablesPage,
});

function CablesPage() {
  useDocumentTitle('Cables');
  const navigate = useNavigate();
  const table = useServerTable<DcimCable>({ name: 'cables', columns });

  const query = tsr.listDcimCables.useQuery({
    queryKey: ['dcim-cables', table.query],
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
              <CardTitle>Cables</CardTitle>
              <CardDescription>Manage cable connections between devices.</CardDescription>
            </div>
            <Button asChild>
              <Link to="/dcim/cables/create">Create Cable</Link>
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
            searchPlaceholder="Search cables..."
            searchLabel="Search cables"
            searchableFields={['Label', 'Description']}
            emptyMessage="No cables found"
            onRowClick={(row) => {
              void navigate({
                to: '/dcim/cables/$cableId',
                params: { cableId: row.id },
              });
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
