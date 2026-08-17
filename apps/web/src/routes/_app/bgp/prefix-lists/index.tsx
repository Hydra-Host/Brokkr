import type { PrefixList } from '@repo/api-client';

import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { ServerDataTable } from '@repo/ui/components/server-data-table';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import type { ServerColumnDef } from '@repo/ui/hooks/use-server-table';
import { useServerTable } from '@repo/ui/hooks/use-server-table';

import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

const columns: ServerColumnDef<PrefixList>[] = [
  {
    id: 'name',
    accessorKey: 'name',
    header: 'Name',
    sortField: 'name',
    size: 200,
    cell: ({ row }) => <span className="text-sm font-medium">{row.original.name}</span>,
  },
  {
    id: 'family',
    accessorKey: 'family',
    header: 'Family',
    size: 100,
    cell: ({ row }) => (
      <span className="text-sm">{row.original.family || <span className="text-muted-foreground">--</span>}</span>
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

export const Route = createFileRoute('/_app/bgp/prefix-lists/')({
  component: PrefixListsPage,
});

function PrefixListsPage() {
  useDocumentTitle('Prefix Lists');
  const navigate = useNavigate();
  const table = useServerTable<PrefixList>({ name: 'prefix-lists', columns });

  const prefixListsQuery = tsr.listPrefixLists.useQuery({
    queryKey: ['prefix-lists'],
    queryData: { query: {} },
  });

  const rows = prefixListsQuery.data?.status === 200 ? prefixListsQuery.data.body : [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Prefix Lists</CardTitle>
              <CardDescription>Manage BGP prefix lists.</CardDescription>
            </div>
            <Button asChild>
              <Link to="/bgp/prefix-lists/create">Create Prefix List</Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <ServerDataTable
            table={table}
            data={rows}
            isPending={prefixListsQuery.isPending}
            searchPlaceholder="Search prefix lists..."
            searchLabel="Search prefix lists"
            emptyMessage="No prefix lists found"
            onRowClick={(row) => {
              void navigate({
                to: '/bgp/prefix-lists/$prefixListId',
                params: { prefixListId: row.id },
              });
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
