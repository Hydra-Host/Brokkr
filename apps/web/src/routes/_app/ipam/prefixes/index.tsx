import type { IpamPrefix } from '@repo/api-client';

import { ServerDataTable } from '@repo/domain-ui/components/server-data-table';
import type { ServerColumnDef } from '@repo/domain-ui/hooks/use-server-table';
import { useServerTable } from '@repo/domain-ui/hooks/use-server-table';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';

import { getIpamStatusBadgeVariant } from '@repo/utils';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

const columns: ServerColumnDef<IpamPrefix>[] = [
  {
    id: 'prefix',
    accessorKey: 'prefix',
    header: 'Prefix',
    sortField: 'prefix',
    size: 200,
    cell: ({ row }) => <span className="font-mono text-sm">{row.original.prefix}</span>,
  },
  {
    id: 'status',
    accessorKey: 'status',
    header: 'Status',
    size: 120,
    cell: ({ row }) => <Badge variant={getIpamStatusBadgeVariant(row.original.status)}>{row.original.status}</Badge>,
  },
  {
    id: 'isPool',
    accessorKey: 'isPool',
    header: 'Pool',
    size: 80,
    cell: ({ row }) => (
      <Badge variant={row.original.isPool ? 'default' : 'outline'}>{row.original.isPool ? 'Yes' : 'No'}</Badge>
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

export const Route = createFileRoute('/_app/ipam/prefixes/')({
  staticData: { breadcrumb: 'Prefixes' },
  component: PrefixesPage,
});

function PrefixesPage() {
  useDocumentTitle('Prefixes');
  const navigate = useNavigate();
  const table = useServerTable<IpamPrefix>({ name: 'prefixes', columns });

  const prefixesQuery = tsr.listPrefixes.useQuery({
    queryKey: ['prefixes'],
    queryData: { query: {} },
  });

  const rows = prefixesQuery.data?.status === 200 ? prefixesQuery.data.body : [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Prefixes</CardTitle>
              <CardDescription>Manage IP prefixes.</CardDescription>
            </div>
            <Button asChild>
              <Link to="/ipam/prefixes/create">Create Prefix</Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <ServerDataTable
            table={table}
            data={rows}
            isPending={prefixesQuery.isPending}
            searchPlaceholder="Search prefixes..."
            searchLabel="Search prefixes"
            emptyMessage="No prefixes found"
            onRowClick={(row) => {
              void navigate({
                to: '/ipam/prefixes/$prefixId',
                params: { prefixId: row.id },
              });
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
