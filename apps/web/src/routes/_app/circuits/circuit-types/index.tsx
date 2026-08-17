import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { ServerDataTable } from '@repo/ui/components/server-data-table';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import type { ServerColumnDef } from '@repo/ui/hooks/use-server-table';
import { useServerTable } from '@repo/ui/hooks/use-server-table';

import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

interface CircuitType {
  id: string;
  name: string;
  slug: string;
  color: string | null;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const columns: ServerColumnDef<CircuitType>[] = [
  {
    id: 'name',
    accessorKey: 'name',
    header: 'Name',
    sortField: 'name',
    size: 200,
    cell: ({ row }) => <span className="text-sm font-medium">{row.original.name}</span>,
  },
  {
    id: 'slug',
    accessorKey: 'slug',
    header: 'Slug',
    cell: ({ row }) => <span className="text-sm">{row.original.slug}</span>,
  },
  {
    id: 'color',
    accessorKey: 'color',
    header: 'Color',
    size: 100,
    cell: ({ row }) => (
      <div className="flex items-center gap-2">
        {row.original.color ? (
          <>
            <span
              className="inline-block h-3 w-3 rounded-full border"
              style={{ backgroundColor: row.original.color }}
            />
            <span className="font-mono text-xs">{row.original.color}</span>
          </>
        ) : (
          <span className="text-muted-foreground text-sm">--</span>
        )}
      </div>
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

export const Route = createFileRoute('/_app/circuits/circuit-types/')({
  component: CircuitTypesPage,
});

function CircuitTypesPage() {
  useDocumentTitle('Circuit Types');
  const navigate = useNavigate();
  const table = useServerTable<CircuitType>({ name: 'circuit-types', columns });

  const circuitTypesQuery = tsr.listCircuitTypes.useQuery({
    queryKey: ['circuit-types'],
    queryData: { query: {} },
  });

  const rows = circuitTypesQuery.data?.status === 200 ? circuitTypesQuery.data.body : [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Circuit Types</CardTitle>
              <CardDescription>Manage circuit types.</CardDescription>
            </div>
            <Button asChild>
              <Link to="/circuits/circuit-types/create">Create Circuit Type</Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <ServerDataTable
            table={table}
            data={rows}
            isPending={circuitTypesQuery.isPending}
            searchPlaceholder="Search circuit types..."
            searchLabel="Search circuit types"
            emptyMessage="No circuit types found"
            onRowClick={(row) => {
              void navigate({
                to: '/circuits/circuit-types/$typeId',
                params: { typeId: row.id },
              });
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
