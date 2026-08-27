import { ServerDataTable } from '@repo/domain-ui/components/server-data-table';
import type { ServerColumnDef } from '@repo/domain-ui/hooks/use-server-table';
import { useServerTable } from '@repo/domain-ui/hooks/use-server-table';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';

import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

interface Provider {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  comments: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const columns: ServerColumnDef<Provider>[] = [
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

export const Route = createFileRoute('/_app/circuits/providers/')({
  component: ProvidersPage,
});

function ProvidersPage() {
  useDocumentTitle('Providers');
  const navigate = useNavigate();
  const table = useServerTable<Provider>({ name: 'providers', columns });

  const providersQuery = tsr.listProviders.useQuery({
    queryKey: ['providers'],
    queryData: { query: {} },
  });

  const rows = providersQuery.data?.status === 200 ? providersQuery.data.body : [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Providers</CardTitle>
              <CardDescription>Manage circuit providers.</CardDescription>
            </div>
            <Button asChild>
              <Link to="/circuits/providers/create">Create Provider</Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <ServerDataTable
            table={table}
            data={rows}
            isPending={providersQuery.isPending}
            searchPlaceholder="Search providers..."
            searchLabel="Search providers"
            emptyMessage="No providers found"
            onRowClick={(row) => {
              void navigate({
                to: '/circuits/providers/$providerId',
                params: { providerId: row.id },
              });
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
