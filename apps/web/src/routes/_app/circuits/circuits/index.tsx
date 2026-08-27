import { ServerDataTable } from '@repo/domain-ui/components/server-data-table';
import type { ServerColumnDef } from '@repo/domain-ui/hooks/use-server-table';
import { useServerTable } from '@repo/domain-ui/hooks/use-server-table';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';

import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

interface Circuit {
  id: string;
  cid: string;
  status: 'ACTIVE' | 'PLANNED' | 'OFFLINE' | 'DEPROVISIONING' | 'DECOMMISSIONED';
  installDate: Date | null;
  terminationDate: Date | null;
  providerId: string;
  circuitTypeId: string;
  organizationId: string | null;
  commitRate: number | null;
  description: string | null;
  comments: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const columns: ServerColumnDef<Circuit>[] = [
  {
    id: 'cid',
    accessorKey: 'cid',
    header: 'CID',
    sortField: 'cid',
    size: 200,
    cell: ({ row }) => <span className="text-sm font-medium">{row.original.cid}</span>,
  },
  {
    id: 'status',
    accessorKey: 'status',
    header: 'Status',
    size: 140,
    cell: ({ row }) => <Badge variant="outline">{row.original.status}</Badge>,
  },
  {
    id: 'providerId',
    accessorKey: 'providerId',
    header: 'Provider ID',
    cell: ({ row }) => <span className="font-mono text-sm">{row.original.providerId}</span>,
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

export const Route = createFileRoute('/_app/circuits/circuits/')({
  component: CircuitsPage,
});

function CircuitsPage() {
  useDocumentTitle('Circuits');
  const navigate = useNavigate();
  const table = useServerTable<Circuit>({ name: 'circuits', columns });

  const circuitsQuery = tsr.listCircuits.useQuery({
    queryKey: ['circuits'],
    queryData: { query: {} },
  });

  const rows = circuitsQuery.data?.status === 200 ? circuitsQuery.data.body : [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Circuits</CardTitle>
              <CardDescription>Manage circuits.</CardDescription>
            </div>
            <Button asChild>
              <Link to="/circuits/circuits/create">Create Circuit</Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <ServerDataTable
            table={table}
            data={rows}
            isPending={circuitsQuery.isPending}
            searchPlaceholder="Search circuits..."
            searchLabel="Search circuits"
            emptyMessage="No circuits found"
            onRowClick={(row) => {
              void navigate({
                to: '/circuits/circuits/$circuitId',
                params: { circuitId: row.id },
              });
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
