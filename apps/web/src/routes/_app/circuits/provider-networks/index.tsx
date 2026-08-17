import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { ServerDataTable } from '@repo/ui/components/server-data-table';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import type { ServerColumnDef } from '@repo/ui/hooks/use-server-table';
import { useServerTable } from '@repo/ui/hooks/use-server-table';

import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

interface ProviderNetwork {
  id: string;
  name: string;
  providerId: string;
  description: string | null;
  comments: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const columns: ServerColumnDef<ProviderNetwork>[] = [
  {
    id: 'name',
    accessorKey: 'name',
    header: 'Name',
    sortField: 'name',
    size: 200,
    cell: ({ row }) => <span className="text-sm font-medium">{row.original.name}</span>,
  },
  {
    id: 'providerId',
    accessorKey: 'providerId',
    header: 'Provider ID',
    cell: ({ row }) => <span className="font-mono text-sm">{row.original.providerId}</span>,
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

export const Route = createFileRoute('/_app/circuits/provider-networks/')({
  component: ProviderNetworksPage,
});

function ProviderNetworksPage() {
  useDocumentTitle('Provider Networks');
  const navigate = useNavigate();
  const table = useServerTable<ProviderNetwork>({ name: 'provider-networks', columns });

  const networksQuery = tsr.listProviderNetworks.useQuery({
    queryKey: ['provider-networks'],
    queryData: { query: {} },
  });

  const rows = networksQuery.data?.status === 200 ? networksQuery.data.body : [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Provider Networks</CardTitle>
              <CardDescription>Manage provider networks.</CardDescription>
            </div>
            <Button asChild>
              <Link to="/circuits/provider-networks/create">Create Provider Network</Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <ServerDataTable
            table={table}
            data={rows}
            isPending={networksQuery.isPending}
            searchPlaceholder="Search provider networks..."
            searchLabel="Search provider networks"
            emptyMessage="No provider networks found"
            onRowClick={(row) => {
              void navigate({
                to: '/circuits/provider-networks/$networkId',
                params: { networkId: row.id },
              });
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
