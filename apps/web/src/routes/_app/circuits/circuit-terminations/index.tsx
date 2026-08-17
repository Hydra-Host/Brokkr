import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { ServerDataTable } from '@repo/ui/components/server-data-table';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import type { ServerColumnDef } from '@repo/ui/hooks/use-server-table';
import { useServerTable } from '@repo/ui/hooks/use-server-table';

import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

interface CircuitTermination {
  id: string;
  termSide: 'A' | 'Z';
  circuitId: string;
  portSpeed: number | null;
  upstreamSpeed: number | null;
  xconnectId: string | null;
  description: string | null;
  zoneId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const columns: ServerColumnDef<CircuitTermination>[] = [
  {
    id: 'termSide',
    accessorKey: 'termSide',
    header: 'Term Side',
    size: 100,
    cell: ({ row }) => <span className="text-sm font-medium">{row.original.termSide}</span>,
  },
  {
    id: 'circuitId',
    accessorKey: 'circuitId',
    header: 'Circuit ID',
    cell: ({ row }) => <span className="font-mono text-sm">{row.original.circuitId}</span>,
  },
  {
    id: 'portSpeed',
    accessorKey: 'portSpeed',
    header: 'Port Speed',
    cell: ({ row }) => (
      <span className="text-sm">
        {row.original.portSpeed != null ? row.original.portSpeed : <span className="text-muted-foreground">--</span>}
      </span>
    ),
  },
  {
    id: 'upstreamSpeed',
    accessorKey: 'upstreamSpeed',
    header: 'Upstream Speed',
    cell: ({ row }) => (
      <span className="text-sm">
        {row.original.upstreamSpeed != null ? (
          row.original.upstreamSpeed
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

export const Route = createFileRoute('/_app/circuits/circuit-terminations/')({
  component: CircuitTerminationsPage,
});

function CircuitTerminationsPage() {
  useDocumentTitle('Circuit Terminations');
  const navigate = useNavigate();
  const table = useServerTable<CircuitTermination>({ name: 'circuit-terminations', columns });

  const terminationsQuery = tsr.listCircuitTerminations.useQuery({
    queryKey: ['circuit-terminations'],
    queryData: { query: {} },
  });

  const rows = terminationsQuery.data?.status === 200 ? terminationsQuery.data.body : [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Circuit Terminations</CardTitle>
              <CardDescription>Manage circuit terminations.</CardDescription>
            </div>
            <Button asChild>
              <Link to="/circuits/circuit-terminations/create">Create Termination</Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <ServerDataTable
            table={table}
            data={rows}
            isPending={terminationsQuery.isPending}
            searchPlaceholder="Search circuit terminations..."
            searchLabel="Search circuit terminations"
            emptyMessage="No circuit terminations found"
            onRowClick={(row) => {
              void navigate({
                to: '/circuits/circuit-terminations/$terminationId',
                params: { terminationId: row.id },
              });
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
